import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, appendFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Inbox, newSessionIdentity } from '../vendor/broker/reference/inbox.mjs';
import { NativeDelivery } from '../src/native-delivery.mjs';
const now=Date.now();
function fixture(t) {
 const directory=mkdtempSync(join(tmpdir(),'pi-native-'));const identity=newSessionIdentity('pi');
 let inbox=new Inbox({directory,identity}),idle=true,pending=false,alive=true,allowed=true,behavior='persist';
 const file=join(directory,'session.jsonl'),sent=[],diagnostics=[];
 writeFileSync(file,JSON.stringify({type:'session',id:'native-A'})+'\n');
 const session={get inbox(){return inbox;},isAlive:()=>alive,deliveryAllowed:()=>allowed};
 const ctx={isIdle:()=>idle,hasPendingMessages:()=>pending,sessionManager:{getSessionFile:()=>file}};
 const pi={sendMessage:(message,options)=>{sent.push({message,options});if(behavior==='throw')throw Error('native failed');if(behavior==='persist')appendFileSync(file,JSON.stringify({type:'custom_message',id:randomUUID(),...message})+'\n');}};
 const make=()=>new NativeDelivery({session,pi,ctx,diagnostic:c=>diagnostics.push(c)});
 let delivery=make();t.after(()=>{delivery.stop();inbox.close();rmSync(directory,{recursive:true,force:true});});
 const envelope=n=>({protocol_version:'1',message_id:randomUUID(),recipient_id:identity.client_id,recipient_sequence:n,sender:{client_id:randomUUID(),client_type:'pi',name:'peer',model:{provider:null,id:null,source:'unknown'},project:null,metadata_revision:1},origin:'broker_agent',authority:'untrusted_agent_input',content:{type:'text/plain',text:'hello'},accepted_at:new Date(now).toISOString(),expires_at:new Date(now+86400000).toISOString(),correlation_id:null,reply_to_message_id:null});
 return {get inbox(){return inbox;},get delivery(){return delivery;},file,sent,diagnostics,envelope,identity,ctx,setIdle:v=>idle=v,setPending:v=>pending=v,setAlive:v=>alive=v,setAllowed:v=>allowed=v,setBehavior:v=>behavior=v,reopen(){delivery.stop();inbox.close();inbox=new Inbox({directory,identity});delivery=make();}};
}
test('automatic native delivery waits for idle; persisted custom entry advances FIFO, not explicit read',t=>{
 const f=fixture(t),a=f.envelope(1),b=f.envelope(2);f.inbox.accept(a);f.inbox.accept(b);
 f.setIdle(false);f.delivery.tick();assert.equal(f.sent.length,0);f.setIdle(true);f.setPending(true);f.delivery.tick();assert.equal(f.sent.length,0);f.setPending(false);
 f.delivery.tick();assert.equal(f.sent.length,1);assert.equal(f.inbox.head().state,'injecting');
 assert.deepEqual(f.sent[0].options,{triggerTurn:true,deliverAs:'followUp'});assert.match(f.sent[0].message.content,/untrusted agent input/);
 f.delivery.tick();assert.equal(f.inbox.head().message_id,b.message_id);assert.equal(f.sent.length,1);
 const row=f.inbox.db.prepare('SELECT native_receipt FROM inbox WHERE message_id=?').get(a.message_id);assert.match(row.native_receipt,/^pi:/);
 f.delivery.tick();assert.equal(f.sent.length,2);f.delivery.tick();assert.equal(f.inbox.head(),null);
});
test('native return or exception without persisted entry is uncertain and never retried after reopen',t=>{
 const f=fixture(t);f.inbox.accept(f.envelope(1));f.setBehavior('memory');f.delivery.tick();f.delivery.tick();assert.equal(f.sent.length,1);f.reopen();f.delivery.tick();assert.equal(f.sent.length,1);
 const message=f.sent[0].message;appendFileSync(f.file,JSON.stringify({type:'custom_message',id:'actual-entry',...message})+'\n');f.delivery.tick();assert.equal(f.inbox.head(),null);
 f.inbox.accept(f.envelope(2));f.setBehavior('throw');f.delivery.tick();f.delivery.tick();assert.equal(f.sent.length,2);assert.match(f.inbox.head().state,/injecting|uncertain/);
});
test('manual/disconnected/stopped/departed sessions never inject',t=>{
 const f=fixture(t);f.inbox.accept(f.envelope(1));f.delivery.setMode('manual');f.delivery.tick();assert.equal(f.sent.length,0);f.reopen();assert.equal(f.delivery.mode,'manual');
 f.delivery.setMode('auto');f.delivery.setting('disconnected','true');f.delivery.tick();assert.equal(f.sent.length,0);f.delivery.setting('disconnected','false');f.setAlive(false);f.delivery.tick();assert.equal(f.sent.length,0);f.setAlive(true);f.delivery.stop();f.delivery.tick();assert.equal(f.sent.length,0);
});
test('wrong/truncated/oversized append evidence cannot acknowledge uncertain native handoff',t=>{
 const f=fixture(t);f.inbox.accept(f.envelope(1));f.setBehavior('memory');f.delivery.tick();const message=f.sent[0].message;
 appendFileSync(f.file,JSON.stringify({type:'custom_message',id:'wrong',...message,details:{...message.details,injection_id:randomUUID()}})+'\n');f.delivery.tick();assert.ok(f.inbox.head());
 writeFileSync(f.file,'');f.delivery.tick();assert.ok(f.inbox.head());
 writeFileSync(f.file,'x'.repeat(4*1024*1024+100)+'\n'+JSON.stringify({type:'custom_message',id:'late',...message})+'\n');f.delivery.tick();assert.ok(f.inbox.head());assert.equal(f.sent.length,1);
});

test('self-addressed envelope never creates an automatic feedback turn',t=>{
 const f=fixture(t),message=f.envelope(1);message.sender.client_id=f.identity.client_id;f.inbox.accept(message);f.delivery.tick();assert.equal(f.sent.length,0);assert.equal(f.inbox.head().state,'pending');assert.equal(f.diagnostics.at(-1),'self_message_requires_manual');
});
test('storage failure never submits before committed handoff; unknown commit never auto retries',t=>{
 const f=fixture(t);f.inbox.accept(f.envelope(1));
 f.inbox.failurePoint=point=>{if(point==='before_commit')throw Error('fixture storage failure');};f.delivery.tick();assert.equal(f.sent.length,0);assert.equal(f.inbox.head().state,'pending');
 f.inbox.failurePoint=point=>{if(point==='after_commit')throw Error('fixture unknown commit');};f.delivery.tick();assert.equal(f.sent.length,0);assert.equal(f.inbox.head().state,'injecting');
 f.inbox.failurePoint=()=>{};f.delivery.tick();f.reopen();f.delivery.tick();assert.equal(f.sent.length,0);assert.equal(f.diagnostics.at(-1),'native_handoff_unknown');
});

test('observed auth pause blocks new turns but reconciles prior handoff; reconnect resumes pending FIFO',t=>{
 const f=fixture(t);const first=f.envelope(1),second=f.envelope(2);f.inbox.accept(first);f.inbox.accept(second);
 f.setAllowed(false);f.delivery.tick();assert.equal(f.sent.length,0);assert.equal(f.inbox.head().state,'pending');
 assert.equal(f.inbox.db.prepare('SELECT native_receipt FROM inbox WHERE message_id=?').get(first.message_id).native_receipt,null);
 f.setAllowed(true);f.delivery.tick();assert.equal(f.sent.length,1);
 f.setAllowed(false);f.delivery.tick();assert.equal(f.inbox.head().message_id,second.message_id,'historical receipt can reconcile during auth pause');
 f.delivery.tick();assert.equal(f.sent.length,1);assert.equal(f.inbox.head().state,'pending');
 f.reopen();f.delivery.tick();assert.equal(f.sent.length,1);f.setAllowed(true);f.delivery.tick();assert.equal(f.sent.length,2);
});
