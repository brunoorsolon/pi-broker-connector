// Actual official Pi 1.4 loader, history persistence and CustomMessageComponent.
// No provider account, network model, simulated terminal injection or new delivery.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { nativeMessage } from '../src/message-format.mjs';
import { findPersistedReceipt } from '../src/native-delivery.mjs';
import { cardEnvelope } from './card-fixture.mjs';
const host=process.env.PI_TEST_INSTALL;if(!host)throw Error('Set PI_TEST_INSTALL to official Pi 1.4.0');
const base=join(host,'node_modules/@earendil-works/pi-coding-agent');
assert.equal(JSON.parse(readFileSync(join(base,'package.json'),'utf8')).version,'1.4.0');
const root=mkdtempSync(join(tmpdir(),'pi-card-host-'));
process.env.HOME=root;process.env.PI_CODING_AGENT_DIR=join(root,'agent');process.env.PI_OFFLINE='1';
const load=path=>import(pathToFileURL(join(base,path)).href);
const {loadExtensions}=await load('dist/core/extensions/loader.js');
const {CustomMessageComponent}=await load('dist/modes/interactive/components/custom-message.js');
const {initTheme}=await load('dist/modes/interactive/theme/theme.js');
const {SessionManager}=await load('dist/core/session-manager.js');
const {createCustomMessage,convertToLlm}=await load('dist/core/messages.js');
const {stripTerminalSequences,visibleWidth}=await import(pathToFileURL(join(host,'node_modules/@earendil-works/pi-tui/dist/index.js')).href);

test('official Pi renders readable resumed history, preserving exact model content and persisted receipts',async t=>{
 t.after(()=>rmSync(root,{recursive:true,force:true}));initTheme('dark');
 const loaded=await loadExtensions([join(process.cwd(),'extensions/psst.ts')],root);assert.deepEqual(loaded.errors,[]);
 const renderer=loaded.extensions[0].messageRenderers.get('psst-agent-message');assert.equal(typeof renderer,'function');
 const manager=SessionManager.create(root,join(root,'sessions'));
 manager.appendMessage({role:'user',content:'fixture history only',timestamp:Date.now()});
 const contents=[nativeMessage(cardEnvelope()),readFileSync(new URL('./fixtures/legacy-native-v0.4.txt',import.meta.url),'utf8').trimEnd().replaceAll('__MESSAGE_ID__','11111111-1111-4111-8111-111111111111').replaceAll('__SENDER_ID__','33333333-3333-4333-8333-333333333333')];
 const offsets=[],ids=[];
 for(let i=0;i<contents.length;i++){
  offsets.push(readFileSync(manager.getSessionFile()).length);
  ids.push(manager.appendCustomMessageEntry('psst-agent-message',contents[i],true,{message_id:cardEnvelope().message_id,injection_id:`fixture-${i}`,client_id:cardEnvelope().recipient_id}));
 }
 const bytes=readFileSync(manager.getSessionFile());
 const reopened=SessionManager.open(manager.getSessionFile());
 const before=convertToLlm(reopened.buildSessionContext().messages),proof=[];
 const entries=reopened.getBranch().filter(row=>row.type==='custom_message');assert.equal(entries.length,2);
 for(let i=0;i<entries.length;i++){
  const row=entries[i],m=createCustomMessage(row.customType,row.content,row.display,row.details,row.timestamp);
  const original=structuredClone(m),component=new CustomMessageComponent(m,renderer);
  for(const expanded of [false,true]){
   component.setExpanded(expanded);component.invalidate();const rows=component.render(80);
   assert.ok(rows.every(line=>visibleWidth(line)<=80));
   const plain=rows.map(line=>stripTerminalSequences(line).trimEnd()).join('\n').replace(/^\n+|\n+$/g,'');
   assert.match(plain,/Psst · mensagem de outro agente/);assert.doesNotMatch(plain,/"message_id"|"sender"|"authority"/);
   assert.ok(plain.includes(i===0?'A revisão terminou. Os testes passaram.':'hello'));
   assert.equal(plain.includes('ID da mensagem:'),expanded);
   proof.push(`=== ${i===0?'compact-v1':'legacy-v1'} / ${expanded?'expanded':'default'} / 80 columns ===\n${plain}`);
  }
  assert.deepEqual(m,original);
  assert.equal(findPersistedReceipt(manager.getSessionFile(),offsets[i],{messageId:cardEnvelope().message_id,injectionId:`fixture-${i}`,clientId:cardEnvelope().recipient_id,content:contents[i]}),ids[i]);
 }
 assert.deepEqual(readFileSync(manager.getSessionFile()),bytes,'rendering must not rewrite the transcript');
 assert.deepEqual(convertToLlm(reopened.buildSessionContext().messages),before,'rendering must not change model input');
 const output=proof.join('\n\n')+'\n';
 if(process.env.PI_RENDER_PROOF)writeFileSync(process.env.PI_RENDER_PROOF,output);
 assert.equal(output,readFileSync(new URL('./fixtures/native-card-terminal.txt',import.meta.url),'utf8'));
});
