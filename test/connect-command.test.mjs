import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, statSync, chmodSync, symlinkSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CONNECTOR_VERSION } from '../src/runtime-support.mjs';
import { installExtension } from '../src/extension.mjs';
import { createConfigPathStore } from '../src/config-path.mjs';
import { PiBrokerSession } from '../src/session.mjs';
function approvedSetup(file,url='https://broker.example',onCall=()=>{}) {
 return async (_ctx,{beforeBegin})=>{onCall();await beforeBegin({brokerUrl:url});return {state:'approved',requestId:'request-fixture',connectionFile:file,brokerUrl:url};};
}
function fixture(t) {
 const home=mkdtempSync(join(tmpdir(),'pi-connect-')); t.after(()=>rmSync(home,{recursive:true,force:true}));
 const file=join(home,'connection.json');
 writeFileSync(file,JSON.stringify({format:'broker-client-bundle-v1',protocol_version:'1',file_paths_relative_to:'connection_file_directory',authorization_header:'Authorization',authorization_scheme:'Bearer',insecure_development:false,broker_url:'https://broker.example',token_file:'token',allowed_client_types:['pi']}),{mode:0o600});
 const pathStore=createConfigPathStore(home),env={PSST_STATE_DIR:join(home,'state')};
 let sessionId='native-A',active=0,peak=0; const instances=[],notices=[];
 const ctx={hasUI:true,sessionManager:{getSessionId:()=>sessionId},ui:{setStatus(){},notify:text=>notices.push(text)}};
 const createSession=options=>{const session=new PiBrokerSession(options),close=session.close.bind(session);let started=false;
 session.start=async()=>{started=true;active++;peak=Math.max(peak,active);};session.close=async()=>{if(started){active--;started=false;}await close();};instances.push(session);return session;};
 const load=(overrides={})=>{const events={},commands={},tools={};const Type={Object:()=>({}),String:()=>({}),Optional:()=>({}),Integer:()=>({})};
 installExtension({on:(n,f)=>events[n]=f,registerCommand:(n,c)=>commands[n]=c,registerTool:t=>tools[t.name]=t},Type,{pathStore,env,createSession,...overrides});return {events,commands,tools};};
 return {home,file,pathStore,env,ctx,load,instances,notices,setSession:id=>sessionId=id,get active(){return active;},get peak(){return peak;}};
}
test('connect activates current session without env; TXT survives reload; reconnect has one owner',async t=>{
 const f=fixture(t);let host=f.load();await host.events.session_start({},f.ctx);assert.equal(f.active,0);
 await host.commands['psst-connect'].handler(f.file,f.ctx);assert.equal(f.active,1);const first=f.instances.at(-1).inbox.identity.client_id;
 assert.equal(f.pathStore.read(),f.file);assert.equal(statSync(join(f.home,'.pi/agent/psst/selection.sqlite')).mode&0o777,0o600);
 await host.commands['psst-connect'].handler(f.file,f.ctx);assert.equal(f.instances.at(-1).inbox.identity.client_id,first);assert.equal(f.peak,1);
 await host.events.session_shutdown();host=f.load();await host.events.session_start({},f.ctx);assert.equal(f.instances.at(-1).inbox.identity.client_id,first);assert.equal(f.active,1);
 f.setSession('native-B');await host.events.session_start({},f.ctx);assert.notEqual(f.instances.at(-1).inbox.identity.client_id,first);await host.events.session_shutdown();assert.equal(f.active,0);
});
test('invalid command preserves working session; concurrent connect/shutdown cannot revive it',async t=>{
 const f=fixture(t),host=f.load();await host.commands['psst-connect'].handler(f.file,f.ctx);
 await host.commands['psst-connect'].handler('relative.json',f.ctx);assert.equal(f.active,1);assert.equal(f.pathStore.read(),f.file);
 await host.commands['psst-connect'].handler('/missing/connection.json',f.ctx);assert.equal(f.active,1);
 await Promise.all([host.commands['psst-connect'].handler(f.file,f.ctx),host.events.session_shutdown()]);assert.equal(f.active,0);assert.equal(f.peak,1);assert.ok(f.notices.every(text=>!text.includes(f.file)));
});
test('TXT rejects multiline/relative/public/symlink; explicit env keeps precedence',async t=>{
 const f=fixture(t);assert.equal(f.pathStore.read(),null);const pointer=join(f.home,'.pi/agent/psst/pi-config-path');mkdirSync(join(f.home,'.pi/agent/psst'),{recursive:true,mode:0o700});writeFileSync(pointer,f.file+'\n',{mode:0o600});
 for(const value of ['relative.json\n',f.file+'\n/other\n']){writeFileSync(pointer,value);assert.throws(()=>f.pathStore.read());}
 writeFileSync(pointer,f.file+'\n');chmodSync(pointer,0o644);assert.throws(()=>f.pathStore.read());rmSync(pointer);symlinkSync(f.file,pointer);assert.throws(()=>f.pathStore.read());
 f.env.PSST_CONFIG_FILE=f.file;const host=f.load();await host.events.session_start({},f.ctx);assert.equal(f.active,1);await host.events.session_shutdown();
});

test('diagnostic disconnect survives reload until explicit reconnect; manual mode survives reconnect',async t=>{
 const f=fixture(t);f.env.PSST_DIAGNOSTIC_MANUAL='1';let host=f.load();await host.commands['psst-connect'].handler(f.file,f.ctx);
 await host.commands['psst-mode'].handler('manual',f.ctx);
 await host.commands['psst-disconnect'].handler('',f.ctx);assert.equal(f.active,0);
 await host.events.session_shutdown();host=f.load();await host.events.session_start({},f.ctx);assert.equal(f.active,0);
 await host.commands['psst-connect'].handler(f.file,f.ctx);assert.equal(f.active,1);
 const result=await host.tools.broker_identity.execute('id',{},undefined,undefined,f.ctx);assert.equal(result.details.local_mode,'cooperative_pull');
 await host.events.session_shutdown();
});

test('pairing completion after shutdown cannot reconnect or replace remembered configuration',async t=>{
 const f=fixture(t);let finish;const host=f.load({connectionResolver:()=>new Promise(resolve=>finish=resolve)});
 await host.events.session_start({},f.ctx);const pending=host.commands['psst-connect'].handler(f.file,f.ctx);
 await host.events.session_shutdown();finish(f.file);await pending;assert.equal(f.active,0);assert.equal(f.pathStore.read(),null);
});

test('native setup is explicit once; thirty fresh sessions auto-connect without setup or credential rotation',async t=>{
 const f=fixture(t);let setups=0;const overrides={setupUI:approvedSetup(f.file,'https://broker.example',()=>setups++)};
 let host=f.load(overrides);await host.commands['psst-setup'].handler('',f.ctx);assert.equal(setups,1);await host.events.session_shutdown();
 const ids=new Set();for(let i=0;i<30;i++){f.setSession(`fresh-${i}`);host=f.load(overrides);await host.events.session_start({},f.ctx);ids.add(f.instances.at(-1).inbox.identity.client_id);await host.events.session_shutdown();}
 assert.equal(ids.size,30);assert.equal(setups,1);assert.equal(f.pathStore.read(),f.file);
});

test('failed native setup attachment leaves previous installation selection untouched',async t=>{
 const f=fixture(t);f.pathStore.write(f.file,'https://broker.example');const before=f.pathStore.snapshot();
 const replacement=join(f.home,'replacement.json');writeFileSync(replacement,readFileSync(f.file),{mode:0o600});
 const host=f.load({setupUI:approvedSetup(replacement),createSession:()=>{throw Error('synthetic attach failure');}});
 await host.commands['psst-setup'].handler('',f.ctx);assert.deepEqual(f.pathStore.snapshot(),before);
});

test('native setup CAS does not overwrite selection changed during registration',async t=>{
 const f=fixture(t);f.pathStore.write(f.file,'https://broker.example');
 const replacement=join(f.home,'replacement.json');writeFileSync(replacement,readFileSync(f.file),{mode:0o600});
 const host=f.load({setupUI:approvedSetup(replacement),createSession:options=>{const s=new PiBrokerSession(options);s.start=async()=>{f.pathStore.write(f.file,'https://broker.example');};return s;}});
 await host.commands['psst-setup'].handler('',f.ctx);assert.equal(f.pathStore.read(),f.file);assert.ok(f.notices.some(n=>n.includes('selection was not overwritten')));await host.events.session_shutdown();
});

test('explicit native setup may replace saved broker A with approved B after success only',async t=>{
 const f=fixture(t);f.pathStore.write(f.file,'https://broker.example');
 const replacement=join(f.home,'broker-b.json');const bundle=JSON.parse(readFileSync(f.file));bundle.broker_url='https://broker-b.example';writeFileSync(replacement,JSON.stringify(bundle),{mode:0o600});
 const host=f.load({setupUI:approvedSetup(replacement,'https://broker-b.example')});
 await host.commands['psst-setup'].handler('',f.ctx);assert.equal(f.pathStore.snapshot().brokerUrl,'https://broker-b.example');assert.equal(f.pathStore.read(),replacement);await host.events.session_shutdown();
});

test('failed legacy explicit connect and unsafe snapshot do not replace saved selection',async t=>{
 const f=fixture(t);f.pathStore.write(f.file,'https://broker.example');const before=f.pathStore.snapshot();
 const host=f.load({createSession:()=>{throw Error('fixture failure');}});await host.commands['psst-connect'].handler(f.file,f.ctx);assert.deepEqual(f.pathStore.snapshot(),before);
 const unsafe=f.load({pathStore:{snapshot(){throw Error('raw local path must not leak');},read(){return null;}}});
 await unsafe.commands['psst-setup'].handler('',f.ctx);assert.equal(f.notices.some(s=>s.includes('raw local path')),false);
});

test('pending survives reopen with GET-only approval checks and no second enrollment',async t=>{
 const f=fixture(t);let begins=0,reads=0,polls=0;
 const client={readApprovalState:async()=>{reads++;return{state:'approved',requestId:'saved-request',connectionFile:f.file};},pollApproval:async()=>{polls++;throw Error('unneeded');}};
 const setupUI=async(_ctx,{beforeBegin})=>{begins++;await beforeBegin({brokerUrl:'https://broker.example'});return{state:'pending',requestId:'saved-request',brokerUrl:'https://broker.example'};};
 let host=f.load({setupUI,approvalClient:client});await host.commands['psst-setup'].handler('',f.ctx);
 assert.equal(f.active,0);assert.equal(f.pathStore.readPending().requestId,'saved-request');
 await host.events.session_shutdown();host=f.load({setupUI,approvalClient:client});await host.events.session_start({},f.ctx);
 assert.equal(f.active,1);assert.equal(f.pathStore.read(),f.file);assert.equal(f.pathStore.readPending().requestId,'saved-request');assert.equal(begins,1);assert.equal(reads,1);assert.equal(polls,0);await host.events.session_shutdown();
});

test('disconnect cancels pending persistently and late result cannot connect',async t=>{
 const f=fixture(t);let release;
 const setupUI=async(_ctx,{beforeBegin})=>{await beforeBegin({brokerUrl:'https://broker.example'});return await new Promise(r=>release=r);};
 let host=f.load({setupUI});const task=host.commands['psst-setup'].handler('',f.ctx);await new Promise(r=>setImmediate(r));
 await host.commands['psst-disconnect'].handler('',f.ctx);release({state:'approved',requestId:'late',connectionFile:f.file,brokerUrl:'https://broker.example'});await task;
 assert.equal(f.active,0);assert.notEqual(f.pathStore.readPending(),null);assert.equal(f.pathStore.isDisconnected('native-A'),true);assert.equal(f.pathStore.read(),null);
 host=f.load({approvalClient:{readApprovalState:()=>{throw Error('must not poll canceled');}}});await host.events.session_start({},f.ctx);assert.equal(f.active,0);await host.events.session_shutdown();
});

test('uncertain begin recovers exact durable request after reopen without POST; absent state never creates',async t=>{
 const f=fixture(t);let begins=0;
 const setupUI=async(_ctx,{beforeBegin})=>{begins++;await beforeBegin({brokerUrl:'https://broker.example'});throw Error('lost response');};
 let host=f.load({setupUI});await host.commands['psst-setup'].handler('',f.ctx);assert.equal(f.pathStore.readPending().requestId,null);await host.events.session_shutdown();
 host=f.load({setupUI,approvalClient:{readApprovalState:async()=>null}});await host.events.session_start({},f.ctx);assert.equal(f.active,0);assert.equal(begins,1);await host.events.session_shutdown();
 host=f.load({setupUI,approvalClient:{readApprovalState:async()=>({state:'approved',requestId:'durable',connectionFile:f.file})}});await host.events.session_start({},f.ctx);assert.equal(f.active,1);assert.equal(begins,1);await host.events.session_shutdown();
});

test('denial and wrong-origin approval preserve working selection and unread mailbox',async t=>{
 const f=fixture(t);let host=f.load();await host.commands['psst-connect'].handler(f.file,f.ctx);
 const before=f.pathStore.snapshot(),identity=f.instances.at(-1).inbox.identity.client_id;await host.events.session_shutdown();
 for(const terminal of ['denied','expired','revoked']){
  const setupUI=async(_ctx,{beforeBegin})=>{await beforeBegin({brokerUrl:'https://broker.example',replaceRequestId:f.pathStore.readPending()?.requestId});return{state:terminal,requestId:`request-${terminal}`,brokerUrl:'https://broker.example'};};
  host=f.load({setupUI});await host.events.session_start({},f.ctx);await host.commands['psst-setup'].handler('',f.ctx);
  assert.deepEqual(f.pathStore.snapshot(),before);assert.equal(f.active,1);assert.equal(f.instances.at(-1).inbox.identity.client_id,identity);assert.notEqual(f.pathStore.readPending(),null);await host.events.session_shutdown();
 }
 host=f.load({setupUI:approvedSetup(f.file,'https://wrong.example')});await host.events.session_start({},f.ctx);await host.commands['psst-setup'].handler('',f.ctx);
 assert.deepEqual(f.pathStore.snapshot(),before);assert.equal(f.active,1);await host.events.session_shutdown();
});

test('failed approved replacement restores prior working connection without changing selection',async t=>{
 const f=fixture(t),replacement=join(f.home,'replacement.json');const bundle=JSON.parse(readFileSync(f.file));bundle.broker_url='https://new.example';writeFileSync(replacement,JSON.stringify(bundle),{mode:0o600});
 const initial=f.load();await initial.commands['psst-connect'].handler(f.file,f.ctx);await initial.events.session_shutdown();
 const prior=f.pathStore.snapshot();let active=0;
 const host=f.load({setupUI:approvedSetup(replacement,'https://new.example'),createSession:options=>{
  if(new URL(options.config.url).origin==='https://new.example')throw Error('synthetic attach failure');
  const instance=new PiBrokerSession(options),close=instance.close.bind(instance);instance.start=async()=>active++;instance.close=async()=>{active--;await close();};return instance;
 }});
 await host.events.session_start({},f.ctx);assert.equal(active,1);await host.commands['psst-setup'].handler('',f.ctx);assert.equal(active,1);assert.deepEqual(f.pathStore.snapshot(),prior);assert.notEqual(f.pathStore.readPending(),null);await host.events.session_shutdown();
});

test('startup origin override mismatch never sends pending credentials or overrides explicit bundle',async t=>{
 const f=fixture(t);let reads=0;const pointer={intentId:'fixture-intent',requestId:'fixture-request',brokerUrl:'https://broker.example',selectionRevision:'empty'};
 f.pathStore.writePending(pointer);const client={readApprovalState:async()=>{reads++;throw Error('must not inspect pending credential');}};
 f.env.PSST_BROKER_URL='https://other.example';let host=f.load({approvalClient:client});await host.events.session_start({},f.ctx);assert.equal(reads,0);assert.equal(f.active,0);await host.events.session_shutdown();
 delete f.env.PSST_BROKER_URL;f.env.PSST_CONFIG_FILE=f.file;host=f.load({approvalClient:client});await host.events.session_start({},f.ctx);assert.equal(reads,0);assert.equal(f.active,1);await host.events.session_shutdown();
});

test('corrupt pending state cannot prevent explicit transport disconnect',async t=>{
 const f=fixture(t);let corrupt=false;const store={...f.pathStore,readPending(){if(corrupt)throw Error('unsafe fixture');return f.pathStore.readPending();}};
 const host=f.load({pathStore:store});await host.commands['psst-connect'].handler(f.file,f.ctx);assert.equal(f.active,1);
 corrupt=true;await host.commands['psst-disconnect'].handler('',f.ctx);assert.equal(f.active,0);assert.ok(!f.notices.some(n=>n.includes('unsafe fixture')));await host.events.session_shutdown();
});

for(const disconnectOne of [false,true])test(`thirty waiting sessions recognize same approval winner; local disconnect=${disconnectOne}`,async t=>{
 const f=fixture(t);let approved=false,begins=0,reads=0;
 const client={readApprovalState:async()=>{reads++;return{state:approved?'approved':'pending',requestId:'shared-request',connectionFile:f.file};},pollApproval:async()=>({state:approved?'approved':'pending',requestId:'shared-request',connectionFile:f.file})};
 const setupUI=async(_ctx,{beforeBegin})=>{begins++;await beforeBegin({brokerUrl:'https://broker.example'});return{state:'pending',requestId:'shared-request',brokerUrl:'https://broker.example'};};
 const hosts=[],contexts=[];
 for(let i=0;i<30;i++){
  const ctx={...f.ctx,sessionManager:{getSessionId:()=>`concurrent-native-${i}`}};contexts.push(ctx);
  const host=f.load({setupUI,approvalClient:client});hosts.push(host);
  if(i===0)await host.commands['psst-setup'].handler('',ctx);else await host.events.session_start({},ctx);
 }
 assert.equal(f.active,0);assert.equal(begins,1);const intent=f.pathStore.readPending();
 if(disconnectOne){
  await hosts[0].commands['psst-disconnect'].handler('',contexts[0]);await hosts[0].events.session_shutdown();
  assert.deepEqual(f.pathStore.readPending(),intent);const beforeReads=reads;
  hosts[0]=f.load({setupUI,approvalClient:client});await hosts[0].events.session_start({},contexts[0]);assert.equal(reads,beforeReads);
 }
 approved=true;const expected=disconnectOne?29:30,deadline=Date.now()+6000;
 while(f.active!==expected&&Date.now()<deadline)await new Promise(r=>setTimeout(r,20));
 assert.equal(f.active,expected);assert.equal(begins,1);assert.equal(new Set(f.instances.map(s=>s.inbox.identity.client_id)).size,expected);
 assert.equal(f.pathStore.snapshot().approvalRequestId,'shared-request');assert.equal(f.pathStore.readPending().intentId,intent.intentId);
 if(disconnectOne){await hosts[0].events.session_start({},contexts[0]);assert.equal(f.active,29);assert.equal(f.pathStore.isDisconnected('concurrent-native-0'),true);}
 for(const host of hosts)await host.events.session_shutdown();assert.equal(f.active,0);
});

test('only still-active explicit setup retries uncertain initial POST; shutdown startup never begins',async t=>{
 const f=fixture(t);let retries=0;
 const setupUI=async(_ctx,{beforeBegin})=>{await beforeBegin({brokerUrl:'https://broker.example',directory:f.home,clientType:'pi'});throw Object.assign(Error('uncertain'),{retryable:true,retryAfterMs:2000});};
 const client={beginApproval:async()=>{retries++;return{state:'approved',requestId:'same-durable-request',connectionFile:f.file};},readApprovalState:async()=>null};
 let host=f.load({setupUI,approvalClient:client});await host.commands['psst-setup'].handler('',f.ctx);
 const deadline=Date.now()+5000;while(f.active===0&&Date.now()<deadline)await new Promise(r=>setTimeout(r,20));assert.equal(f.active,1);assert.equal(retries,1);await host.events.session_shutdown();
 const next=fixture(t);host=next.load({setupUI,approvalClient:client});await host.commands['psst-setup'].handler('',next.ctx);await host.events.session_shutdown();
 host=next.load({setupUI,approvalClient:client});await host.events.session_start({},next.ctx);await new Promise(r=>setTimeout(r,2100));assert.equal(retries,1);assert.equal(next.active,0);await host.events.session_shutdown();
});

test('new local setup is gated while approved attachment is awaiting native registration',async t=>{
 const f=fixture(t);let release,started,uiCalls=0;const waiting=new Promise(r=>started=r);
 const host=f.load({setupUI:approvedSetup(f.file,'https://broker.example',()=>uiCalls++),createSession:options=>{const adapter=new PiBrokerSession(options);adapter.start=()=>{started();return new Promise(r=>release=r);};return adapter;}});
 const first=host.commands['psst-setup'].handler('',f.ctx);await waiting;const pointer=f.pathStore.readPending();
 await host.commands['psst-setup'].handler('',f.ctx);assert.equal(uiCalls,1);assert.deepEqual(f.pathStore.readPending(),pointer);assert.equal(f.pathStore.read(),null);
 release();await first;assert.equal(f.pathStore.read(),f.file);assert.equal(f.pathStore.snapshot().approvalIntentId,pointer.intentId);await host.events.session_shutdown();
});

test('newer cross-process intent during old registration prevents stale promotion and preserves new pointer',async t=>{
 const f=fixture(t);let release,started;const waiting=new Promise(r=>started=r);
 const host=f.load({setupUI:approvedSetup(f.file),createSession:options=>{const adapter=new PiBrokerSession(options);adapter.start=()=>{started();return new Promise(r=>release=r);};return adapter;}});
 const task=host.commands['psst-setup'].handler('',f.ctx);await waiting;const old=f.pathStore.readPending();
 const next={...old,intentId:'next-explicit-intent',requestId:'next-explicit-request'};assert.equal(f.pathStore.writePending(next,old.intentId),true);
 release();await task;assert.equal(f.pathStore.read(),null);assert.deepEqual(f.pathStore.readPending(),next);assert.ok(f.notices.some(n=>n.includes('superseded')));await host.events.session_shutdown();
});

test('bare connect without a saved connection guides setup/status without creating state',async t=>{
 const f=fixture(t);let reads=0;const host=f.load({pathStore:{read:()=>null,snapshot(){reads++;throw Error('must not inspect absent selection');}}});
 await host.commands['psst-connect'].handler('',f.ctx);assert.equal(reads,0);assert.equal(f.active,0);
 assert.match(f.notices.at(-1),/psst-setup.*psst-status/);assert.equal(f.notices.at(-1).includes('invalid_configuration'),false);
});
test('setup reports sanitized failing phase and status retains last diagnostic',async t=>{
 const f=fixture(t),secret='fixture-secret-private';
 const host=f.load({setupUI:async(_ctx,{onPhase})=>{onPhase('url_validation');throw Object.assign(Error(secret),{code:'broker_origin_mismatch'});}});
 await host.commands['psst-setup'].handler('',f.ctx);
 assert.match(f.notices.at(-1),/broker_origin_mismatch; phase=url_validation; request=not_started/);
 await host.commands['psst-status'].handler('',f.ctx);
 assert.ok(f.notices.filter(n=>n.includes('phase=url_validation')).length>=2);
 assert.ok(f.notices.some(n=>n.includes(`connector ${CONNECTOR_VERSION}`)));assert.ok(f.notices.every(n=>!n.includes(secret)));
 assert.equal(f.pathStore.readPending(),null);
});
test('failed request after intent save reports unknown outcome, preserving exact pending intent',async t=>{
 const f=fixture(t);const host=f.load({setupUI:async(_ctx,{beforeBegin,onPhase})=>{await beforeBegin({brokerUrl:'https://broker.example'});onPhase('enrollment_request');throw Object.assign(Error('raw body must not leak'),{code:'invalid_response'});}});
 await host.commands['psst-setup'].handler('',f.ctx);assert.ok(f.pathStore.readPending().intentId);
 assert.match(f.notices.at(-1),/invalid_response; phase=enrollment_request; request=outcome_unknown/);
 assert.equal(f.pathStore.read(),null);assert.ok(f.notices.every(n=>!n.includes('raw body')));
});
test('invalid storage does not prevent registration of read-only doctor and diagnostic commands',async t=>{
 const f=fixture(t),root=join(f.home,'unsafe-agent','psst');mkdirSync(root,{recursive:true,mode:0o700});
 writeFileSync(join(root,'selection.sqlite'),'private-not-sqlite',{mode:0o600});
 const env={PI_CODING_AGENT_DIR:join(f.home,'unsafe-agent')};const host=f.load({env,pathStore:null});
 await host.commands['psst-doctor'].handler('',f.ctx);assert.match(f.notices.at(-1),/selection_file=ok/);
 await host.commands['psst-setup'].handler('',f.ctx);assert.match(f.notices.at(-1),/phase=selection_read; request=not_started/);
 assert.equal(readFileSync(join(root,'selection.sqlite'),'utf8'),'private-not-sqlite');
});


test('production tools are automatic-only; legacy manual selection cannot silently disable native delivery',async t=>{
 const f=fixture(t);f.env.PSST_DIAGNOSTIC_MANUAL='1';let host=f.load();
 assert.ok(host.commands['psst-mode']);assert.ok(host.tools.broker_receive);assert.ok(host.tools.broker_acknowledge);
 await host.commands['psst-connect'].handler(f.file,f.ctx);await host.commands['psst-mode'].handler('manual',f.ctx);
 await host.events.session_shutdown();delete f.env.PSST_DIAGNOSTIC_MANUAL;host=f.load();
 assert.equal(host.commands['psst-mode'],undefined);assert.equal(host.tools.broker_receive,undefined);assert.equal(host.tools.broker_acknowledge,undefined);
 await host.events.session_start({},f.ctx);
 const identity=await host.tools.broker_identity.execute('id',{},undefined,undefined,f.ctx);assert.equal(identity.details.local_mode,'native_auto');
 assert.equal(f.instances.at(-1).inbox.db.prepare("SELECT value FROM pi_delivery_settings WHERE key='mode'").get().value,'manual','migration changes behavior, not stored inbox state');
 await host.commands['psst-disconnect'].handler('',f.ctx);await host.events.session_shutdown();host=f.load();await host.events.session_start({},f.ctx);assert.equal(f.active,0,'disconnect still hard-stops on reload');
 await host.events.session_shutdown();
});

test('only exact explicit diagnostic flag exposes cooperative tools; production never creates their receipt table',async t=>{
 for(const value of [undefined,'','0','true']){
  const f=fixture(t);if(value!==undefined)f.env.PSST_DIAGNOSTIC_MANUAL=value;const host=f.load();
  assert.equal(host.tools.broker_receive,undefined);assert.equal(host.tools.broker_acknowledge,undefined);assert.equal(host.commands['psst-mode'],undefined);
  await host.commands['psst-connect'].handler(f.file,f.ctx);
  assert.equal(f.instances.at(-1).inbox.db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name='cooperative_receipts'").get().n,0);
  await host.events.session_shutdown();
 }
});


test('bare connect resumes saved credential/mailbox after explicit disconnect without enrollment or selection replacement',async t=>{
 const f=fixture(t);let approvalCalls=0;const forbidden=()=>{approvalCalls++;throw Error('no enrollment permitted');};
 const overrides={approvalClient:{readApprovalState:forbidden,beginApproval:forbidden,pollApproval:forbidden},setupUI:forbidden,connectionResolver:async file=>file};
 let host=f.load(overrides);await host.commands['psst-connect'].handler(f.file,f.ctx);const identity=f.instances.at(-1).inbox.identity.client_id,saved=f.pathStore.snapshot();
 await host.commands['psst-disconnect'].handler('',f.ctx);await host.events.session_shutdown();host=f.load(overrides);await host.events.session_start({},f.ctx);assert.equal(f.active,0);
 await host.commands['psst-connect'].handler('',f.ctx);assert.equal(f.active,1);assert.equal(f.instances.at(-1).inbox.identity.client_id,identity);assert.deepEqual(f.pathStore.snapshot(),saved);assert.equal(approvalCalls,0);
 const instances=f.instances.length;await host.commands['psst-connect'].handler('',f.ctx);assert.equal(f.instances.length,instances,'already connected is a no-op');assert.equal(approvalCalls,0);
 await host.events.session_shutdown();
});

test('bare connect invalid or expired saved selection preserves selection, stop flag and pending intent',async t=>{
 for(const code of ['invalid_configuration','credential_expired']){
  const f=fixture(t);f.pathStore.write(f.file,'https://broker.example');f.pathStore.setDisconnected('native-A',true);const saved=f.pathStore.snapshot();
  let enrollments=0;const host=f.load({configReader:()=>{throw Object.assign(Error('private raw path must not appear'),{code});},approvalClient:{beginApproval(){enrollments++;}}});
  await host.commands['psst-connect'].handler('',f.ctx);assert.deepEqual(f.pathStore.snapshot(),saved);assert.equal(f.pathStore.isDisconnected('native-A'),true);assert.equal(f.active,0);assert.equal(enrollments,0);assert.ok(f.notices.some(n=>n.includes('psst-doctor')));assert.ok(f.notices.every(n=>!n.includes('private raw path')));
 }
});

test('shutdown during bare reconnect cannot attach late or replace the saved selection',async t=>{
 const f=fixture(t);f.pathStore.write(f.file,'https://broker.example');const saved=f.pathStore.snapshot();let release,entered;const started=new Promise(resolve=>entered=resolve),gate=new Promise(resolve=>release=resolve);
 const host=f.load({createSession:options=>{const session=new PiBrokerSession(options);session.start=async()=>{entered();await gate;};return session;},setupUI:()=>{throw Error('must not setup');}});
 const connecting=host.commands['psst-connect'].handler('',f.ctx);await started;const stopping=host.events.session_shutdown();release();await Promise.all([connecting,stopping]);
 assert.deepEqual(f.pathStore.snapshot(),saved);assert.ok(f.notices.every(n=>!n.includes('Psst reconnected')));
 const result=await host.tools.broker_identity.execute('identity',{},undefined,undefined,f.ctx);assert.equal(result.details.error.code,'session_mismatch');
});


test('bare connect retries a paused transport instead of claiming an already healthy connection',async t=>{
 const f=fixture(t);let enrollments=0;const host=f.load({setupUI:()=>{enrollments++;throw Error('no enrollment');}});
 await host.commands['psst-connect'].handler(f.file,f.ctx);const first=f.instances.at(-1),id=first.inbox.identity.client_id,saved=f.pathStore.snapshot();
 first.runtime.handleTransportError({code:'unauthenticated'});assert.equal(first.runtime.paused,true);assert.equal(first.isAlive(),true);
 const before=f.instances.length;await host.commands['psst-connect'].handler('',f.ctx);
 assert.equal(f.instances.length,before+1);assert.equal(f.instances.at(-1).inbox.identity.client_id,id);assert.equal(f.instances.at(-1).deliveryAllowed(),true);assert.deepEqual(f.pathStore.snapshot(),saved);assert.equal(enrollments,0);assert.match(f.notices.at(-1),/reconnected/);
 await host.events.session_shutdown();
});
