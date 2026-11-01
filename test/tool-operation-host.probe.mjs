// Actual Pi host tool execution supplies the persisted assistant-entry identity/time.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { toolOperationContext } from '../src/tool-operation.mjs';
const host=process.env.PI_TEST_INSTALL;if(!host)throw Error('Set PI_TEST_INSTALL');
const base=join(host,'node_modules/@earendil-works/pi-coding-agent');
const { createAgentSession }=await import(pathToFileURL(join(base,'dist/core/sdk.js')));
const { ModelRuntime }=await import(pathToFileURL(join(base,'dist/core/model-runtime.js')));
const { DefaultResourceLoader }=await import(pathToFileURL(join(base,'dist/core/resource-loader.js')));
const { SessionManager }=await import(pathToFileURL(join(base,'dist/core/session-manager.js')));
const { fauxProvider,fauxAssistantMessage,fauxToolCall }=await import(pathToFileURL(join(host,'node_modules/@earendil-works/pi-ai/dist/providers/faux.js')));
const { Type }=await import(pathToFileURL(join(host,'node_modules/typebox/build/index.mjs')));

test('official Pi tool call has stable original assistant timestamp before executing effects',{timeout:20000},async t=>{
 const root=mkdtempSync(join(tmpdir(),'pi-operation-host-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const runtime=await ModelRuntime.create({authPath:join(root,'auth.json'),modelsPath:null,refreshOnCreate:false});
 const faux=fauxProvider({tokensPerSecond:100000});runtime.registerNativeProvider(faux.provider);
 faux.setResponses([fauxAssistantMessage(fauxToolCall('fixture_operation',{text:'ping'},{id:'fixture-call'}),{stopReason:'toolUse'}),fauxAssistantMessage('done')]);
 let observed,entryAtExecution,persistedAtExecution;
 const loader=new DefaultResourceLoader({cwd:root,agentDir:join(root,'agent'),noExtensions:true,noSkills:true,noPromptTemplates:true,noThemes:true,noContextFiles:true,
  extensionFactories:[api=>api.registerTool({name:'fixture_operation',label:'fixture',description:'local fixture',parameters:Type.Object({text:Type.String()}),
   async execute(id,_args,_signal,_update,ctx){observed=toolOperationContext(ctx,id,'fixture_operation');entryAtExecution=ctx.sessionManager.getBranch().find(row=>JSON.stringify([ctx.sessionManager.getSessionId(),row.id,id])===observed.operationId);persistedAtExecution=readFileSync(ctx.sessionManager.getSessionFile(),'utf8').trim().split('\n').map(line=>JSON.parse(line)).find(row=>row.id===entryAtExecution.id);return{content:[{type:'text',text:'accepted'}]};}})]});
 await loader.reload();const manager=SessionManager.create(root,join(root,'sessions'));
 const {session}=await createAgentSession({cwd:root,agentDir:join(root,'agent'),modelRuntime:runtime,model:faux.getModel(),resourceLoader:loader,sessionManager:manager,noTools:'builtin'});t.after(()=>session.dispose());await session.bindExtensions({});
 await session.prompt('execute the local fixture');
 assert.ok(observed,'actual tool executed');assert.ok(persistedAtExecution,'original native entry is on disk before effect');assert.equal(observed.operationStartedAt,Date.parse(entryAtExecution.timestamp));
 const rows=readFileSync(manager.getSessionFile(),'utf8').trim().split('\n').map(line=>JSON.parse(line));
 const persisted=rows.find(row=>row.id===entryAtExecution.id);assert.ok(persisted);assert.equal(persisted.timestamp,entryAtExecution.timestamp);
 const replay=toolOperationContext({sessionManager:{getSessionId:()=>manager.getSessionId(),getBranch:()=>[persisted]}},'fixture-call','fixture_operation');
 assert.deepEqual(replay,observed,'reload/replay reuses original native identity and time');
});
