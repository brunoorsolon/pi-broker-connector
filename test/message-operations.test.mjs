import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { PiBrokerSession } from '../src/session.mjs';
import { installExtension } from '../src/extension.mjs';
import { createTools } from '../vendor/broker/reference/tools.mjs';
import { LocalError } from '../vendor/broker/reference/errors.mjs';
const { httpFixture } = await import(process.env.PSST_MESSAGE_TEST_SOURCE ? pathToFileURL(join(resolve(process.env.PSST_MESSAGE_TEST_SOURCE),'test/helpers.mjs')).href : './fixtures/broker/test/helpers.mjs');
const metadata={name:'recipient',model:{provider:null,id:null,source:'unknown'},project:null};
async function fixture(t) {
 const f=await httpFixture(t),tokenFile=join(f.dir,'token');writeFileSync(tokenFile,f.a.token,{mode:0o600});
 const config={url:f.base,tokenFile,stateDirectory:join(f.dir,'state'),name:'Pi fixture'};
 const make=id=>new PiBrokerSession({config,hostSessionId:id,currentSessionId:()=>id,clientOptions:{insecureDevelopment:true,now:()=>f.now,maxAttempts:1}});
 return {f,config,make};
}
async function until(predicate){for(let i=0;i<300;i++){if(predicate())return;await delay(10);}throw Error('recovery timed out');}

test('native tools expose no send key, paginate metadata10, fetch content, explicitly resend and truthfully cancel',async t=>{
 const {f,config,make}=await fixture(t),recipient=make('recipient');await recipient.client.register(metadata);t.after(()=>recipient.close());
 const tools={},commands={},events={};let branch=[],sender;
 const ctx={hasUI:false,sessionManager:{getSessionId:()=> 'sender',getBranch:()=>branch}};
 const Type={Object:(properties,options)=>({properties,...options}),String:options=>({...options}),Optional:type=>({...type,optional:true}),Integer:options=>({...options})};
 installExtension({on:(name,handler)=>events[name]=handler,registerCommand:(name,command)=>commands[name]=command,registerTool:tool=>tools[tool.name]=tool},Type,{env:{},pathStore:{read:()=>'/fixture/private-bundle'},configReader:()=>config,createSession:()=>sender=make('sender')});
 t.after(()=>events.session_shutdown());await events.session_start({},ctx);
 assert.equal('send_key' in tools.broker_send.parameters.properties,false);assert.equal(tools.broker_receive,undefined);assert.equal(tools.broker_acknowledge,undefined);
 let next=0;
 const call=async(name,args,id=`call-${++next}`)=>{branch=[{type:'message',id:`entry-${id}`,timestamp:new Date(f.now).toISOString(),message:{role:'assistant',content:[{type:'toolCall',id,name,arguments:args}]}}];const result=await tools[name].execute(id,args,undefined,undefined,ctx);assert.equal(result.isError,undefined,JSON.stringify(result.details));assert.equal('send_key' in result.details,false);return result.details;};
 const ids=[];for(let i=0;i<12;i++){ids.push((await call('broker_send',{recipient_id:recipient.inbox.identity.client_id,text:`private-content-${i}`})).message_id);f.advance(1);}
 const first=await call('broker_sent_history',{});assert.equal(first.messages.length,10);assert.ok(first.next_cursor);assert.doesNotMatch(JSON.stringify(first),/private-content/);
 assert.equal(first.messages[0].message_id,ids.at(-1));const second=await call('broker_sent_history',{cursor:first.next_cursor});assert.equal(second.messages.length,2);assert.equal(second.next_cursor,null);
 const detail=await call('broker_message_content',{message_id:ids[0]});assert.equal(detail.envelope.content.text,'private-content-0');
 const resent=await call('broker_resend',{message_id:ids[0]},'resend-one');assert.notEqual(resent.message_id,ids[0]);assert.equal(resent.resent_from_message_id,ids[0]);
 const replay=await call('broker_resend',{message_id:ids[0]},'resend-one');assert.equal(replay.message_id,resent.message_id);assert.equal(replay.acceptance_replayed,true);
 const cancelled=await call('broker_cancel',{message_id:ids[0]});assert.equal(cancelled.cancel_result,'cancelled');assert.equal(cancelled.delivery_state,'cancelled');assert.equal(cancelled.delivery_may_have_occurred,false);
 const status=await call('broker_message_status',{message_id:ids[0]});assert.equal(status.delivery_state,'cancelled');
 assert.equal((await call('broker_message_content',{message_id:resent.message_id})).envelope.content.text,'private-content-0');
 assert.equal(sender.inbox.unresolvedSends().length,0);
 const sameClient=sender.inbox.identity.client_id;
 await commands['psst-disconnect'].handler('',ctx);
 await commands['psst-connect'].handler('',ctx);
 assert.equal(sender.inbox.identity.client_id,sameClient,'bare reconnect uses the same real broker identity');
 assert.equal((await call('broker_message_status',{message_id:ids[0]})).delivery_state,'cancelled','history survives reconnect without a new file or enrollment');
});

test('lost acceptance survives Pi restart and reuses original operation; distinct identical send is new, stale replay fails closed',async t=>{
 const {f,make}=await fixture(t),recipient=make('recipient');await recipient.client.register(metadata);t.after(()=>recipient.close());
 let sender=make('sender');t.after(()=>sender.close());await sender.start();const identity=sender.inbox.identity.client_id;
 const context={operationId:'native-session:assistant-entry:original-call',operationStartedAt:f.now};
 const args={recipient_id:recipient.inbox.identity.client_id,text:'identical text'};
 const original=sender.client.request.bind(sender.client);let accepted;
 sender.client.request=async(method,path,options)=>{const result=await original(method,path,options);if(method==='POST'&&path==='/v1/messages'&&!accepted){accepted=result;throw new LocalError('request_failed',{effect:'unknown'});}return result;};
 const lost=await createTools({client:sender.client}).broker_send(args,context);assert.equal(lost.error.effect,'unknown');assert.equal('send_key' in lost,false);
 const [pending]=sender.inbox.unresolvedSends();assert.ok(pending);await sender.close();
 sender=make('sender');await sender.start();assert.equal(sender.inbox.identity.client_id,identity);await until(()=>sender.inbox.unresolvedSends().length===0);
 assert.equal(sender.inbox.outgoing(pending.key).result.message_id,accepted.message_id);assert.equal((await sender.client.sentHistory()).messages.length,1);
 const facade=createTools({client:sender.client});assert.equal((await facade.broker_send(args,context)).message_id,accepted.message_id);
 assert.equal((await facade.broker_send({...args,text:'changed'},context)).error.code,'send_conflict');
 const another=await facade.broker_send(args,{operationId:'new-explicit-native-call',operationStartedAt:f.now});assert.notEqual(another.message_id,accepted.message_id);
 f.advance(86400001);sender.inbox.collect();assert.equal(sender.inbox.outgoing(pending.key),null);
 assert.equal((await facade.broker_send(args,context)).error.code,'retry_window_elapsed');assert.equal(sender.inbox.unresolvedSends().length,0);
});

test('automatic recovery is bounded, coalesced, and aborted/drained before inbox close',async t=>{
 const {make}=await fixture(t),sender=make('sender');t.after(()=>sender.close());
 sender.inbox.prepareSend({recipient_id:randomUUID(),content:{type:'text/plain',text:'pending'}});
 let attempts=0,aborted=0;sender.client.recoverOutgoing=({limit,signal})=>{attempts++;assert.equal(limit,10);return new Promise(resolve=>signal.addEventListener('abort',()=>{aborted++;resolve([]);},{once:true}));};
 const one=sender.recoverOutgoing({budgetMs:20}),same=sender.recoverOutgoing({budgetMs:20});assert.equal(one,same);await one;assert.equal(attempts,1);assert.equal(aborted,1);assert.equal(sender.inbox.unresolvedSends().length,1);
 const pending=sender.recoverOutgoing();await delay(0);await sender.close();await pending;assert.equal(aborted,2);assert.equal(sender.operations.size,0);
});

test('unknown intent does not block a distinct native call; replay still names the original unresolved operation',async t=>{
 const {f,make}=await fixture(t),recipient=make('recipient'),sender=make('sender');await recipient.client.register(metadata);await sender.start();t.after(()=>sender.close());t.after(()=>recipient.close());
 const original=sender.client.request.bind(sender.client),facade=createTools({client:sender.client});let lose=true;
 sender.client.request=async(method,path,options)=>{if(lose&&method==='POST'&&path==='/v1/messages')throw new LocalError('request_failed',{effect:'unknown'});return original(method,path,options);};
 const args={recipient_id:recipient.inbox.identity.client_id,text:'opaque text'},a={operationId:'call-A',operationStartedAt:f.now};
 assert.equal((await facade.broker_send(args,a)).error.effect,'unknown');const key=sender.inbox.unresolvedSends()[0].key;
 lose=false;const b=await facade.broker_send(args,{operationId:'call-B',operationStartedAt:f.now});assert.ok(b.message_id);assert.equal(sender.inbox.unresolvedSends()[0].key,key);
 const replay=await facade.broker_send(args,a);assert.ok(replay.message_id);assert.notEqual(replay.message_id,b.message_id);assert.equal(sender.inbox.unresolvedSends().length,0);
});

test('native shutdown aborts stalled HTTP send/read, drains ownership and preserves unknown send intent',{timeout:10000},async t=>{
 for(const name of ['broker_send','broker_sent_history'])await t.test(name,async t=>{
  const {f,config,make}=await fixture(t),recipient=make('recipient');await recipient.client.register(metadata);t.after(()=>recipient.close());
  let sender,blocked=false;const tools={},events={};
  const args=name==='broker_send'?{recipient_id:recipient.inbox.identity.client_id,text:'stalled'}:{};
  const ctx={hasUI:false,sessionManager:{getSessionId:()=> 'sender',getBranch:()=>[{type:'message',id:'entry',timestamp:new Date(f.now).toISOString(),message:{role:'assistant',content:[{type:'toolCall',id:'call',name,arguments:args}]}}]}};
  const Type={Object:()=>({}),String:()=>({}),Optional:()=>({}),Integer:()=>({})};
  installExtension({on:(name,handler)=>events[name]=handler,registerCommand(){},registerTool:tool=>tools[tool.name]=tool},Type,{env:{},pathStore:{read:()=>'/fixture/private-bundle'},configReader:()=>config,createSession:()=>sender=make('sender')});
  t.after(()=>events.session_shutdown());await events.session_start({},ctx);const id=sender.inbox.identity.client_id;
  const handler=f.app.server.listeners('request')[0];f.app.server.removeListener('request',handler);
  f.app.server.on('request',(req,res)=>{if(req.url==='/v1/messages'&&req.method===(name==='broker_send'?'POST':'GET')){blocked=true;req.resume();return;}return handler(req,res);});
  const pending=tools[name].execute('call',args,undefined,undefined,ctx);await until(()=>blocked);
  const started=Date.now();await events.session_shutdown();const result=await pending;assert.ok(Date.now()-started<1000,'close must not wait normal HTTP retry timeout');
  assert.equal(result.details.error.code,'request_aborted');assert.equal(sender.operations.size,0);
  const reopened=make('sender');assert.equal(reopened.inbox.identity.client_id,id);assert.equal(reopened.inbox.unresolvedSends().length,name==='broker_send'?1:0);await reopened.close();
 });
});

test('accepted HTTP send plus failed local result commit reports unknown and recovers the original delivery',async t=>{
 const {f,make}=await fixture(t),recipient=make('recipient'),sender=make('sender');await recipient.client.register(metadata);await sender.start();t.after(()=>sender.close());t.after(()=>recipient.close());
 const request=sender.client.request.bind(sender.client);let accepted,inject=true;
 sender.client.request=async(method,path,options)=>{const result=await request(method,path,options);if(inject&&method==='POST'&&path==='/v1/messages'){accepted=result;inject=false;sender.inbox.failurePoint=point=>{if(point==='before_commit')throw Error('fixture local result write failure');};}return result;};
 const result=await createTools({client:sender.client}).broker_send({recipient_id:recipient.inbox.identity.client_id,text:'accepted before local failure'},{operationId:'native-known-call',operationStartedAt:f.now});
 sender.inbox.failurePoint=()=>{};
 assert.equal(result.error.code,'storage_unavailable');assert.equal(result.error.effect,'unknown','broker already accepted; a local rollback is not global not_applied');assert.equal('send_key' in result,false);
 const [pending]=sender.inbox.unresolvedSends();assert.ok(pending);await sender.recoverOutgoing();
 assert.equal(sender.inbox.outgoing(pending.key).result.message_id,accepted.message_id);assert.equal((await sender.client.sentHistory()).messages.length,1);
});

test('native bounded recovery skips expired backlog, reports unknown summary and preserves old operation identities',async t=>{
 const {f,make}=await fixture(t),recipient=make('recipient'),sender=make('sender');await recipient.client.register(metadata);await sender.start();await sender.recoverOutgoing();t.after(()=>sender.close());t.after(()=>recipient.close());
 const diagnostics=[];sender.onDiagnostic=event=>diagnostics.push(event);
 const request={recipient_id:recipient.inbox.identity.client_id,content:{type:'text/plain',text:'recovery stays opaque'}};
 for(let i=0;i<105;i++){const key=sender.inbox.prepareSend(request,{retryWindowSeconds:1});sender.inbox.markOutgoingAttempt(key);}
 f.advance(1000);
 const before=sender.inbox.db.prepare('SELECT * FROM outgoing ORDER BY key').all();
 const key=sender.client.prepareSend(request),original=sender.client.request.bind(sender.client);let accepted;
 sender.client.request=async(method,path,options)=>{const value=await original(method,path,options);if(method==='POST'&&path==='/v1/messages'){accepted=value;throw new LocalError('request_failed',{effect:'unknown'});}return value;};
 await assert.rejects(sender.client.sendPrepared(key),{code:'request_failed',effect:'unknown'});sender.client.request=original;
 const recovered=await sender.recoverOutgoing();
 assert.equal(recovered.length,2);assert.equal(recovered[0].result.message_id,accepted.message_id);assert.equal(recovered[0].result.acceptance_replayed,true);
 assert.equal(recovered[1].error.code,'retry_window_elapsed');assert.equal(recovered[1].error.effect,'unknown');assert.equal(recovered[1].count,105);
 assert.ok(diagnostics.some(event=>event.code==='outgoing_recovery_pending'),'expired summary remains visible as pending, not successful recovery');
 assert.doesNotMatch(JSON.stringify(recovered),/send_key|op_/);
 assert.deepEqual(sender.inbox.db.prepare('SELECT * FROM outgoing WHERE key<>? ORDER BY key').all(key),before,'expired unknowns retain identity, payload and retry deadline');
 assert.equal((await sender.client.sentHistory()).messages.length,1,'eligible intent recovers its original accepted message, without replacement');
 assert.deepEqual(await sender.recoverOutgoing(),[recovered[1]],'repeat pass reports the unresolved backlog without new sends');
});
