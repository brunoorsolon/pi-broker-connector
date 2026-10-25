import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { PiBrokerSession } from '../src/session.mjs';
import { createCooperativeInbox } from '../src/cooperative-inbox.mjs';
import { createTools } from '../vendor/broker/reference/tools.mjs';
import { httpFixture } from './fixtures/broker/test/helpers.mjs';

async function until(fn) { const deadline = Date.now() + 3000; while (!fn()) { if (Date.now() > deadline) throw Error('Timed out'); await delay(10); } }
test('two Pi sessions real broker A→B→A; read ACK advances FIFO; resume keeps identity', async t => {
  const f = await httpFixture(t);
  const tokenFile = join(f.dir, 'token'); writeFileSync(tokenFile, f.a.token, {mode:0o600});
  const config = { url:f.base, tokenFile, stateDirectory:join(f.dir,'clients'), name:'Pi test' };
  const make = id => new PiBrokerSession({config,hostSessionId:id,currentSessionId:()=>id,clientOptions:{insecureDevelopment:true,now:()=>f.now,maxAttempts:1}});
  const a=make('native-A'), b=make('native-B');
  t.after(async()=>{await a.close();await b.close();});
  await a.start(); await b.start();
  const ta={...createTools({client:a.client}),...createCooperativeInbox({inbox:a.inbox})};
  const tb={...createTools({client:b.client}),...createCooperativeInbox({inbox:b.inbox})};
  assert.equal((await ta.broker_list_clients()).clients.length,2);
  const sent=await ta.broker_send({recipient_id:b.inbox.identity.client_id,text:'ping',send_key:'same-request-0001'});
  assert.ok(sent.message_id);
  assert.equal((await ta.broker_send({recipient_id:b.inbox.identity.client_id,text:'ping',send_key:'same-request-0001'})).message_id,sent.message_id);
  await until(()=>b.inbox.head());
  const received=await tb.broker_receive(); assert.match(received.message,/ping/);
  const ack=await tb.broker_acknowledge({message_id:received.message_id,receipt_token:received.receipt_token});
  assert.equal(ack.native_acceptance_recorded,false); assert.equal((await tb.broker_receive()).message,null);
  await tb.broker_send({recipient_id:a.inbox.identity.client_id,text:'pong',reply_to_message_id:sent.message_id});
  await until(()=>a.inbox.head()); assert.match((await ta.broker_receive()).message,/pong/);
  assert.equal((await ta.broker_message_status({message_id:sent.message_id})).delivery_state,'delivered');
  const old=a.inbox.identity.client_id; await a.close(); const resumed=make('native-A');
  t.after(()=>resumed.close()); await resumed.start(); assert.equal(resumed.inbox.identity.client_id,old);
  assert.match((await createCooperativeInbox({inbox:resumed.inbox}).broker_receive()).message,/pong/);
});
