import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, statSync, chmodSync, symlinkSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installExtension } from '../src/extension.mjs';
import { createConfigPathStore } from '../src/config-path.mjs';
import { PiBrokerSession } from '../src/session.mjs';
function fixture(t) {
 const home=mkdtempSync(join(tmpdir(),'pi-connect-')); t.after(()=>rmSync(home,{recursive:true,force:true}));
 const file=join(home,'connection.json');
 writeFileSync(file,JSON.stringify({format:'broker-client-bundle-v1',protocol_version:'1',file_paths_relative_to:'connection_file_directory',authorization_header:'Authorization',authorization_scheme:'Bearer',insecure_development:false,broker_url:'https://broker.example',token_file:'token',allowed_client_types:['pi']}),{mode:0o600});
 const pathStore=createConfigPathStore(home),env={PSST_STATE_DIR:join(home,'state')};
 let sessionId='native-A',active=0,peak=0; const instances=[],notices=[];
 const ctx={hasUI:true,sessionManager:{getSessionId:()=>sessionId},ui:{setStatus(){},notify:text=>notices.push(text)}};
 const createSession=options=>{const session=new PiBrokerSession(options),close=session.close.bind(session);let started=false;
 session.start=async()=>{started=true;active++;peak=Math.max(peak,active);};session.close=async()=>{if(started){active--;started=false;}await close();};instances.push(session);return session;};
 const load=(overrides={})=>{const events={},commands={},tools={};const Type={Object:()=>({}),String:()=>({}),Optional:()=>({}),Integer:()=>({})};
 installExtension({on:(n,f)=>events[n]=f,registerCommand:(n,c)=>commands[n]=c,registerTool:t=>tools[t.name]=t},Type,{pathStore,env,createSession,...overrides});return {events,commands,tools};};
 return {home,file,pathStore,env,ctx,load,instances,notices,setSession:id=>sessionId=id,get active(){return active;},get peak(){return peak;}};
}
test('connect activates current session without env; TXT survives reload; reconnect has one owner',async t=>{
 const f=fixture(t);let host=f.load();await host.events.session_start({},f.ctx);assert.equal(f.active,0);
 await host.commands['psst-connect'].handler(f.file,f.ctx);assert.equal(f.active,1);const first=f.instances.at(-1).inbox.identity.client_id;
 assert.equal(f.pathStore.read(),f.file);assert.equal(statSync(join(f.home,'.pi/agent/psst/selection.sqlite')).mode&0o777,0o600);
 await host.commands['psst-connect'].handler(f.file,f.ctx);assert.equal(f.instances.at(-1).inbox.identity.client_id,first);assert.equal(f.peak,1);
 await host.events.session_shutdown();host=f.load();await host.events.session_start({},f.ctx);assert.equal(f.instances.at(-1).inbox.identity.client_id,first);assert.equal(f.active,1);
 f.setSession('native-B');await host.events.session_start({},f.ctx);assert.notEqual(f.instances.at(-1).inbox.identity.client_id,first);await host.events.session_shutdown();assert.equal(f.active,0);
});
test('invalid command preserves working session; concurrent connect/shutdown cannot revive it',async t=>{
 const f=fixture(t),host=f.load();await host.commands['psst-connect'].handler(f.file,f.ctx);
 await host.commands['psst-connect'].handler('relative.json',f.ctx);assert.equal(f.active,1);assert.equal(f.pathStore.read(),f.file);
 await host.commands['psst-connect'].handler('/missing/connection.json',f.ctx);assert.equal(f.active,1);
 await Promise.all([host.commands['psst-connect'].handler(f.file,f.ctx),host.events.session_shutdown()]);assert.equal(f.active,0);assert.equal(f.peak,1);assert.ok(f.notices.every(text=>!text.includes(f.file)));
});
test('TXT rejects multiline/relative/public/symlink; explicit env keeps precedence',async t=>{
 const f=fixture(t);assert.equal(f.pathStore.read(),null);const pointer=join(f.home,'.pi/agent/psst/pi-config-path');mkdirSync(join(f.home,'.pi/agent/psst'),{recursive:true,mode:0o700});writeFileSync(pointer,f.file+'\n',{mode:0o600});
 for(const value of ['relative.json\n',f.file+'\n/other\n']){writeFileSync(pointer,value);assert.throws(()=>f.pathStore.read());}
 writeFileSync(pointer,f.file+'\n');chmodSync(pointer,0o644);assert.throws(()=>f.pathStore.read());rmSync(pointer);symlinkSync(f.file,pointer);assert.throws(()=>f.pathStore.read());
 f.env.PSST_CONFIG_FILE=f.file;const host=f.load();await host.events.session_start({},f.ctx);assert.equal(f.active,1);await host.events.session_shutdown();
});

test('disconnect survives reload until explicit reconnect; manual mode survives reconnect',async t=>{
 const f=fixture(t);let host=f.load();await host.commands['psst-connect'].handler(f.file,f.ctx);
 await host.commands['psst-mode'].handler('manual',f.ctx);
 await host.commands['psst-disconnect'].handler('',f.ctx);assert.equal(f.active,0);
 await host.events.session_shutdown();host=f.load();await host.events.session_start({},f.ctx);assert.equal(f.active,0);
 await host.commands['psst-connect'].handler(f.file,f.ctx);assert.equal(f.active,1);
 const result=await host.tools.broker_identity.execute('id',{},undefined,undefined,f.ctx);assert.equal(result.details.local_mode,'cooperative_pull');
 await host.events.session_shutdown();
});

test('pairing completion after shutdown cannot reconnect or replace remembered configuration',async t=>{
 const f=fixture(t);let finish;const host=f.load({connectionResolver:()=>new Promise(resolve=>finish=resolve)});
 await host.events.session_start({},f.ctx);const pending=host.commands['psst-connect'].handler(f.file,f.ctx);
 await host.events.session_shutdown();finish(f.file);await pending;assert.equal(f.active,0);assert.equal(f.pathStore.read(),null);
});

test('native setup is explicit once; thirty fresh sessions auto-connect without setup or credential rotation',async t=>{
 const f=fixture(t);let setups=0;const overrides={setupUI:async()=>{setups++;return {connectionFile:f.file,brokerUrl:'https://broker.example'};}};
 let host=f.load(overrides);await host.commands['psst-setup'].handler('',f.ctx);assert.equal(setups,1);await host.events.session_shutdown();
 const ids=new Set();for(let i=0;i<30;i++){f.setSession(`fresh-${i}`);host=f.load(overrides);await host.events.session_start({},f.ctx);ids.add(f.instances.at(-1).inbox.identity.client_id);await host.events.session_shutdown();}
 assert.equal(ids.size,30);assert.equal(setups,1);assert.equal(f.pathStore.read(),f.file);
});

test('failed native setup attachment leaves previous installation selection untouched',async t=>{
 const f=fixture(t);f.pathStore.write(f.file,'https://broker.example');const before=f.pathStore.snapshot();
 const replacement=join(f.home,'replacement.json');writeFileSync(replacement,readFileSync(f.file),{mode:0o600});
 const host=f.load({setupUI:async()=>({connectionFile:replacement,brokerUrl:'https://broker.example'}),createSession:()=>{throw Error('synthetic attach failure');}});
 await host.commands['psst-setup'].handler('',f.ctx);assert.deepEqual(f.pathStore.snapshot(),before);
});

test('native setup CAS does not overwrite selection changed during registration',async t=>{
 const f=fixture(t);f.pathStore.write(f.file,'https://broker.example');
 const replacement=join(f.home,'replacement.json');writeFileSync(replacement,readFileSync(f.file),{mode:0o600});
 const host=f.load({setupUI:async()=>({connectionFile:replacement,brokerUrl:'https://broker.example'}),createSession:options=>{const s=new PiBrokerSession(options);s.start=async()=>{f.pathStore.write(f.file,'https://broker.example');};return s;}});
 await host.commands['psst-setup'].handler('',f.ctx);assert.equal(f.pathStore.read(),f.file);assert.ok(f.notices.some(n=>n.includes('selection was not overwritten')));await host.events.session_shutdown();
});

test('explicit native setup may replace saved broker A with approved B after success only',async t=>{
 const f=fixture(t);f.pathStore.write(f.file,'https://broker.example');
 const replacement=join(f.home,'broker-b.json');const bundle=JSON.parse(readFileSync(f.file));bundle.broker_url='https://broker-b.example';writeFileSync(replacement,JSON.stringify(bundle),{mode:0o600});
 const host=f.load({setupUI:async()=>({connectionFile:replacement,brokerUrl:'https://broker-b.example'})});
 await host.commands['psst-setup'].handler('',f.ctx);assert.equal(f.pathStore.snapshot().brokerUrl,'https://broker-b.example');assert.equal(f.pathStore.read(),replacement);await host.events.session_shutdown();
});

test('failed legacy explicit connect and unsafe snapshot do not replace saved selection',async t=>{
 const f=fixture(t);f.pathStore.write(f.file,'https://broker.example');const before=f.pathStore.snapshot();
 const host=f.load({createSession:()=>{throw Error('fixture failure');}});await host.commands['psst-connect'].handler(f.file,f.ctx);assert.deepEqual(f.pathStore.snapshot(),before);
 const unsafe=f.load({pathStore:{snapshot(){throw Error('raw local path must not leak');},read(){return null;}}});
 await unsafe.commands['psst-setup'].handler('',f.ctx);assert.equal(f.notices.some(s=>s.includes('raw local path')),false);
});
