import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
test('vendored wire/runtime files exactly match pinned public broker commit',()=>{
 const root=new URL('../vendor/broker/',import.meta.url);
 const pin=JSON.parse(readFileSync(new URL('UPSTREAM.json',root),'utf8'));
 for(const [file,sha] of Object.entries(pin.files)){
  const b=readFileSync(new URL(file,root));
  assert.equal(createHash('sha1').update(`blob ${b.length}\0`).update(b).digest('hex'),sha,file);
 }
});
