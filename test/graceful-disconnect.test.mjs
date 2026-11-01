import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { PiBrokerSession } from '../src/session.mjs';
import { createTools } from '../vendor/broker/reference/tools.mjs';
import { httpFixture } from './fixtures/broker/test/helpers.mjs';
const metadata={name:'peer',model:{provider:null,id:null,source:'unknown'},project:null};
async function fixture(t){
 const f=await httpFixture(t),tokenFile=join(f.dir,'token');writeFileSync(tokenFile,f.a.token,{mode:0o600});
 const config={url:f.base,tokenFile,stateDirectory:join(f.dir,'state'),name:'Pi fixture'};
 return {f,make:id=>new PiBrokerSession({config,hostSessionId:id,currentSessionId:()=>id,clientOptions:{insecureDevelopment:true,now:()=>f.now,maxAttempts:1}})};
}
async function until(predicate){for(let i=0;i<300;i++){if(predicate())return;await delay(10);}throw Error('fixture delivery timed out');}

test('normal Pi shutdown promptly marks offline without retiring identity; resume retains pending inbox and accepts queued mail',async t=>{
 const {f,make}=await fixture(t);let a=make('conversation');const b=make('peer');t.after(()=>a.close());t.after(()=>b.close());await a.start();await b.client.register(metadata);
 const id=a.inbox.identity.client_id,peer=createTools({client:b.client});
 const before=await peer.broker_send({recipient_id:id,text:'retained pending'});await until(()=>a.inbox.head()?.message_id===before.message_id);
 await a.close();assert.equal((await b.client.listClients()).clients.some(c=>c.client_id===id),false);
 const offline=(await b.client.listClients({connected:false})).clients.find(c=>c.client_id===id);assert.equal(offline.connected,false);
 const queued=await peer.broker_send({recipient_id:id,text:'queued while absent'});assert.equal((await b.client.messageStatus(queued.message_id)).delivery_state,'queued');
 a=make('conversation');assert.equal(a.inbox.identity.client_id,id);assert.equal(a.inbox.head().message_id,before.message_id);await a.start();
 await until(()=>a.inbox.stats().pending_count===2);assert.equal((await b.client.listClients()).clients.find(c=>c.client_id===id).connected,true);
 const state=await a.client.request('GET',`/v1/sessions/${id}`,{session:false,idempotent:true});assert.equal(state.closed,false);assert.equal(a.inbox.head().message_id,before.message_id);
 assert.equal((await b.client.messageStatus(queued.message_id)).delivery_state,'delivered');
});

test('broker without advertised resumable disconnect retains safe lease-expiry fallback and never receives terminal close',async t=>{
 const {f,make}=await fixture(t),a=make('old-contract'),b=make('peer');t.after(()=>a.close());t.after(()=>b.close());await a.start();await b.client.register(metadata);
 const id=a.inbox.identity.client_id,attachment=a.client.attachment;
 a.inbox.setState('attachment',{...attachment,policy:{...attachment.policy,resumable_disconnect:false}});
 const original=a.client.request.bind(a.client);let disconnects=0,terminal=0;
 a.client.request=(method,path,options)=>{if(path.endsWith('/disconnect'))disconnects++;if(path.endsWith('/close'))terminal++;return original(method,path,options);};
 await a.close();assert.equal(disconnects,0);assert.equal(terminal,0);
 assert.equal((await b.client.listClients()).clients.find(c=>c.client_id===id).connected,true);
 f.advance(181000);assert.equal((await b.client.listClients({connected:false})).clients.find(c=>c.client_id===id).connected,false);
});
