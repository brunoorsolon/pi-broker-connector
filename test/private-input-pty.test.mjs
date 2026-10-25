import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const absolute=p=>fileURLToPath(new URL(p,import.meta.url));
for(const protocol of ['kitty','legacy'])for(const key of ['enter','escape','ctrlc']){
 test(`actual PTY ${protocol} ${key}: negotiated host input closes masked field without disclosure`,()=>{
  const child=spawnSync('python3',[absolute('../scripts/private-input-pty.py'),process.execPath,absolute('../scripts/private-input-pty.mjs'),absolute('../src/private-input.mjs'),key,protocol],{encoding:'utf8',timeout:8000});
  assert.equal(child.status,0,child.stderr);const r=JSON.parse(child.stdout);assert.equal(r.sent,true);assert.equal(r.query,true);assert.equal(r.exit,0);assert.equal(r.secret_rendered,false);
  assert.deepEqual(r.result,{kind:key==='enter'?'submit':'cancel',valid:true,negotiated:protocol==='kitty'});
 });
}
