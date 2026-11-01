import test from 'node:test';
import assert from 'node:assert/strict';
import { toolOperationContext } from '../src/tool-operation.mjs';
const stamp='2026-11-01T12:00:00.000Z';
const entry=(id='entry-A',callId='call-A')=>({type:'message',id,timestamp:stamp,message:{role:'assistant',content:[{type:'toolCall',id:callId,name:'broker_send',arguments:{text:'x'}}]}});
const context=branch=>({sessionManager:{getSessionId:()=> 'session-A',getBranch:()=>branch}});
test('native operation identity is stable across reload and distinct for new assistant calls, never content-based',()=>{
 const e=entry(),a=toolOperationContext(context([e]),'call-A','broker_send');
 assert.deepEqual(a,toolOperationContext(context([structuredClone(e)]),'call-A','broker_send'));
 assert.equal(a.operationStartedAt,Date.parse(stamp));assert.notEqual(a.operationId,toolOperationContext(context([e,entry('entry-B')]),'call-A','broker_send').operationId);
 const changed=structuredClone(e);changed.message.content[0].arguments.text='changed';
 assert.equal(toolOperationContext(context([changed]),'call-A','broker_send').operationId,a.operationId,'payload change stays same operation for ledger conflict check');
});
test('missing, wrong, ambiguous or historical host call fails closed without a fresh timestamp',()=>{
 for(const branch of [[],[entry('x','other')],[{...entry(),timestamp:'invalid'}],[{...entry(),message:{role:'assistant',content:[]}}],[entry(),{...entry('new'),message:{role:'assistant',content:[{type:'text',text:'done'}]}}],[{...entry(),message:{role:'assistant',content:[...entry().message.content,...entry().message.content]}}]])
  assert.throws(()=>toolOperationContext(context(branch),'call-A','broker_send'),{code:'invalid_configuration'});
 assert.throws(()=>toolOperationContext(context([entry()]),'call-A','broker_resend'),{code:'invalid_configuration'});
 assert.throws(()=>toolOperationContext({sessionManager:{getSessionId:()=> 'a'}},'call-A','broker_send'),{code:'invalid_configuration'});
});
