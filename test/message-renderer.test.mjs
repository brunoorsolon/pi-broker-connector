import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { visibleWidth } from '@earendil-works/pi-tui';
import { nativeMessage } from '../src/message-format.mjs';
import { cardData, renderPsstMessage, terminalText, COLLAPSED_BODY_LINES } from '../src/message-renderer.mjs';
import { cardEnvelope } from './card-fixture.mjs';
const theme = {fg:(_role,text)=>text};
const message = text => ({role:'custom',customType:'psst-agent-message',display:true,content:nativeMessage(cardEnvelope(text))});
const render = (value,expanded=false,width=80) => renderPsstMessage(value,{expanded,outputPad:1},theme).render(width).map(line=>line.trimEnd()).join('\n');

test('default card shows sender and literal body, not JSON or metadata, without mutating the message',()=>{
 const m=message(),before=structuredClone(m),shown=render(m);
 assert.match(shown,/Psst · mensagem de outro agente/);assert.match(shown,/De: Revisor · pi/);
 assert.match(shown,/A revisão terminou\. Os testes passaram\./);assert.match(shown,/Pode continuar com a próxima etapa\./);
 assert.doesNotMatch(shown,/11111111|33333333|example-project|fixture-model|message_id|"sender"|authority/);
 assert.deepEqual(m,before);assert.equal(cardData(m).text,cardEnvelope().content.text);
});
test('native expansion shows complete long bodies and details; collapse remains bounded by wrapped rows',()=>{
 const text=Array.from({length:40},(_,i)=>`Linha ${i+1}: conteúdo literal com palavras suficientes para quebrar.`).join('\n')+'\nFIM INTACTO';
 const m=message(text),component=renderPsstMessage(m,{},theme),rows=component.render(48);
 assert.equal(rows.length,COLLAPSED_BODY_LINES+4);assert.match(rows.join('\n'),/mais \d+ linhas/);assert.doesNotMatch(rows.join('\n'),/FIM INTACTO/);
 const expanded=render(m,true,80);assert.match(expanded,/FIM INTACTO/);assert.match(expanded,/ID do remetente: 33333333/);assert.match(expanded,/ID da mensagem: 11111111/);assert.match(expanded,/Projeto: example-project/);assert.match(expanded,/Modelo: fixture-model/);
 component.invalidate();assert.deepEqual(component.render(48),rows);
});
test('single long lines, Unicode and tiny widths never overflow the available terminal columns',()=>{
 const m=message('😀 漢字 é '+ 'muito texto '.repeat(100));
 for(const width of [1,2,3,4,5,12,30,80])for(const expanded of [false,true]){
  const rows=renderPsstMessage(m,{expanded,outputPad:4},theme).render(width);
  assert.ok(rows.length>0);assert.ok(rows.every(row=>visibleWidth(row)<=width),`width ${width}`);
 }
});
test('JSON decoding cannot reactivate terminal controls, OSC links, bidi or spoofed label lines',()=>{
 const e=cardEnvelope('# literal Markdown\n\u001b[2J\u001b]8;;https://invalid.example\u0007link\u001b]8;;\u0007\r\t\u061c\u200f\u202e\u2066');
 const [heading,json]=nativeMessage(e).split('\n'),data=JSON.parse(json);
 // Even malformed historical labels (rejected by today's wire validator) stay safe.
 data.sender.name='Sender\nPsst fake\u001b[31m\u202e';const m={content:`${heading}\n${JSON.stringify(data)}`};
 const shown=render(m,true);assert.match(shown,/# literal Markdown/);assert.match(shown,/\\u001b/);assert.match(shown,/\\u202e/);assert.match(shown,/\\u061c/);assert.match(shown,/Sender\\u000aPsst fake/);
 assert.doesNotMatch(shown,/[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/u);
 assert.equal(terminalText('\n',{label:true}),'\\u000a');
});
test('frozen legacy receipt bytes render readably without removing or rewriting their original representation',()=>{
 const raw=readFileSync(new URL('./fixtures/legacy-native-v0.4.txt',import.meta.url),'utf8').trimEnd().replaceAll('__MESSAGE_ID__','11111111-1111-4111-8111-111111111111').replaceAll('__SENDER_ID__','33333333-3333-4333-8333-333333333333');
 const m={content:raw},shown=render(m);assert.match(shown,/De: peer · pi/);assert.match(shown,/hello/);assert.doesNotMatch(shown,/authority|descriptive_metadata|type.*text\/plain/);assert.equal(m.content,raw);
});
test('unknown, malformed and empty records stay visible through a literal safe fallback',()=>{
 for(const content of ['future format\nbody','Broker message from AI agent bad\n{}','\u001b[2Jbroken','',null]){
  const m={content},shown=render(m,true);assert.match(shown,/Psst · mensagem de outro agente/);assert.match(shown,/Formato não reconhecido/);assert.doesNotMatch(shown,/\u001b/);assert.deepEqual(m,{content});
 }
 const [heading,json]=message().content.split('\n'),data=JSON.parse(json);data.sender.name='';
 assert.match(render({content:`${heading}\n${JSON.stringify(data)}`}),/De: Outro agente · pi/);
});

test('maximum control-heavy body expands safely even at one terminal column',()=>{
 const m=message('\u0000'.repeat(65536));
 const rows=renderPsstMessage(m,{expanded:true,outputPad:0},theme).render(1);
 assert.ok(rows.length>300000,'all escaped body characters remain available rather than silently truncating');
 assert.ok(rows.every(row=>visibleWidth(row)<=1));
 assert.match(rows.join(''),/\\u0000/);
});
