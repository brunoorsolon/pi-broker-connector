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
test('shared pairing helper exactly matches its separately pinned upstream commit',()=>{
 const root=new URL('../vendor/broker/',import.meta.url);
 const pin=JSON.parse(readFileSync(new URL('ENROLLMENT_UPSTREAM.json',root),'utf8'));
 assert.equal(pin.commit,'4a9d604e1107a92c94f8b8a2f0e1cb2d1e2ecc39');
 const bytes=readFileSync(new URL(pin.path,root));
 assert.equal(createHash('sha256').update(bytes).digest('hex'),pin.sha256);
 assert.equal(createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex'),pin.git_blob);
});
test('admin-approval helper matches exact reviewed upstream anchor',()=>{
 const root=new URL('../vendor/broker/',import.meta.url),pin=JSON.parse(readFileSync(new URL('APPROVAL_UPSTREAM.json',root),'utf8'));
 assert.equal(pin.commit,'72f5d2d1b834e02cfb6b2f7dc11c6f1a55729344');
 const bytes=readFileSync(new URL(pin.path,root));
 assert.equal(createHash('sha256').update(bytes).digest('hex'),pin.sha256);
 assert.equal(createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex'),pin.git_blob);
});
