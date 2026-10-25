import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { BrokerStore } from '../src/store.mjs';
import { CredentialStore } from '../src/auth.mjs';
import { createBrokerServer } from '../src/server.mjs';
export const uuid=randomUUID;
export function registration(type='pi', extra={}){return {protocol_version:'1',client_id:uuid(),client_type:type,session_instance_id:uuid(),connection_id:uuid(),previous_epoch:0,metadata:{name:'same-name',model:{provider:null,id:null,source:'unknown'},project:null},capabilities:{protocol_version:'1',adapter_version:'0.1.0',client_type:type,receive_enabled:true,durable_inbox:true},...extra};}
export function credential(id='adapter-a',scopes=['default']){const token=randomBytes(32).toString('base64url');return {token,entry:{credential_id:id,token_sha256:createHash('sha256').update(token).digest('hex'),principal_id:'owner',adapter_id:id,client_types:['pi','antigravity-cli','claude-code','opencode'],scopes}};}
export function fixture(t,{limits={},...options}={}){
 const dir=mkdtempSync(join(tmpdir(),'broker-test-'));let now=Date.parse('2026-10-23T12:00:00Z');
 const path=join(dir,'broker.sqlite'),a=credential(),b=credential('adapter-b'),c=credential('adapter-c',['private']);
 let store=new BrokerStore({path,clock:()=>now,limits,...options});
 const file=join(dir,'credentials.json');const writeCreds=entries=>writeFileSync(file,JSON.stringify({credentials:entries}),{mode:0o600});writeCreds([a.entry,b.entry,c.entry]);
 const auth=new CredentialStore({path:file,clock:()=>now,onRevoke:ids=>store.revoke(ids),onPolicyChange:entries=>store.applyAuthorizationPolicies(entries)});
 const f={dir,path,a,b,c,auth,writeCreds,get store(){return store},advance(ms){now+=ms},get now(){return now},restart(){store.close();store=new BrokerStore({path,clock:()=>now,limits,...options});return store;}};
 t.after(()=>{try{store.close()}finally{rmSync(dir,{recursive:true,force:true});}});return f;
}
export const sendBody=(id,text='opaque text',extra={})=>({recipient_id:id,content:{type:'text/plain',text},...extra});
export async function httpFixture(t,options={}){
 const f=fixture(t,options),app=createBrokerServer({store:f.store,auth:f.auth,host:'127.0.0.1',port:0,insecureDevelopment:true,pollIntervalMs:10,...options.server});
 const address=await app.listen();t.after(()=>app.close());
 f.app=app;f.base=`http://127.0.0.1:${address.port}`;
 f.request=async(path,{token=f.a.token,session,epoch=1,key,method='GET',body,headers={},...opts}={})=>{
  const response=await fetch(f.base+path,{method,headers:{...(token?{Authorization:`Bearer ${token}`} :{}),...(session?{'X-Client-ID':session,'X-Lease-Epoch':String(epoch)}:{}),...(key?{'Idempotency-Key':key}:{}),...(body!==undefined?{'Content-Type':'application/json'}:{}),...headers},...(body!==undefined?{body:JSON.stringify(body)}:{}),...opts});
  const text=await response.text();return {status:response.status,body:text?JSON.parse(text):null,headers:response.headers};
 };return f;
}
