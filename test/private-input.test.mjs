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
