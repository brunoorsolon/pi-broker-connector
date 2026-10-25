import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, statSync, chmodSync, symlinkSync } from 'node:fs';
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
 const load=()=>{const events={},commands={},tools={};const Type={Object:()=>({}),String:()=>({}),Optional:()=>({}),Integer:()=>({})};
 installExtension({on:(n,f)=>events[n]=f,registerCommand:(n,c)=>commands[n]=c,registerTool:t=>tools[t.name]=t},Type,{pathStore,env,createSession});return {events,commands,tools};};
 return {home,file,pathStore,env,ctx,load,instances,notices,setSession:id=>sessionId=id,get active(){return active;},get peak(){return peak;}};
}
test('connect activates current session without env; TXT survives reload; reconnect has one owner',async t=>{
 const f=fixture(t);let host=f.load();await host.events.session_start({},f.ctx);assert.equal(f.active,0);
 await host.commands['psst-connect'].handler(f.file,f.ctx);assert.equal(f.active,1);const first=f.instances.at(-1).inbox.identity.client_id;
 assert.equal(readFileSync(join(f.home,'.config/psst/pi-config-path'),'utf8'),f.file+'\n');assert.equal(statSync(join(f.home,'.config/psst/pi-config-path')).mode&0o777,0o600);
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
 const f=fixture(t);assert.equal(f.pathStore.read(),null);const pointer=join(f.home,'.config/psst/pi-config-path');f.pathStore.write(f.file);
 for(const value of ['relative.json\n',f.file+'\n/other\n']){writeFileSync(pointer,value);assert.throws(()=>f.pathStore.read());}
 f.pathStore.write(f.file);chmodSync(pointer,0o644);assert.throws(()=>f.pathStore.read());rmSync(pointer);symlinkSync(f.file,pointer);assert.throws(()=>f.pathStore.read());
 f.env.PSST_CONFIG_FILE=f.file;const host=f.load();await host.events.session_start({},f.ctx);assert.equal(f.active,1);await host.events.session_shutdown();
});
