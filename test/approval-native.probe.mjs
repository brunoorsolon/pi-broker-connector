// Real official CLI/PTY + real verified TLS broker/admin form. No user credentials/model.
import test from 'node:test';
import assert from 'node:assert/strict';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {readFileSync,writeFileSync,readdirSync} from 'node:fs';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {randomUUID} from 'node:crypto';
import {createConfigPathStore} from '../src/config-path.mjs';
import {readConfig} from '../src/config.mjs';
import {PiBrokerSession} from '../src/session.mjs';
import {createTools} from '../vendor/broker/reference/tools.mjs';
const source=process.env.PSST_TEST_SOURCE,host=process.env.PI_TEST_INSTALL;
if(!source||!host)throw Error('Set PSST_TEST_SOURCE and PI_TEST_INSTALL to reviewed test fixtures');
const {approvalTlsFixture}=await import(pathToFileURL(join(resolve(source),'test/approval-tls-fixture.mjs')));
async function runScenario(t,deferApproval=false){
 const f=await approvalTlsFixture(t),marker='pi-native-approval-'+randomUUID();
 const agent=join(f.directory,'persistent-agent');
 const control={deferApproval,containerImage:process.env.PI_TEST_CONTAINER_IMAGE,containerEngine:process.env.PI_TEST_CONTAINER_ENGINE||'docker',directory:f.directory,brokerUrl:f.brokerUrl,cert:f.certFile,piCli:join(resolve(host),'node_modules/@earendil-works/pi-coding-agent/dist/cli.js'),extension:resolve('extensions/psst.ts'),messageMarker:marker};
 const controlFile=join(f.directory,'native-control.json');writeFileSync(controlFile,JSON.stringify(control),{mode:0o600});
 const child=spawn('python3',['scripts/approval-native-pty.py',controlFile],{stdio:['ignore','pipe','pipe']});
 let peer,partial='',stderr='',events=[],work=Promise.resolve(),failure,selection,credential,firstRecipient,requestId;
 t.after(async()=>{if(child.exitCode===null){child.kill();await once(child,'exit');}await peer?.close();});
 child.stderr.on('data',b=>stderr+=b);
 child.stdout.on('data',buffer=>{
  partial+=buffer;const lines=partial.split('\n');partial=lines.pop();
  for(const line of lines)if(line)work=work.then(async()=>{
   const event=JSON.parse(line);events.push(event.event);
   if(event.event==='failure')throw Error(event.reason);
   if(event.event==='pending'){
    const requests=f.approval.list();assert.equal(requests.length,1);assert.equal(requests[0].state,'pending');requestId=requests[0].id;if(!deferApproval)await f.decide(requestId,'approve');
   }
   if(event.event==='pending_closed')await f.decide(requestId,'approve');
   if(event.event==='connected'||(deferApproval&&event.event==='recreated_connected')){
    const store=createConfigPathStore(f.directory,{PI_CODING_AGENT_DIR:agent});selection=store.snapshot();
    const selectedFile=control.containerImage?selection.connectionFile.replace(/^\/persistent-agent(?=\/)/,agent):selection.connectionFile;
    const config=readConfig({PI_CODING_AGENT_DIR:join(f.directory,'peer-agent')},selectedFile);credential=readFileSync(config.tokenFile,'utf8').trim();config.caFile=f.certFile;
    peer=new PiBrokerSession({config:{...config,name:'fixture peer'},hostSessionId:randomUUID(),currentSessionId:()=>peer.hostSessionId});await peer.start();
    const tools=createTools({client:peer.client,inbox:peer.inbox}),clients=(await tools.broker_list_clients()).clients;
    const recipient=clients.find(c=>c.client_id!==peer.inbox.identity.client_id);assert.ok(recipient);firstRecipient=recipient.client_id;
    const sent=await tools.broker_send({recipient_id:recipient.client_id,text:marker+(deferApproval?'-reopened':''),send_key:'fixture-native-approval'});assert.ok(sent.message_id);
   }
   if(event.event==='recreated_connected'&&!deferApproval){
    assert.deepEqual(createConfigPathStore(f.directory,{PI_CODING_AGENT_DIR:agent}).snapshot(),selection);
    assert.equal(f.approval.list().length,1);
    const tools=createTools({client:peer.client,inbox:peer.inbox}),clients=(await tools.broker_list_clients()).clients;
    const recipient=clients.find(c=>c.client_id!==peer.inbox.identity.client_id&&c.client_id!==firstRecipient);assert.ok(recipient);
    const sent=await tools.broker_send({recipient_id:recipient.client_id,text:marker+'-reopened',send_key:'fixture-reopened'});assert.ok(sent.message_id);
   }
  }).catch(error=>{failure=error;child.kill();});
 });
 const [code]=await once(child,'exit');await work;
 assert.ifError(failure);assert.equal(code,0,stderr);
 assert.deepEqual(events,deferApproval?['pending','pending_closed','recreated_connected','recreated_received','complete']:['pending','connected','native_received','recreated_connected','recreated_received','complete']);
 assert.equal(f.approval.list().length,1);
 const output=readFileSync(join(f.directory,'terminal-output.bin'),'utf8');assert.equal(output.includes(credential),false);
 const jsonls=[];function walk(path){for(const item of readdirSync(path,{withFileTypes:true})){const file=join(path,item.name);if(item.isDirectory())walk(file);else if(item.name.endsWith('.jsonl'))jsonls.push(file);}}walk(join(agent,'sessions'));
 const rows=jsonls.flatMap(file=>readFileSync(file,'utf8').trim().split('\n').map(l=>JSON.parse(l)));
 assert.equal(rows.filter(r=>r.type==='custom_message'&&r.customType==='psst-agent-message'&&JSON.stringify(r.content).includes(marker)).length,deferApproval?1:2);
 assert.equal(new Set(rows.filter(r=>r.type==='session').map(r=>r.id)).size,deferApproval?1:2);
 // This proves native context persistence, NOT successful model inference/read/action.
}
test('official Pi URL-only PTY setup, actual admin approval/TLS automatic receipt, recreated HOME', {timeout:120000},t=>runScenario(t));
test('pending Pi request survives closed CLI and removed HOME; approval while offline attaches on reopen without setup', {timeout:120000},t=>runScenario(t,true));

test('thirty already-waiting official Pi SDK sessions all attach after one approval with distinct authenticated mailboxes', {timeout:120000},async t=>{
 const f=await approvalTlsFixture(t),agent=join(f.directory,'shared-agent');
 const options={brokerUrl:f.brokerUrl,directory:join(agent,'psst/installation-credentials'),clientType:'pi'};
 const pending=await f.helper('beginApproval',options);
 const env={PI_CODING_AGENT_DIR:agent},pathStore=createConfigPathStore(f.directory,env);
 pathStore.writePending({intentId:randomUUID(),brokerUrl:f.brokerUrl,requestId:pending.requestId,selectionRevision:'empty'});
 const helper=await import('../vendor/broker/reference/approval.mjs');
 const approvalClient={readApprovalState:helper.readApprovalState,beginApproval:()=>{throw Error('startup must not create');},pollApproval:args=>helper.pollApproval(args,{transport:async(_broker,method,path,token,input)=>{
  const response=await f.request(path,{method,headers:{Authorization:`Enrollment ${token}`,...(input?{'Content-Type':'application/json'}:{})},...(input?{body:JSON.stringify(input)}:{})});
  return{status:response.status,body:JSON.parse(response.text)};
 }})};
 const base=join(resolve(host),'node_modules/@earendil-works/pi-coding-agent');
 const {createAgentSession}=await import(pathToFileURL(join(base,'dist/core/sdk.js')));
 const {ModelRuntime}=await import(pathToFileURL(join(base,'dist/core/model-runtime.js')));
 const {DefaultResourceLoader}=await import(pathToFileURL(join(base,'dist/core/resource-loader.js')));
 const {SessionManager}=await import(pathToFileURL(join(base,'dist/core/session-manager.js')));
 const {fauxProvider}=await import(pathToFileURL(join(resolve(host),'node_modules/@earendil-works/pi-ai/dist/providers/faux.js')));
 const {Type}=await import(pathToFileURL(join(resolve(host),'node_modules/typebox/build/index.mjs')));
 const {installExtension}=await import('../src/extension.mjs');
 const runtime=await ModelRuntime.create({authPath:join(f.directory,'empty-auth.json'),modelsPath:null,refreshOnCreate:false});
 const model=fauxProvider();runtime.registerNativeProvider(model.provider);
 const sessions=[],adapters=[],managers=[];
 t.after(async()=>{for(const adapter of adapters)await adapter.close();for(const session of sessions)session.dispose();});
 for(let i=0;i<30;i++){
  const manager=SessionManager.create(f.directory,join(agent,'sessions'));managers.push(manager);
  const loader=new DefaultResourceLoader({cwd:f.directory,agentDir:agent,noExtensions:true,noSkills:true,noPromptTemplates:true,noThemes:true,noContextFiles:true,
   extensionFactories:[api=>installExtension(api,Type,{env,pathStore,approvalClient,configReader:(environment,file)=>{const config=readConfig(environment,file);return config?{...config,caFile:f.certFile}:null;},
    createSession:args=>{const adapter=new PiBrokerSession(args);adapters.push(adapter);return adapter;}})]});
  await loader.reload();const {session}=await createAgentSession({cwd:f.directory,agentDir:agent,modelRuntime:runtime,model:model.getModel(),resourceLoader:loader,sessionManager:manager,noTools:'all'});sessions.push(session);await session.bindExtensions({});
 }
 assert.equal(new Set(managers.map(m=>m.getSessionId())).size,30);assert.equal(adapters.length,0);
 await f.decide(pending.requestId,'approve');
 const deadline=Date.now()+12000;while(adapters.length!==30&&Date.now()<deadline)await new Promise(r=>setTimeout(r,20));
 assert.equal(adapters.length,30);assert.equal(new Set(adapters.map(a=>a.inbox.identity.client_id)).size,30);
 assert.deepEqual(new Set(adapters.map(a=>a.hostSessionId)),new Set(managers.map(m=>m.getSessionId())));
 while(f.store.db.prepare('SELECT count(*) n FROM sessions').get().n!==30&&Date.now()<deadline)await new Promise(r=>setTimeout(r,20));
 assert.equal((await createTools({client:adapters[0].client,inbox:adapters[0].inbox}).broker_list_clients()).clients.length,30);
 assert.equal(f.approval.list().length,1);assert.equal(model.state.callCount,0,'session startup/poll must not call model');
 assert.equal(new Set(f.store.db.prepare('SELECT credential FROM sessions').all().map(r=>r.credential)).size,1);
});
