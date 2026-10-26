// Single-file helper deliberately vendorable by native connectors. Never emits secrets.
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { openSync, closeSync, fstatSync, readFileSync, writeFileSync, fsyncSync, renameSync, unlinkSync, mkdirSync, lstatSync, realpathSync, readdirSync, constants } from 'node:fs';
import { resolve, dirname, join, isAbsolute } from 'node:path';
import https from 'node:https';
import { DatabaseSync } from 'node:sqlite';

const TYPES = ['pi','claude-code','opencode','antigravity-cli'];
const fail = (code, effect = 'not_applied', retryable=false, retryAfterMs=2000) => { const e = new Error(code); Object.assign(e,{code,effect,retryable,...(retryable?{retryAfterMs:Math.max(1000,Math.min(300000,Math.ceil(retryAfterMs)))}:{})}); throw e; };
const hash = value => createHash('sha256').update(value).digest('hex');
function privateDir(path) {
  if (!isAbsolute(path)) fail('private_directory_required');
  mkdirSync(path, {recursive:true, mode:0o700});
  const s = lstatSync(path);
  if (!s.isDirectory() || s.isSymbolicLink() || realpathSync(path) !== resolve(path) || (s.mode & 0o077) || (process.getuid && s.uid !== process.getuid())) fail('private_directory_required');
}
function privateRead(path) {
  if (!isAbsolute(path) || realpathSync(dirname(path)) !== resolve(dirname(path))) fail('private_file_required');
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const s = fstatSync(fd);
    if (!s.isFile() || s.size > 65536 || (s.mode & 0o077) || (process.getuid && s.uid !== process.getuid())) fail('private_file_required');
    return readFileSync(fd,'utf8');
  } finally { closeSync(fd); }
}
function save(path, text) {
  // Reject unsafe existing destinations rather than silently repairing their mode.
  try { privateRead(path); } catch(e) { if(e.code !== 'ENOENT') throw e; }
  const temp = `${path}.${randomUUID()}.tmp`;
  const fd = openSync(temp, constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
  try { writeFileSync(fd,text); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temp,path);
  const d = openSync(dirname(path),constants.O_RDONLY);try { fsyncSync(d); } finally { closeSync(d); }
}
function origin(value) {
  let u; try { u = new URL(value); } catch { fail('https_origin_required'); }
  if (typeof value !== 'string' || /[\u0000-\u0020\u007f]/u.test(value) || u.protocol !== 'https:' || u.username || u.password || u.pathname !== '/' || u.search || u.hash) fail('https_origin_required');
  return u.origin;
}
const stateNames=['pending','approved','denied','expired','revoked'];
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
function locations({brokerUrl,directory,clientType}) {
  if(!TYPES.includes(clientType))fail('invalid_client_type');
  if(!isAbsolute(directory))fail('private_directory_required');
  const broker=origin(brokerUrl),root=join(directory,'approvals',hash(broker+'\0'+clientType));
  return {broker,root,current:join(root,'current.json'),clientType};
}
function load(loc) {
  let pointer;try{pointer=JSON.parse(privateRead(loc.current));}catch(e){if(e.code==='ENOENT')return null;throw e;}
  if(!pointer||!uuid.test(pointer.requestId))fail('invalid_approval_state');
  const dir=join(loc.root,pointer.requestId),state=JSON.parse(privateRead(join(dir,'attempt.json')));
  if(state.requestId!==pointer.requestId||state.brokerUrl!==loc.broker||state.clientType!==loc.clientType
    ||!/^[A-Za-z0-9_-]{43}$/.test(state.token)||!stateNames.includes(state.state)
    ||typeof state.label!=='string'||state.label.length>80)fail('invalid_approval_state');
  return {state,dir};
}
function visible({state,dir}) {
  const result={requestId:state.requestId,approvalUrl:state.brokerUrl+'/admin',state:state.state,requestExpiresAt:state.requestExpiresAt??null};
  if(state.state==='approved'){
    if(!state.credential||Date.parse(state.credential.expires_at)<=Date.now())return {...result,state:'expired'};
    result.connectionFile=join(dir,'connection.json');
    Object.assign(result,readEnrollmentReceipt({connectionFile:result.connectionFile,clientType:state.clientType}));
  }
  return result;
}
function sanitized(e) {
  if(e.effect&&/^[a-z_]+$/.test(e.code))throw e;
  fail('approval_local_error','unknown');
}
export function readApprovalState(options) {
  try{const item=load(locations(options));return item?visible(item):null;}catch(e){sanitized(e);}
}
function request(broker,method,path,token,input) {
  return new Promise((resolvePromise,reject)=>{
    const body=input===undefined?undefined:JSON.stringify(input);
    const transportError=()=>Object.assign(new Error('approval_transport_error'),{code:'approval_transport_error',effect:'unknown',retryable:true,retryAfterMs:2000});
    const req=https.request(new URL(path,broker),{method,headers:{Authorization:`Enrollment ${token}`,...(body?{'Content-Type':'application/json','Content-Length':Buffer.byteLength(body)}:{})}},res=>{
      let size=0;const chunks=[];
      res.on('data',chunk=>{size+=chunk.length;if(size>16384)res.destroy();else chunks.push(chunk);});
      res.on('error',()=>reject(transportError()));
      res.on('end',()=>{try{resolvePromise({status:res.statusCode,retryAfter:res.headers['retry-after'],body:JSON.parse(Buffer.concat(chunks).toString('utf8'))});}catch{reject(Object.assign(new Error('invalid_response'),{code:'invalid_response',effect:'unknown',retryable:false}));}});
    });
    const timer=setTimeout(()=>req.destroy(),10000);req.on('close',()=>clearTimeout(timer));
    req.on('error',()=>reject(transportError()));req.end(body);
  });
}
function publish(item,result,broker,clientType){
  const {state,dir}=item;
  if(!result||result.request_id!==state.requestId||!stateNames.includes(result.state)
    ||!Number.isFinite(Date.parse(result.request_expires_at)))fail('invalid_response','unknown');
  if(result.state==='approved'){
    const c=result.credential;
    if(!c||c.protocol_version!=='1'||c.client_type!==clientType||!/^enrolled-[0-9a-f-]{36}$/.test(c.credential_id)
      ||!/^installation-[0-9a-f-]{36}$/.test(c.adapter_id)||!Array.isArray(c.scopes)||!c.scopes.length||c.scopes.length>32
      ||c.scopes.some(s=>typeof s!=='string'||!/^[-a-zA-Z0-9_.]{1,128}$/.test(s))||!Number.isFinite(Date.parse(c.expires_at)))fail('invalid_response','unknown');
    if(Date.parse(c.expires_at)<=Date.now())fail('credential_expired');
    save(join(dir,'token'),state.token+'\n');
    save(join(dir,'enrollment.json'),JSON.stringify({format:'psst-enrollment-receipt-v1',broker_url:broker,...c,token_sha256:hash(state.token)})+'\n');
    save(join(dir,'connection.json'),JSON.stringify({format:'broker-client-bundle-v1',protocol_version:'1',broker_url:broker,token_file:'token',enrollment_receipt_file:'enrollment.json',file_paths_relative_to:'connection_file_directory',authorization_header:'Authorization',authorization_scheme:'Bearer',insecure_development:false,allowed_client_types:[clientType],scope:c.scopes[0]})+'\n');
    state.credential=c;
  }
  state.state=result.state;state.requestExpiresAt=result.request_expires_at;
  save(join(dir,'attempt.json'),JSON.stringify(state)+'\n');return visible(item);
}
async function operate(options,begin,{transport=request,pollIntervalMs=2000}={}) {
  let lock;
  try {
    const loc=locations(options);
    if(!begin&&!load(loc))fail('approval_setup_required');
    privateDir(options.directory);privateDir(join(options.directory,'approvals'));privateDir(loc.root);
    const lockPath=join(loc.root,'.owner.sqlite');
    try{privateRead(lockPath);}catch(e){if(e.code!=='ENOENT')throw e;}
    const fd=openSync(lockPath,constants.O_WRONLY|constants.O_CREAT|constants.O_NOFOLLOW,0o600);closeSync(fd);
    try{lock=new DatabaseSync(lockPath);lock.exec('PRAGMA journal_mode=DELETE; PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE; CREATE TABLE IF NOT EXISTS owner(id INTEGER);');}
    catch{fail('approval_busy','not_applied',true);}
    let item=load(loc);
    if(begin){
      const replacement=options.replaceRequestId;
      if(replacement!==undefined&&(!uuid.test(replacement)||!item))fail('selection_conflict');
      if(replacement!==undefined&&item.state.requestId!==replacement&&item.state.parentRequestId!==replacement)fail('selection_conflict');
      if(replacement!==undefined&&item.state.requestId===replacement&&item.state.state==='pending')fail('selection_conflict');
      if(!item||(replacement!==undefined&&item.state.requestId===replacement)){
        if(readdirSync(loc.root).length>=130)fail('approval_capacity');
        const label=options.label??options.clientType;
        if(typeof label!=='string'||label.length>80||/[\u0000-\u001f\u007f]/u.test(label))fail('invalid_request');
        const state={requestId:randomUUID(),parentRequestId:replacement??null,brokerUrl:loc.broker,clientType:options.clientType,label,token:randomBytes(32).toString('base64url'),state:'pending'};
        const dir=join(loc.root,state.requestId);privateDir(dir);
        save(join(dir,'attempt.json'),JSON.stringify(state)+'\n');
        save(loc.current,JSON.stringify({requestId:state.requestId})+'\n');item={state,dir};
      }
    }
    if(!item)fail('approval_setup_required');
    if(item.state.state!=='pending')return visible(item);
    const s=item.state;
    if(Number.isFinite(s.retryAt)&&s.retryAt>Date.now()&&s.retryAt-Date.now()<=300000)fail(s.retryCode??'rate_limited',s.retryEffect??'unknown',true,s.retryAt-Date.now());
    if(!begin){
      const now=Date.now();
      if(Number.isFinite(s.lastPollAt)&&now>=s.lastPollAt&&now-s.lastPollAt<pollIntervalMs)return visible(item);
      s.lastPollAt=now;save(join(item.dir,'attempt.json'),JSON.stringify(s)+'\n');
    }
    const path=begin?'/v1/enrollment-requests':`/v1/enrollment-requests/${s.requestId}`;
    const response=await transport(loc.broker,begin?'POST':'GET',path,s.token,begin?{request_id:s.requestId,client_type:s.clientType,label:s.label}:undefined);
    if(![200,201].includes(response.status)){
      const code=response.body?.error?.code;
      let retryAfterMs=response.status===429?60000:5000;
      if(typeof response.retryAfter==='string'){
        const seconds=/^[0-9]{1,6}$/.test(response.retryAfter)?Number(response.retryAfter):NaN;
        const parsed=Number.isFinite(seconds)?seconds*1000:Date.parse(response.retryAfter)-Date.now();
        if(Number.isFinite(parsed))retryAfterMs=Math.max(1000,Math.min(300000,Math.ceil(parsed)));
      }
      if([429,503].includes(response.status)){s.retryAt=Date.now()+retryAfterMs;s.retryCode=code==='not_ready'||code==='storage_unavailable'?code:'rate_limited';s.retryEffect=response.body?.error?.effect==='not_applied'?'not_applied':'unknown';save(join(item.dir,'attempt.json'),JSON.stringify(s)+'\n');}
      fail(['unauthenticated','forbidden','invalid_request','idempotency_conflict','rate_limited','not_ready','storage_unavailable'].includes(code)?code:'invalid_response',response.body?.error?.effect==='not_applied'?'not_applied':'unknown',[429,503].includes(response.status),retryAfterMs);
    }
    delete s.retryAt;delete s.retryCode;delete s.retryEffect;
    return publish(item,response.body,loc.broker,options.clientType);
  }catch(e){sanitized(e);}finally{try{lock?.close();}catch{}}
}
export const beginApproval=(options,testOptions)=>operate(options,true,testOptions);
export const pollApproval=(options,testOptions)=>operate(options,false,testOptions);

/** Read only for a helper-enrolled bundle. Missing/corrupt receipt is not a legacy fallback. */
export function readEnrollmentReceipt({connectionFile,clientType}) {
  try {
    if(!TYPES.includes(clientType))fail('invalid_client_type');
    const bundle=JSON.parse(privateRead(connectionFile));
    const receipt=JSON.parse(privateRead(join(dirname(connectionFile),'enrollment.json')));
    const token=privateRead(join(dirname(connectionFile),'token')).trim();
    if(bundle?.format!=='broker-client-bundle-v1'||bundle.protocol_version!=='1'||bundle.token_file!=='token'||bundle.enrollment_receipt_file!=='enrollment.json'
      ||bundle.authorization_scheme!=='Bearer'||bundle.authorization_header!=='Authorization'||bundle.insecure_development!==false
      ||!Array.isArray(bundle.allowed_client_types)||bundle.allowed_client_types.length!==1||bundle.allowed_client_types[0]!==clientType
      ||receipt?.format!=='psst-enrollment-receipt-v1'||receipt.protocol_version!=='1'||receipt.client_type!==clientType
      ||receipt.broker_url!==origin(bundle.broker_url)||!/^[A-Za-z0-9_-]{43}$/.test(token)||receipt.token_sha256!==hash(token)
      ||!/^enrolled-[0-9a-f-]{36}$/.test(receipt.credential_id)||!/^installation-[0-9a-f-]{36}$/.test(receipt.adapter_id)
      ||!Array.isArray(receipt.scopes)||!receipt.scopes.length||receipt.scopes[0]!==bundle.scope||!Number.isFinite(Date.parse(receipt.expires_at)))fail('invalid_enrollment_receipt');
    if(Date.parse(receipt.expires_at)<=Date.now())fail('credential_expired');
    return {credentialId:receipt.credential_id,expiresAt:receipt.expires_at};
  } catch(e) {
    if(e.effect&&/^[a-z_]+$/.test(e.code))throw e;
    fail('invalid_enrollment_receipt');
  }
}
