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
  assert.ok(ext.handlers.has('session_info_changed'));
  assert.ok(ext.handlers.has('model_select'));
  const ctx={hasUI:false,sessionManager:{getSessionId:()=> 'native-fixture'}};
  await ext.commands.get('psst-connect').handler('/missing/connection.json', ctx);
  for(const handler of ext.handlers.get('session_start')) await handler({type:'session_start'},ctx);
  const result=await ext.tools.get('broker_receive').definition.execute('fixture-tool',{},undefined,undefined,ctx);
  assert.equal(result.isError,true);assert.equal(result.details.error.code,'session_mismatch');
  for(const handler of ext.handlers.get('session_shutdown')) await handler({type:'session_shutdown'},ctx);
  // Actual native runtime + official local faux model: no provider auth or network.
  const { createAgentSession } = await import(pathToFileURL(join(base,'dist/core/sdk.js')).href);
  const { ModelRuntime } = await import(pathToFileURL(join(base,'dist/core/model-runtime.js')).href);
  const { DefaultResourceLoader } = await import(pathToFileURL(join(base,'dist/core/resource-loader.js')).href);
  const { SessionManager } = await import(pathToFileURL(join(base,'dist/core/session-manager.js')).href);
  const { fauxProvider, fauxAssistantMessage } = await import(pathToFileURL(join(host,'node_modules/@earendil-works/pi-ai/dist/providers/faux.js')).href);
  const { NativeDelivery } = await import(pathToFileURL(join(packageRoot,'src/native-delivery.mjs')).href);
  const { nativeSessionMetadata } = await import(pathToFileURL(join(packageRoot,'src/session-metadata.mjs')).href);
  const { Inbox, newSessionIdentity } = await import(pathToFileURL(join(packageRoot,'vendor/broker/reference/inbox.mjs')).href);
  const { randomUUID } = await import('node:crypto');
  const runtime = await ModelRuntime.create({authPath:join(root,'fixture-auth.json'),modelsPath:null,refreshOnCreate:false});
  const faux = fauxProvider({tokensPerSecond:100000,models:[{id:'fixture-model-a'},{id:'fixture-model-b'}]});
  let releaseBusy;
  faux.setResponses([async()=>{await new Promise(resolve=>releaseBusy=resolve);return fauxAssistantMessage('initial turn');},fauxAssistantMessage('native reply A'),fauxAssistantMessage('native reply B')]);
  runtime.registerNativeProvider(faux.provider);
  let nativeApi, nativeCtx;
  const metadataEvents=[];
  const loader = new DefaultResourceLoader({cwd:root,agentDir:join(root,'native-agent'),noExtensions:true,noSkills:true,noPromptTemplates:true,noThemes:true,noContextFiles:true,
    extensionFactories:[api=>{nativeApi=api;api.on('session_start',(_event,context)=>nativeCtx=context);
      for(const event of ['session_info_changed','model_select'])api.on(event,(_event,context)=>metadataEvents.push({event,metadata:nativeSessionMetadata(api,context)}));} ]});
  await loader.reload();
  const manager = SessionManager.create(root,join(root,'native-sessions'));
  const {session: nativeSession} = await createAgentSession({cwd:root,agentDir:join(root,'native-agent'),modelRuntime:runtime,model:faux.getModel(),resourceLoader:loader,sessionManager:manager,noTools:'all'});
  await nativeSession.bindExtensions({});
  const identity = newSessionIdentity('pi');
  let inbox = new Inbox({directory:join(root,'native-inbox'),identity});
  const sessionAdapter = {get inbox(){return inbox;},deliveryAllowed:()=>true,isAlive:()=>manager.getSessionId()===nativeCtx.sessionManager.getSessionId()};
  let delivery = new NativeDelivery({session:sessionAdapter,pi:nativeApi,ctx:nativeCtx});
  t.after(()=>{delivery.stop();inbox.close();nativeSession.dispose();});
  const until = async predicate => {for(let n=0;n<300;n++){if(predicate())return;await new Promise(r=>setTimeout(r,10));}throw Error('native fixture timed out');};
  // Actual supported host APIs/events, not a guessed session fixture. Metadata
  // observation must not itself switch the model, invoke it or rotate a session.
  const nativeId=manager.getSessionId();
  assert.equal(nativeSessionMetadata(nativeApi,nativeCtx).project,root.split('/').at(-1));
  assert.deepEqual(nativeSessionMetadata(nativeApi,nativeCtx).model,{provider:faux.getModel().provider,id:'fixture-model-a',source:'observed'});
  nativeSession.setSessionName('Native review');
  await until(()=>metadataEvents.some(row=>row.event==='session_info_changed'));
  assert.match(metadataEvents.find(row=>row.event==='session_info_changed').metadata.name,/^Native review \[/);
  await nativeSession.setModel(faux.getModel('fixture-model-b'));
  assert.equal(metadataEvents.findLast(row=>row.event==='model_select').metadata.model.id,'fixture-model-b');
  assert.equal(manager.getSessionId(),nativeId);assert.equal(faux.state.callCount,0);
  await nativeSession.setModel(faux.getModel('fixture-model-a'));
  const started = nativeSession.prompt('fixture user input');
  await until(()=>!!releaseBusy);
  for(let sequence=1;sequence<=2;sequence++) inbox.accept({protocol_version:'1',message_id:randomUUID(),recipient_id:identity.client_id,recipient_sequence:sequence,
    sender:{client_id:randomUUID(),client_type:'pi',name:'peer',model:{provider:null,id:null,source:'unknown'},project:null,metadata_revision:1},origin:'broker_agent',authority:'untrusted_agent_input',content:{type:'text/plain',text:`native payload ${sequence}`},accepted_at:new Date().toISOString(),expires_at:new Date(Date.now()+86400000).toISOString(),correlation_id:null,reply_to_message_id:null});
  delivery.tick();assert.equal(inbox.head().state,'pending','busy native model must not be interrupted');
  releaseBusy();await started;
  delivery.tick();assert.equal(inbox.head().state,'injecting');
  await until(()=>faux.state.callCount===2 && nativeSession.isIdle);
  // Reopen between native persistence and local acceptance, as after an adapter crash.
  delivery.stop();inbox.close();inbox=new Inbox({directory:join(root,'native-inbox'),identity});
  delivery=new NativeDelivery({session:sessionAdapter,pi:nativeApi,ctx:nativeCtx});
  delivery.tick();assert.equal(faux.state.callCount,2,'reconciliation must not repeat the model turn');assert.equal(inbox.head().envelope.content.text,'native payload 2');
  delivery.tick();await until(()=>faux.state.callCount===3 && nativeSession.isIdle);delivery.tick();assert.equal(inbox.head(),null);
  const transcript = readFileSync(manager.getSessionFile(),'utf8').trim().split('\n').map(line=>JSON.parse(line));
  assert.equal(transcript.filter(row=>row.type==='custom_message'&&row.customType==='psst-agent-message').length,2);
  assert.equal(inbox.db.prepare("SELECT count(*) AS n FROM inbox WHERE native_receipt LIKE 'pi:%'").get().n,2);
  assert.equal(inbox.db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name='cooperative_receipts'").get().n,0,'automatic delivery never creates explicit-read receipts');

  // Native package installer, with isolated HOME/agent configuration only.
  const cli=join(base,'dist/cli.js');
  const installed=spawnSync(process.execPath,[cli,'install',packageRoot],{cwd:root,env:process.env,encoding:'utf8',timeout:30000});
  assert.equal(installed.status,0,installed.stderr+installed.stdout);
  const settings=JSON.parse(readFileSync(join(root,'agent/settings.json'),'utf8'));
  assert.ok(settings.packages.some(p=>resolve(root,'agent',typeof p==='string'?p:p.source)===packageRoot), JSON.stringify(settings));
  const listed=spawnSync(process.execPath,[cli,'list'],{cwd:root,env:process.env,encoding:'utf8',timeout:30000});
  assert.equal(listed.status,0,listed.stderr);assert.ok(listed.stdout.includes('package'));
});
