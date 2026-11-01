import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync, readFileSync, readdirSync, chmodSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { supportedNode, runtimeDescription, installUnsupportedRuntime, CONNECTOR_VERSION } from '../src/runtime-support.mjs';
import { setupDiagnostic, diagnosticText, inspectPsstStorage, doctorText } from '../src/setup-diagnostics.mjs';

test('runtime gate preserves the engine range and reports unsupported hosts without loading runtime', async () => {
  for (const version of ['24.19.0', '24.22.2', '24.99.0']) assert.equal(supportedNode(version), true);
  for (const version of ['22.22.2', '24.18.9', '25.0.0', 'v24.19.0', 'SECRET\n']) assert.equal(supportedNode(version), false);
  assert.equal(CONNECTOR_VERSION, JSON.parse(readFileSync(new URL('../package.json', import.meta.url))).version);
  const commands={},events={},notices=[];
  installUnsupportedRuntime({registerCommand:(name,c)=>commands[name]=c,on:(name,fn)=>events[name]=fn},'22.22.2');
  await commands['psst-setup'].handler('',{hasUI:true,ui:{notify:text=>notices.push(text)}});
  assert.match(notices[0],/22\.22\.2.*>=24\.19\.0 <25/);
  assert.match(notices[0],/No enrollment or storage changes/);
  assert.ok(commands['psst-doctor']);assert.ok(events.session_start);
  assert.equal(runtimeDescription('SECRET\n').includes('SECRET'),false);
  const entry=readFileSync(new URL('../extensions/psst.ts',import.meta.url),'utf8');
  assert.ok(entry.indexOf('if (!supportedNode())') < entry.indexOf("await import('../src/extension.mjs')"));
  assert.equal(entry.includes("import { installExtension } from"),false);
});

test('diagnostics allowlist error/phase/state without leaking raw exceptions or private paths', () => {
  const secret='do-not-leak-private-file-or-token';
  const d=setupDiagnostic({code:secret,message:secret,path:secret},secret,secret);
  assert.deepEqual(d,{code:'setup_failed',phase:'setup',requestState:'outcome_unknown'});
  assert.equal(diagnosticText(d).includes(secret),false);
  assert.match(diagnosticText(setupDiagnostic({code:'broker_origin_mismatch'},'url_validation')),/HTTPS broker origin/);
  assert.match(diagnosticText(setupDiagnostic({code:'owner_conflict'},'approved_attachment','approved')),/do not delete/);
});

function fixture(t){const home=mkdtempSync(join(tmpdir(),'pi-doctor-'));t.after(()=>rmSync(home,{recursive:true,force:true}));return {home,agent:join(home,'agent')};}
test('doctor is read-only even on fresh missing storage and never prints paths',t=>{
  const {home,agent}=fixture(t);const before=readdirSync(home);
  const checks=inspectPsstStorage({PI_CODING_AGENT_DIR:agent},home);
  assert.deepEqual(readdirSync(home),before);
  assert.ok(checks.every(c=>c.code==='missing'));
  assert.equal(doctorText(checks).includes(home),false);
});
test('doctor identifies unsafe state symlink ancestors without following private-file contents',t=>{
  const {home,agent}=fixture(t),real=join(home,'actual');mkdirSync(real,{mode:0o700});symlinkSync(real,agent);
  const checks=inspectPsstStorage({PI_CODING_AGENT_DIR:agent},home);
  assert.equal(checks.find(c=>c.target==='selection_directory').code,'path_symlink');
  assert.deepEqual(readdirSync(real),[]);
  assert.equal(doctorText(checks).includes(real),false);
});
test('doctor reports mode and type defects without chmod, database opens or secret output',t=>{
  const {home,agent}=fixture(t),root=join(agent,'psst');mkdirSync(root,{recursive:true,mode:0o700});
  const file=join(root,'selection.sqlite');writeFileSync(file,'not-a-database-secret',{mode:0o600});chmodSync(root,0o755);
  const checks=inspectPsstStorage({PI_CODING_AGENT_DIR:agent},home);
  assert.equal(checks.find(c=>c.target==='selection_directory').code,'private_mode_required');
  assert.equal(checks.find(c=>c.target==='selection_file').code,'ok');
  assert.equal(statSync(root).mode&0o777,0o755);
  assert.equal(readFileSync(file,'utf8'),'not-a-database-secret');
  assert.equal(doctorText(checks).includes('not-a-database-secret'),false);
});
