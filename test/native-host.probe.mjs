// Real official Pi loader/package-resolution gate; no model account or API is used.
import test from 'node:test';
import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { mkdtempSync, rmSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const host = process.env.PI_TEST_INSTALL;
if (!host) throw Error('Set PI_TEST_INSTALL to an isolated install containing official Pi 1.4.0');
const base=join(host,'node_modules/@earendil-works/pi-coding-agent');
const pkg=JSON.parse(readFileSync(join(base,'package.json'),'utf8'));
assert.equal(pkg.version,'1.4.0');
const root=mkdtempSync(join(tmpdir(),'pi-broker-native-'));
process.env.PI_CODING_AGENT_DIR=join(root,'agent'); process.env.HOME=root; process.env.PI_OFFLINE='1';
delete process.env.PSST_CONFIG_FILE; delete process.env.PSST_CONFIG;
const {loadExtensions}=await import(pathToFileURL(join(base,'dist/core/extensions/loader.js')).href);

test('official Pi 1.4.0 discovers/loads packed extension and its six native tools without credentials',async t=>{
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  const packed=spawnSync('npm',['pack','--ignore-scripts','--json','--pack-destination',root],{cwd:process.cwd(),env:process.env,encoding:'utf8',timeout:30000});
  assert.equal(packed.status,0,packed.stderr);
  const manifest=JSON.parse(packed.stdout)[0];
  assert.equal(manifest.name, '@matuto-ai/pi-broker-connector');
  const packageVersion = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')).version;
  assert.equal(manifest.version, packageVersion);
  assert.equal(manifest.filename, `matuto-ai-pi-broker-connector-${packageVersion}.tgz`);
  assert.ok(!manifest.files.some(f=>f.path.startsWith('test/')||f.path.includes('node_modules')||f.path==='token'));
  const unpack=join(root,'unpack'); mkdirSync(unpack);
  const extracted=spawnSync('tar',['-xzf',join(root,manifest.filename),'-C',unpack],{encoding:'utf8'});
  assert.equal(extracted.status,0,extracted.stderr);
  const packageRoot=join(unpack,'package');
  assert.equal(JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')).name, '@matuto-ai/pi-broker-connector');
  const loaded=await loadExtensions([join(packageRoot,'extensions/psst.ts')],root);
  assert.deepEqual(loaded.errors,[]);
  assert.equal(loaded.extensions.length,1);
  const ext=loaded.extensions[0];
  assert.deepEqual([...ext.tools.keys()].sort(),['broker_acknowledge','broker_identity','broker_list_clients','broker_message_status','broker_receive','broker_send']);
  assert.ok(ext.commands.has('psst-status'));
  assert.ok(ext.commands.has('psst-connect'));
  const ctx={hasUI:false,sessionManager:{getSessionId:()=> 'native-fixture'}};
  await ext.commands.get('psst-connect').handler('/missing/connection.json', ctx);
  for(const handler of ext.handlers.get('session_start')) await handler({type:'session_start'},ctx);
  const result=await ext.tools.get('broker_receive').definition.execute('fixture-tool',{},undefined,undefined,ctx);
  assert.equal(result.isError,true);assert.equal(result.details.error.code,'session_mismatch');
  for(const handler of ext.handlers.get('session_shutdown')) await handler({type:'session_shutdown'},ctx);
  // Native package installer, with isolated HOME/agent configuration only.
  const cli=join(base,'dist/cli.js');
  const installed=spawnSync(process.execPath,[cli,'install',packageRoot],{cwd:root,env:process.env,encoding:'utf8',timeout:30000});
  assert.equal(installed.status,0,installed.stderr+installed.stdout);
  const settings=JSON.parse(readFileSync(join(root,'agent/settings.json'),'utf8'));
  assert.ok(settings.packages.some(p=>resolve(root,'agent',typeof p==='string'?p:p.source)===packageRoot), JSON.stringify(settings));
  const listed=spawnSync(process.execPath,[cli,'list'],{cwd:root,env:process.env,encoding:'utf8',timeout:30000});
  assert.equal(listed.status,0,listed.stderr);assert.ok(listed.stdout.includes('package'));
});
