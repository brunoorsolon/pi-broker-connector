import test from 'node:test';
import assert from 'node:assert/strict';
import {maskedPairingComponent,promptPairingSecret} from '../src/private-input.mjs';
const secret='synthetic_'.padEnd(43,'A');
test('native private field never renders secret and returns only on explicit submit',()=>{
 let result;const c=maskedPairingComponent({done:v=>result=v,requestRender(){}});
 c.handleInput('\x1b[200~'+secret+'\x1b[201~');
 assert.equal(result,undefined);assert.equal(c.render(120).join('\n').includes(secret),false);
 assert.equal(c.render(120)[1],'*'.repeat(43));c.handleInput('\r');assert.equal(result,secret);assert.equal(c.render(120)[1],'');
});
test('cancel/invalid/control/oversize and noninteractive host never expose or submit',async()=>{
 let result='unset';const c=maskedPairingComponent({done:v=>result=v,requestRender(){}});
 for(const data of ['x'.repeat(44),'\x1b[31m','abc\nsecret'])c.handleInput(data);
 assert.equal(c.render(120)[1],'');c.handleInput('short');c.handleInput('\r');assert.equal(result,'unset');
 c.handleInput('\x1b');assert.equal(result,undefined);assert.equal(c.render(120)[1],'');
 await assert.rejects(promptPairingSecret({hasUI:false}),{code:'native_private_input_unavailable'});
});

test('legacy, Kitty CSI-u and xterm modified-key cancellation work once, including during paste',()=>{
 for(const data of ['\x1b','\x03','\x1b[27u','\x1b[27;1u','\x1b[27;1:1u','\x1b[99;5u','\x1b[99;5:1u','\x1b[27;1;27~','\x1b[27;5;99~'])for(const pasting of [false,true]){
  const calls=[];const c=maskedPairingComponent({done:v=>calls.push(v),requestRender(){}});c.handleInput('partial');if(pasting)c.handleInput('\x1b[200~');
  c.handleInput(data);assert.deepEqual(calls,[undefined],JSON.stringify(data));assert.equal(c.render(120)[1],'');c.handleInput(data);c.handleInput(secret);assert.equal(calls.length,1);
 }
});
test('legacy, keypad and Kitty Enter submit only complete synthetic input',()=>{
 for(const data of ['\r','\n','\x1bOM','\x1b[13u','\x1b[13;1u','\x1b[13;1:1u']){
  const calls=[];const c=maskedPairingComponent({done:v=>calls.push(v),requestRender(){}});c.handleInput(secret);c.handleInput(data);assert.deepEqual(calls,[secret],JSON.stringify(data));assert.ok(!c.render(120).join('').includes(secret));
 }
});
test('encoded printable keys and backspace; release events never duplicate or close',()=>{
 const calls=[];const c=maskedPairingComponent({done:v=>calls.push(v),requestRender(){}});
 c.handleInput('\x1b[97u');c.handleInput('\x1b[97;1:3u');assert.equal(c.render(120)[1],'*');
 c.handleInput('\x1b[98:66;2u');assert.equal(c.render(120)[1],'**');
 for(const key of ['\x1b[13;1:3u','\x1b[27;1:3u','\x1b[99;5:3u','\x1b[127;1:3u'])c.handleInput(key);
 assert.equal(calls.length,0);assert.equal(c.render(120)[1],'**');
 c.handleInput('\x1b[127u');assert.equal(c.render(120)[1],'*');c.handleInput('\x7f');assert.equal(c.render(120)[1],'');
 c.handleInput('a');c.handleInput('\b');assert.equal(c.render(120)[1],'');
 c.handleInput(secret);c.handleInput('\x1b[13u');assert.deepEqual(calls,[secret]);
});
test('split bracketed paste is masked and commits atomically; cannot auto-submit',()=>{
 const calls=[];const c=maskedPairingComponent({done:v=>calls.push(v),requestRender(){}});
 c.handleInput('\x1b[200~');c.handleInput(secret.slice(0,20));c.handleInput('\x1b[13u');assert.equal(calls.length,0);c.handleInput(secret.slice(20));c.handleInput('\x1b[201~');
 assert.equal(c.render(120)[1],'*'.repeat(43));assert.equal(calls.length,0);c.handleInput('\r');assert.deepEqual(calls,[secret]);
});
test('invalid paste, embedded controls and trailing input do not leak or invoke submit/cancel',()=>{
 for(const parts of [[secret+'\r'],[secret,'\x1b[201~\r'],['abc\x1b[27u'],['A'.repeat(44)]]){
  const calls=[];const c=maskedPairingComponent({done:v=>calls.push(v),requestRender(){}});c.handleInput('\x1b[200~');for(const part of parts)c.handleInput(part);c.handleInput('\x1b[201~');assert.equal(calls.length,0);assert.equal(c.render(120)[1],'');
  c.handleInput('\r');assert.match(c.render(120)[2],/43-character/);assert.equal(calls.length,0);c.dispose();c.handleInput(secret);assert.equal(c.render(120)[1],'');
 }
});
