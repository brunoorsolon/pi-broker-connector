import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { nativeSessionMetadata, metadataSummary } from '../src/session-metadata.mjs';
import { PiBrokerSession } from '../src/session.mjs';
import { installExtension } from '../src/extension.mjs';
import { validateMetadata } from '../vendor/broker/src/protocol.mjs';
import { httpFixture } from './fixtures/broker/test/helpers.mjs';

const model = { provider: 'fixture-provider', id: 'fixture-model' };
function nativeContext(id, name = 'Review', cwd = '/private/parent/project', selected = model) {
  const ctx = { name, cwd, model: selected, hasUI: false };
  ctx.sessionManager = { getSessionId: () => id, getSessionName: () => ctx.name };
  return ctx;
}

test('native metadata observes supported APIs, stable labels, project basename and selected model only', () => {
  const ctx = nativeContext('session-a');
  const identity = { clientId: '12345678-0000-4000-8000-000000000000' };
  const metadata = nativeSessionMetadata({}, ctx, identity);
  assert.deepEqual(metadata, { name: 'Review [12345678]', project: 'project',
    model: { ...model, source: 'observed' } });
  assert.deepEqual(validateMetadata(metadata), metadata);
  assert.equal(metadataSummary(metadata), 'Review [12345678]; project project; model fixture-provider/fixture-model');
  assert.ok(!JSON.stringify(metadata).includes('/private/parent'));
  assert.notEqual(nativeSessionMetadata({}, ctx, { clientId: '87654321-0000-4000-8000-000000000000' }).name, metadata.name);
  ctx.name = 'Renamed'; ctx.model = { provider: 'other-provider', id: 'other-model' };
  assert.equal(nativeSessionMetadata({}, ctx, identity).name, 'Renamed [12345678]');
  assert.deepEqual(nativeSessionMetadata({}, ctx, identity).model, { ...ctx.model, source: 'observed' });
  assert.equal(nativeSessionMetadata({}, ctx, { ...identity, nameOverride: 'Operator label' }).name, 'Operator label [12345678]');
  assert.deepEqual(ctx.model, { provider: 'other-provider', id: 'other-model' }, 'observation must not alter the native model');
});

test('unnamed/unavailable host metadata is truthful, bounded and terminal-safe', () => {
  const ctx = nativeContext('session-fallback', undefined, undefined, undefined);
  delete ctx.name; delete ctx.cwd; delete ctx.model;
  const first = nativeSessionMetadata({}, ctx);
  assert.match(first.name, /^Pi \[[a-f0-9]{8}\]$/);
  assert.equal(first.name, nativeSessionMetadata({}, ctx).name);
  assert.deepEqual(first.model, { provider: null, id: null, source: 'unknown' });
  assert.equal(first.project, null);
  assert.equal(nativeSessionMetadata({ getSessionName: () => 'API name' }, ctx).name.split(' [')[0], 'API name');
  ctx.name = '\u001b[31m\u202e' + '😀'.repeat(150); ctx.cwd = 'C:\\private\\project';
  ctx.model = { provider: 'x\nprovider', id: 'm\u009bodel' };
  const safe = nativeSessionMetadata({}, ctx);
  assert.equal(safe.project, 'project');
  assert.equal([...safe.name].length, 128);
  assert.doesNotMatch(JSON.stringify(safe), /\u001b|\u202e|\u009b/);
  assert.doesNotThrow(() => validateMetadata(safe));
  assert.equal(nativeSessionMetadata({}, { ...ctx, cwd: '/' }).project, null);
  assert.equal(nativeSessionMetadata({}, { ...ctx, model: { provider: 'only-provider' } }).model.source, 'unknown');
  const broken = { get cwd() { throw Error('host unavailable'); }, get model() { throw Error('host unavailable'); }, sessionManager: {} };
  assert.doesNotThrow(() => validateMetadata(nativeSessionMetadata({}, broken)));
});

async function sessions(t, ids = ['native-A']) {
  const f = await httpFixture(t);
  const tokenFile = join(f.dir, 'metadata-token'); writeFileSync(tokenFile, f.a.token, { mode: 0o600 });
  const config = { url: f.base, tokenFile, stateDirectory: join(f.dir, 'metadata-clients'), name: 'Pi' };
  const make = ctx => new PiBrokerSession({ config, hostSessionId: ctx.sessionManager.getSessionId(),
    currentSessionId: () => ctx.sessionManager.getSessionId(),
    observeMetadata: identity => nativeSessionMetadata({}, ctx, { clientId: identity.client_id }),
    clientOptions: { insecureDevelopment: true, now: () => f.now, maxAttempts: 1 } });
  const clients = ids.map(id => { const ctx = nativeContext(id); const session = make(ctx); t.after(() => session.close()); return { ctx, session }; });
  for (const { session } of clients) await session.start();
  return { f, config, make, clients };
}

test('real broker discovery distinguishes same-name sessions/projects and keeps identity across rename, model switch and resume', async t => {
  const { clients: [{ ctx, session: a }, { ctx: bctx, session: b }, { ctx: cctx, session: c }], make } = await sessions(t, ['native-A', 'native-B', 'native-C']);
  cctx.cwd = '/different/private/another-project'; await c.refreshMetadata();
  const listed = (await a.client.listClients()).clients;
  assert.equal(listed.length, 3);
  assert.equal(new Set(listed.map(row => row.name)).size, 3);
  assert.equal(new Set(listed.map(row => row.client_id)).size, 3);
  assert.deepEqual(listed.map(row => row.project).sort(), ['another-project', 'project', 'project']);
  assert.ok(listed.every(row => row.model.provider === model.provider && row.model.id === model.id));
  const identity = { ...a.inbox.identity }, directory = a.directory;
  ctx.name = 'Renamed review'; ctx.model = { provider: 'other-provider', id: 'other-model' };
  await a.refreshMetadata();
  const renamed = (await b.client.listClients()).clients.find(row => row.client_id === identity.client_id);
  assert.equal(renamed.name, a.metadata.name); assert.deepEqual(renamed.model, a.metadata.model);
  assert.deepEqual(a.inbox.identity, identity); assert.equal(a.directory, directory); assert.equal(a.metadataSync, 'synced');
  await a.close();
  const resumed = make(ctx); t.after(() => resumed.close()); await resumed.start();
  assert.deepEqual(resumed.inbox.identity, identity); assert.equal(resumed.directory, directory);
  assert.deepEqual(resumed.metadata, a.metadata);
  assert.equal((await b.client.listClients()).clients.length, 3);
  assert.equal(bctx.name, 'Review');
});

test('lost metadata PATCH reply reconciles owned revision before retry, without identity rotation or duplicate revision', async t => {
  const { clients: [{ ctx, session }] } = await sessions(t);
  const request = session.client.request.bind(session.client), refresh = session.client.refreshOwnedMetadata.bind(session.client);
  const identity = { ...session.inbox.identity };
  let patches = 0, reads = 0;
  session.client.request = async (method, ...args) => {
    const result = await request(method, ...args);
    if (method === 'PATCH') { patches++; throw Error('synthetic lost response'); }
    return result;
  };
  session.client.refreshOwnedMetadata = async (...args) => { reads++; return refresh(...args); };
  ctx.name = 'After rename';
  await assert.rejects(session.refreshMetadata(), /synthetic lost response/);
  assert.equal(session.metadataSync, 'pending');
  const oldRevision = session.client.attachment.metadata_revision;
  await session.refreshMetadata();
  assert.equal(reads, 1); assert.equal(patches, 1);
  assert.equal(session.client.attachment.metadata_revision, oldRevision + 1);
  assert.equal(session.metadataSync, 'synced'); assert.deepEqual(session.inbox.identity, identity);
  assert.equal((await session.client.listClients()).clients[0].name, session.metadata.name);
});

test('concurrent native rename/model events serialize updates and publish the latest observation', async t => {
  const { clients: [{ ctx, session }] } = await sessions(t);
  const update = session.client.updateMetadata.bind(session.client);
  let release, began;
  const started = new Promise(resolve => began = resolve);
  let calls = 0, active = 0, peak = 0;
  session.client.updateMetadata = async (...args) => {
    calls++; active++; peak = Math.max(active, peak);
    try { if (calls === 1) { began(); await new Promise(resolve => release = resolve); } return await update(...args); }
    finally { active--; }
  };
  ctx.name = 'First rename'; const one = session.refreshMetadata(); await started;
  ctx.name = 'Latest rename'; ctx.model = { provider: 'new-provider', id: 'new-model' };
  const two = session.refreshMetadata(); release(); await Promise.all([one, two]);
  assert.equal(calls, 2); assert.equal(peak, 1);
  const row = (await session.client.listClients()).clients[0];
  assert.equal(row.name, session.metadata.name); assert.deepEqual(row.model, { ...ctx.model, source: 'observed' });
});

test('shutdown aborts an in-flight metadata request and drains it before closing durable storage', async t => {
  const { clients: [{ ctx, session }] } = await sessions(t);
  let began, aborted = false;
  const started = new Promise(resolve => began = resolve);
  session.client.updateMetadata = async (_metadata, { signal }) => {
    began();
    await new Promise((_resolve, reject) => signal.addEventListener('abort', () => {
      aborted = true; reject(Error('metadata aborted'));
    }, { once: true }));
  };
  ctx.name = 'In-flight rename';
  const updating = assert.rejects(session.refreshMetadata(), /metadata aborted/);
  await started; await session.close(); await updating;
  assert.equal(aborted, true); assert.equal(session.inbox.closed, true);
  assert.equal(await session.refreshMetadata(), false);
});

test('extension refreshes native events, status and identity consistently; metadata errors do not break transport tools', async t => {
  const f = await httpFixture(t), ctx = nativeContext('native-extension');
  const tokenFile = join(f.dir, 'extension-token'); writeFileSync(tokenFile, f.a.token, { mode: 0o600 });
  const config = { url: f.base, tokenFile, stateDirectory: join(f.dir, 'extension-clients'), name: 'Pi' };
  const commands = {}, events = {}, tools = {}, notices = [];
  ctx.hasUI = true; ctx.ui = { setStatus() {}, notify: text => notices.push(text) };
  const Type = { Object: () => ({}), String: () => ({}), Optional: () => ({}), Integer: () => ({}) };
  let session;
  installExtension({ on: (name, fn) => events[name] = fn, registerCommand: (name, value) => commands[name] = value, registerTool: tool => tools[tool.name] = tool }, Type, {
    env: {}, pathStore: { read: () => '/fixture/connection.json' }, configReader: () => config,
    createSession: options => (session = new PiBrokerSession({ ...options, clientOptions: { insecureDevelopment: true, now: () => f.now, maxAttempts: 1 } })),
  });
  t.after(() => events.session_shutdown());
  const call = name => tools[name].execute('metadata-fixture', {}, undefined, undefined, ctx);
  await events.session_start({}, ctx);
  const initial = (await call('broker_identity')).details;
  assert.equal(initial.metadata.model.source, 'observed');
  ctx.name = 'Native rename'; await events.session_info_changed({ name: ctx.name }, ctx);
  ctx.model = { provider: 'selected-provider', id: 'selected-model' }; await events.model_select({ model: ctx.model }, ctx);
  const identity = (await call('broker_identity')).details, row = (await call('broker_list_clients')).details.clients[0];
  assert.equal(identity.client_id, initial.client_id);
  assert.equal(row.name, identity.metadata.name); assert.deepEqual(row.model, identity.metadata.model); assert.equal(row.project, identity.metadata.project);
  await commands['psst-status'].handler('', ctx);
  assert.ok(notices.some(text => text.includes(metadataSummary(identity.metadata))));
  session.client.updateMetadata = async () => { throw Error('private credentials must never appear in diagnostics'); };
  ctx.name = 'Unpublished rename'; await events.session_info_changed({ name: ctx.name }, ctx);
  const pending = await call('broker_identity');
  assert.equal(pending.isError, undefined); assert.equal(pending.details.metadata_sync, 'pending');
  assert.equal((await call('broker_list_clients')).details.clients.length, 1);
  assert.ok(!notices.some(text => text.includes('private credentials')));
});
