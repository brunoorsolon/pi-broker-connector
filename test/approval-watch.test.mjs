import test from 'node:test';
import assert from 'node:assert/strict';
import {ApprovalWatch} from '../src/approval-watch.mjs';
test('approval watcher polls only existing request, stops on terminal and ignores canceled late response',async()=>{
 let resolve,calls=0,states=[];
 const w=new ApprovalWatch({poll:()=>{calls++;return new Promise(r=>resolve=r);},onState:r=>states.push(r),onError:()=>{},isCurrent:()=>true});
 const pending=w.tick();w.stop();resolve({state:'approved'});await pending;
 assert.equal(calls,1);assert.equal(states.length,0);
 const terminal=new ApprovalWatch({poll:async()=>({state:'denied'}),onState:r=>states.push(r),onError:()=>{},isCurrent:()=>true});
 await terminal.tick();assert.equal(terminal.stopped,true);assert.equal(states[0].state,'denied');
});
test('uncertain transport retries polling without enrollment and stale session does not poll',async()=>{
 let errors=0,calls=0;
 const w=new ApprovalWatch({poll:async()=>{calls++;throw Error();},onState:()=>{},onError:()=>errors++,isCurrent:()=>true,delay:1});
 assert.equal(w.delay,2000);await w.tick();w.stop();assert.equal(errors,1);assert.equal(calls,1);
 const stale=new ApprovalWatch({poll:async()=>calls++,onState:()=>{},onError:()=>{},isCurrent:()=>false});await stale.tick();assert.equal(calls,1);
});
test('corrupt durable cancellation state stops watcher without an unhandled rejection',async()=>{
 let calls=0,errors=0;const watcher=new ApprovalWatch({poll:async()=>calls++,onState:()=>{},onError:()=>errors++,isCurrent:()=>{throw Error('private fixture');}});
 await watcher.tick();assert.equal(calls,0);assert.equal(errors,1);assert.equal(watcher.stopped,true);
});
test('shared helper retry-after cooldown is honored and successful pending resets baseline',async()=>{
 let calls=0;const scheduled=[];const watcher=new ApprovalWatch({poll:async()=>{if(!calls++)throw Object.assign(Error('rate_limited'),{retryable:true,retryAfterMs:60000});return{state:'pending'};},onState:()=>{},onError:()=>{},isCurrent:()=>true});
 watcher.start=delay=>scheduled.push(delay);await watcher.tick();await watcher.tick();assert.deepEqual(scheduled,[60000,2000]);watcher.stop();
});
