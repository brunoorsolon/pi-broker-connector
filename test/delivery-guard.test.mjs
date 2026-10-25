import test from 'node:test';
import assert from 'node:assert/strict';
import { PiBrokerSession } from '../src/session.mjs';
test('delivery permission tracks transport pause/close without changing native ownership',()=>{
 const session={closed:false,hostSessionId:'same-native',currentSessionId:()=> 'same-native',runtime:{paused:false,closed:false},isAlive:PiBrokerSession.prototype.isAlive};
 const allowed=()=>PiBrokerSession.prototype.deliveryAllowed.call(session);
 assert.equal(allowed(),true);
 session.runtime.paused=true;assert.equal(allowed(),false);assert.equal(session.isAlive(),true);
 session.runtime.paused=false;session.runtime.closed=true;assert.equal(allowed(),false);assert.equal(session.isAlive(),true);
 session.runtime.closed=false;assert.equal(allowed(),true);
 session.currentSessionId=()=> 'different-native';assert.equal(allowed(),false);
});
test('real runtime auth/protocol error handler fences delivery without ending native ownership',async()=>{
 const {AdapterRuntime}=await import('../vendor/broker/reference/runtime.mjs');
 for(const code of ['unauthenticated','forbidden','invalid_response']) {
  const session={closed:false,hostSessionId:'native',currentSessionId:()=> 'native',isAlive:PiBrokerSession.prototype.isAlive};
  session.runtime=new AdapterRuntime({client:{inbox:{}},verifySession:()=>session.isAlive(),isAlive:()=>session.isAlive()});
  assert.equal(PiBrokerSession.prototype.deliveryAllowed.call(session),true);
  await session.runtime.handleTransportError({code});
  assert.equal(PiBrokerSession.prototype.deliveryAllowed.call(session),false);assert.equal(session.isAlive(),true);assert.equal(session.runtime.closed,false);
 }
});
