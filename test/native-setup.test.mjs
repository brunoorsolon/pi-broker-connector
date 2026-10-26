import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {nativeSetup,nativeBrokerSettings} from '../src/native-setup.mjs';
function fixture(t){const root=mkdtempSync(join(tmpdir(),'pi-native-setup-'));t.after(()=>rmSync(root,{recursive:true,force:true}));const env={PI_CODING_AGENT_DIR:join(root,'agent')};return{root,env,settings:nativeBrokerSettings(env)};}
test('explicit native setup asks only URL and delegates durable request creation',async t=>{
 const f=fixture(t),shown=[];let calls=0;
 const ctx={hasUI:true,ui:{input:async title=>{shown.push(title);return'https://broker.example';},confirm:async()=>{throw Error('unexpected secret or confirmation');}}};
 const result=await nativeSetup(ctx,{env:f.env,approvalClient:{readApprovalState:async()=>null,beginApproval:async options=>{calls++;assert.equal(options.clientType,'pi');assert.equal(options.brokerUrl,'https://broker.example');assert.equal('pairingSecret' in options,false);return{state:'pending',requestId:'request-a'};}}});
 assert.equal(result.state,'pending');assert.equal(calls,1);assert.deepEqual(shown,['Psst broker HTTPS URL']);assert.equal(f.settings.read(),null);
});
test('cancel, environment mismatch and departed session never initiate enrollment',async t=>{
 const f=fixture(t);let calls=0;const opts={env:f.env,approvalClient:{readApprovalState:async()=>null,beginApproval:async()=>{calls++;}}};
 assert.equal(await nativeSetup({hasUI:true,ui:{input:async()=>undefined}},opts),null);
 const ctx={hasUI:true,ui:{input:async()=> 'https://broker.example'}};
 assert.equal(await nativeSetup(ctx,{...opts,stillCurrent:()=>false}),null);
 await assert.rejects(nativeSetup(ctx,{...opts,env:{...f.env,PSST_BROKER_URL:'https://other.example'}}),{code:'broker_origin_mismatch'});assert.equal(calls,0);
});
test('pending resumes same request while terminal replacement requires explicit confirmation',async t=>{
 const f=fixture(t);let confirmed=0,options;
 const ctx={hasUI:true,ui:{input:async()=> 'https://broker.example',confirm:async()=>{confirmed++;return true;}}};
 for(const state of ['pending','approved','denied','expired','revoked']){
  await nativeSetup(ctx,{env:f.env,approvalClient:{readApprovalState:async()=>({state,requestId:'prior'}),beginApproval:async o=>{options=o;return{state:'pending',requestId:'next'};}}});
  assert.equal(options.replaceRequestId,state==='pending'?undefined:'prior');
 }
 assert.equal(confirmed,4);
});
test('uncertain result never writes selection or creates a replacement',async t=>{
 const f=fixture(t);let calls=0;const ctx={hasUI:true,ui:{input:async()=> 'https://broker.example'}};
 await assert.rejects(nativeSetup(ctx,{env:f.env,approvalClient:{readApprovalState:async()=>null,beginApproval:async()=>{calls++;throw Error('fixture unknown');}}}));
 assert.equal(calls,1);assert.equal(f.settings.read(),null);
});
