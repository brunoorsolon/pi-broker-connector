import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,rmSync,writeFileSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {storageLayout} from '../src/storage.mjs';
import {createConfigPathStore} from '../src/config-path.mjs';
import {PiBrokerSession} from '../src/session.mjs';
const fixture=t=>{const home=mkdtempSync(join(tmpdir(),'pi-storage-'));t.after(()=>rmSync(home,{recursive:true,force:true}));return home;};
test('new storage follows native persisted project/profile; explicit state override wins',t=>{
 const home=fixture(t),agent=join(home,'profile-a'),other=join(home,'profile-b');
 assert.equal(storageLayout({},home).stateDirectory,join(home,'.pi/agent/psst'));
 assert.equal(storageLayout({PI_CODING_AGENT_DIR:'~/profile-a'},home).stateDirectory,join(agent,'psst'));
 assert.notEqual(storageLayout({PI_CODING_AGENT_DIR:agent},home).stateDirectory,storageLayout({PI_CODING_AGENT_DIR:other},home).stateDirectory);
 assert.equal(storageLayout({PI_CODING_AGENT_DIR:agent,PSST_STATE_DIR:join(home,'explicit')},home).stateDirectory,join(home,'explicit'));
 const store=createConfigPathStore(home,{PI_CODING_AGENT_DIR:agent});store.write(join(home,'connection.json'));
 assert.equal(store.snapshot().connectionFile,join(home,'connection.json'));
 assert.equal(createConfigPathStore(home,{PI_CODING_AGENT_DIR:agent}).read(),join(home,'connection.json'));
 assert.equal(createConfigPathStore(home,{PI_CODING_AGENT_DIR:other}).read(),null);
});
test('legacy selection and inbox stay pinned; coexistence of two histories fails closed',t=>{
 const home=fixture(t),legacy=join(home,'.local/state/psst/pi'),selection=join(home,'.config/psst');
 mkdirSync(legacy,{recursive:true,mode:0o700});mkdirSync(selection,{recursive:true,mode:0o700});
 writeFileSync(join(selection,'pi-config-path'),join(home,'old.json')+'\n',{mode:0o600});
 const layout=storageLayout({},home);assert.equal(layout.stateDirectory,legacy);assert.equal(layout.legacyStorage,true);
 const store=createConfigPathStore(home,{});assert.equal(store.read(),join(home,'old.json'));
 store.write(join(home,'old.json'));assert.equal(storageLayout({},home).stateDirectory,legacy);
 const temporary=join(layout.selectionDirectory,`.pi-config-path-${randomUUID()}`);
 writeFileSync(temporary,join(home,'old.json')+'\n',{mode:0o600});
 assert.equal(storageLayout({},home).stateDirectory,legacy);assert.equal(store.read(),join(home,'old.json'));
 rmSync(temporary);
 mkdirSync(join(layout.selectionDirectory,'installations'),{mode:0o700});
 assert.throws(()=>storageLayout({},home),{code:'storage_migration_required'});
 assert.equal(storageLayout({PSST_STATE_DIR:legacy},home).stateDirectory,legacy);
 assert.equal(readFileSync(join(selection,'pi-config-path'),'utf8'),join(home,'old.json')+'\n');
});
test('30 concurrent native sessions share installation but retain separate durable identities and pending state on reopen',async t=>{
 const home=fixture(t),env={PI_CODING_AGENT_DIR:join(home,'persisted-agent')};
 const config={url:'https://broker.example/',tokenFile:join(home,'token'),credentialId:`enrolled-${randomUUID()}`,name:'Pi',...storageLayout(env,home)};
 writeFileSync(config.tokenFile,'synthetic-storage-test-token',{mode:0o600});
 const sessions=[],ids=[];const make=i=>new PiBrokerSession({config,hostSessionId:`native-${i}`,currentSessionId:()=>`native-${i}`});
 try {
  for(let i=0;i<30;i++){const s=make(i);sessions.push(s);ids.push(s.inbox.identity.client_id);s.inbox.setState('metadata',{index:i,credential:config.credentialId});const now=Date.now();s.inbox.accept({protocol_version:'1',message_id:randomUUID(),recipient_id:s.inbox.identity.client_id,recipient_sequence:1,sender:{client_id:randomUUID(),client_type:'pi',name:'peer',model:{provider:null,id:null,source:'unknown'},project:null,metadata_revision:1},origin:'broker_agent',authority:'untrusted_agent_input',content:{type:'text/plain',text:`pending-${i}`},accepted_at:new Date(now).toISOString(),expires_at:new Date(now+86400000).toISOString(),correlation_id:null,reply_to_message_id:null});s.inbox.prepareSend({recipient_id:randomUUID(),content:{type:'text/plain',text:`retained-${i}`}});}
  assert.equal(new Set(ids).size,30);assert.throws(()=>make(0),{code:'owner_conflict'});
 } finally {await Promise.all(sessions.map(s=>s.close()));}
 for(let i=0;i<30;i++){const s=make(i);try{assert.equal(s.inbox.identity.client_id,ids[i]);assert.equal(s.inbox.getState('metadata').index,i);assert.equal(s.inbox.unresolvedSends().length,1);assert.equal(s.inbox.head().envelope.content.text,`pending-${i}`);assert.equal(s.inbox.head().state,'pending');}finally{await s.close();}}
 assert.equal(storageLayout(env,home).legacyStorage,false);
});

test('thirty independent processes compare-and-swap one atomic URL/path selection',async t=>{
 const {execFile}=await import('node:child_process');const {promisify}=await import('node:util');const run=promisify(execFile);
 const home=fixture(t),env={PI_CODING_AGENT_DIR:join(home,'agent')},store=createConfigPathStore(home,env);
 store.write(join(home,'initial.json'),'https://initial.example');const before=store.snapshot();
 const moduleUrl=new URL('../src/config-path.mjs',import.meta.url).href;
 const source=`import {createConfigPathStore} from ${JSON.stringify(moduleUrl)};const [home,env,path,revision]=JSON.parse(process.argv[1]);const store=createConfigPathStore(home,env);console.log(store.write(path,'https://next.example',revision));`;
 const outcomes=await Promise.all(Array.from({length:30},(_,i)=>run(process.execPath,['--input-type=module','-e',source,JSON.stringify([home,env,join(home,`next-${i}.json`),before.revision])],{timeout:10000})));
 assert.equal(outcomes.filter(r=>r.stdout.trim()==='true').length,1);assert.equal(outcomes.filter(r=>r.stdout.trim()==='false').length,29);
 const after=store.snapshot();assert.equal(after.brokerUrl,'https://next.example');assert.notEqual(after.revision,before.revision);assert.match(after.connectionFile,/next-\d+\.json$/);
});
