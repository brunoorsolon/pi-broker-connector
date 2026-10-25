import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, chmodSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readConfig } from '../src/config.mjs';
import { PiBrokerSession } from '../src/session.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'pi-broker-config-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = join(root, 'connection.json');
  const bundle = { format: 'broker-client-bundle-v1', protocol_version:'1', file_paths_relative_to:'connection_file_directory', authorization_header:'Authorization', authorization_scheme:'Bearer', insecure_development:false, broker_url: 'https://broker.example', token_file: 'token', allowed_client_types: ['pi'] };
  const write = (value = bundle) => writeFileSync(file, JSON.stringify(value), { mode: 0o600 });
  write();
  return { root, file, bundle, write, env: { PSST_CONFIG_FILE: file, PSST_STATE_DIR: join(root, 'state') } };
}
test('disabled without config; bundle path is relative to private config; alias supported', t => {
  assert.equal(readConfig({}), null);
  const f = fixture(t), c = readConfig(f.env);
  assert.equal(c.tokenFile, join(f.root, 'token')); assert.equal(c.url, 'https://broker.example/');
  assert.equal(readConfig({ PSST_CONFIG: f.file }).name, 'Pi');
});
test('rejects public/symlink config, wrong type, insecure endpoint and embedded auth', t => {
  const f = fixture(t);
  for (const broker_url of ['http://broker.example', 'https://x:y@broker.example', 'https://broker.example/path', 'https://broker.example/?token=hidden']) {
    f.write({ ...f.bundle, broker_url }); assert.throws(() => readConfig(f.env));
  }
  f.write({ ...f.bundle, allowed_client_types: ['opencode'] }); assert.throws(() => readConfig(f.env));
  f.write(); chmodSync(f.file, 0o644); assert.throws(() => readConfig(f.env)); chmodSync(f.file, 0o600);
  symlinkSync(f.file, join(f.root, 'link')); assert.throws(() => readConfig({ ...f.env, PSST_CONFIG_FILE: join(f.root, 'link') }));
});
test('same native session reconnects durable identity, other session isolated; duplicate ownership refused', async t => {
  const f = fixture(t), config = readConfig(f.env); let sessionId = 'native-A';
  const make = () => new PiBrokerSession({ config, hostSessionId: sessionId, currentSessionId: () => sessionId });
  const a = make(); const id = a.inbox.identity.client_id;
  assert.throws(make, error => error.code === 'owner_conflict');
  await a.close(); await a.close();
  const resumed = make(); assert.equal(resumed.inbox.identity.client_id, id); await resumed.close();
  sessionId = 'native-B'; const b = make(); assert.notEqual(b.inbox.identity.client_id, id);
  sessionId = 'native-C'; assert.equal(b.isAlive(), false); await assert.rejects(b.run(() => null), error => error.code === 'session_mismatch'); await b.close();
});
test('bundle protocol/auth/path policy mismatch is rejected; optional CA resolved explicitly', t => {
 const f=fixture(t);
 for(const change of [{protocol_version:'2'},{authorization_scheme:'Basic'},{authorization_header:'X-Token'},{insecure_development:true},{file_paths_relative_to:'cwd'},{token_file:'../secret'},{token_file:'.'},{ca_file:1}]) {
  f.write({...f.bundle,...change});assert.throws(()=>readConfig(f.env));
 }
 f.write({...f.bundle,ca_file:'ca.pem'});assert.equal(readConfig(f.env).caFile,join(f.root,'ca.pem'));
});
