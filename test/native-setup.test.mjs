import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {nativeSetup,nativeBrokerSettings} from '../src/native-setup.mjs';
const secret='synthetic_'.padEnd(43,'A');
function fixture(t){const root=mkdtempSync(join(tmpdir(),'pi-native-setup-'));t.after(()=>rmSync(root,{recursive:true,force:true}));const env={PI_CODING_AGENT_DIR:join(root,'agent')};return{root,env,settings:nativeBrokerSettings(env)};}
test('explicit native setup keeps secrets out of settings and persists only validated URL',async t=>{
 const f=fixture(t),shown=[];let calls=0;
 const ctx={hasUI:true,ui:{input:async title=>{shown.push(title);return'https://broker.example';},confirm:async(...args)=>{shown.push(...args);return true;}}};
 const result=await nativeSetup(ctx,{env:f.env,privateInput:async()=>secret,pairingConnector:async options=>{calls++;assert.equal(options.pairingSecret,secret);assert.equal(options.clientType,'pi');return{connectionFile:join(f.root,'internally-generated.json')};}});
 assert.deepEqual(result,{connectionFile:join(f.root,'internally-generated.json'),brokerUrl:'https://broker.example'});assert.equal(calls,1);assert.equal(nativeBrokerSettings(f.env).read(),null);
 assert.equal(JSON.stringify(shown).includes(secret),false);
});
test('cancel, environment mismatch and departed session never initiate enrollment',async t=>{
 const f=fixture(t);let calls=0;const opts={env:f.env,privateInput:async()=>secret,pairingConnector:async()=>{calls++;}};
 assert.equal(await nativeSetup({hasUI:true,ui:{input:async()=>undefined} },opts),null);
 const ctx={hasUI:true,ui:{input:async()=> 'https://broker.example',confirm:async()=>true}};
 assert.equal(await nativeSetup(ctx,{...opts,stillCurrent:()=>false}),null);
 await assert.rejects(nativeSetup(ctx,{...opts,env:{...f.env,PSST_BROKER_URL:'https://other.example'}}),{code:'broker_origin_mismatch'});assert.equal(calls,0);
});
test('unknown enrollment failure never writes selection or schedules another attempt',async t=>{
 const f=fixture(t);let calls=0;const ctx={hasUI:true,ui:{input:async()=> 'https://broker.example',confirm:async()=>true}};
 await assert.rejects(nativeSetup(ctx,{env:f.env,privateInput:async()=>secret,pairingConnector:async()=>{calls++;throw Error('fixture unknown');}}));
 assert.equal(calls,1);assert.equal(f.settings.read(),null);
});
