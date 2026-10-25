// Single-file helper deliberately vendorable by native connectors. Never emits secrets.
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { openSync, closeSync, fstatSync, readFileSync, writeFileSync, fsyncSync, renameSync, unlinkSync, mkdirSync, lstatSync, realpathSync, readdirSync, constants } from 'node:fs';
import { resolve, dirname, join, isAbsolute } from 'node:path';
import https from 'node:https';
import { DatabaseSync } from 'node:sqlite';

const TYPES = ['pi','claude-code','opencode','antigravity-cli'];
const fail = (code, effect = 'not_applied') => { const e = new Error(code); e.code = code; e.effect = effect; throw e; };
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
function post(url, secret, body) {
  return new Promise((resolvePromise,reject) => {
    const request = https.request(new URL('/v1/enrollments',url), {method:'POST',headers:{Authorization:`Pairing ${secret}`,'Content-Type':'application/json','Content-Length':Buffer.byteLength(body)}, timeout:10000}, response => {
      let size=0;const chunks=[];
      response.on('data',chunk=>{size+=chunk.length;if(size>16384)response.destroy(new Error('invalid_response'));else chunks.push(chunk);});
      response.on('error',()=>reject(Object.assign(new Error('enrollment_transport_error'),{code:'enrollment_transport_error',effect:'unknown'})));
      response.on('end',()=>{
        try { resolvePromise({status:response.statusCode,body:JSON.parse(Buffer.concat(chunks).toString('utf8'))}); }
        catch { reject(Object.assign(new Error('invalid_response'),{code:'invalid_response',effect:'unknown'})); }
      });
    });
    const deadline=setTimeout(()=>request.destroy(),10000);
    request.on('close',()=>clearTimeout(deadline));
    request.on('timeout',()=>request.destroy());
    request.on('error',()=>reject(Object.assign(new Error('enrollment_transport_error'),{code:'enrollment_transport_error',effect:'unknown'})));
    request.end(body);
  });
}
/** Explicit connect only. The optional transport is a test seam, never a user configuration field. */
export function connectPairingFile(options, testOptions) {
  return connectPairing({...options, pairingSecret:undefined}, testOptions);
}
/** Only a native private-input callback may supply this secret, never a model tool argument. */
export function connectPairingSecret({brokerUrl,pairingSecret,directory,clientType}, testOptions) {
  return connectPairing({brokerUrl,pairingSecret,directory,clientType}, testOptions);
}
async function connectPairing({pairingFile,pairingSecret,directory,clientType,brokerUrl}, {transport = post} = {}) {
  let lock, lockPath;
  try {
    if (!TYPES.includes(clientType)) fail('invalid_client_type');
    const pair = pairingFile === undefined
      ? {format:'psst-pairing-v1',client_type:clientType,pairing_secret:pairingSecret,broker_url:brokerUrl}
      : JSON.parse(privateRead(pairingFile));
    if (!pair || pair.format !== 'psst-pairing-v1' || pair.client_type !== clientType || typeof pair.pairing_secret !== 'string'
      || !/^[A-Za-z0-9_-]{43}$/.test(pair.pairing_secret) || (pairingFile !== undefined && !Number.isFinite(Date.parse(pair.expires_at)))) fail('invalid_pairing_file');
    const broker = origin(pair.broker_url);
    if (brokerUrl !== undefined && origin(brokerUrl) !== broker) fail('broker_origin_mismatch');
    privateDir(directory);
    lockPath = join(directory,'.enrollment-owner.sqlite');
    // Kernel-held SQLite lock survives no process crash; no stale PID or lock deletion.
    try { privateRead(lockPath); } catch(e) { if(e.code!=='ENOENT')throw e; }
    const ownerFd=openSync(lockPath,constants.O_WRONLY|constants.O_CREAT|constants.O_NOFOLLOW,0o600);closeSync(ownerFd);
    try {
      lock = new DatabaseSync(lockPath);
      lock.exec('PRAGMA journal_mode=DELETE; PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE; CREATE TABLE IF NOT EXISTS owner (id INTEGER);');
    } catch { try{lock?.close();}catch{}lock=undefined;fail('enrollment_busy'); }
    // Per-grant attempts preserve old credentials for uncertain recovery and explicit replacement.
    const attempts = join(directory,'enrollments');privateDir(attempts);
    const key = hash(pair.pairing_secret), attemptDir = join(attempts,key);
    if (!readdirSync(attempts).includes(key) && readdirSync(attempts).length >= 64) fail('enrollment_capacity');
    privateDir(attemptDir);
    const stateFile = join(attemptDir,'attempt.json');
    let state;
    try { state = JSON.parse(privateRead(stateFile)); }
    catch(e) {
      if(e.code !== 'ENOENT')throw e;
      state = {broker_url:broker,client_type:clientType,enrollment_id:randomUUID(),token:randomBytes(32).toString('base64url')};
      save(stateFile,JSON.stringify(state)+'\n'); // fsync before any issuance can happen
    }
    if (state.broker_url !== broker || state.client_type !== clientType || !/^[A-Za-z0-9_-]{43}$/.test(state.token)
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(state.enrollment_id)) fail('invalid_enrollment_state');
    const response = await transport(broker,pair.pairing_secret,JSON.stringify({enrollment_id:state.enrollment_id,client_type:clientType,token_sha256:hash(state.token)}));
    if (![200,201].includes(response.status)) {
      const code = response.body?.error?.code;
      fail(['unauthenticated','forbidden','invalid_request','idempotency_conflict','rate_limited','not_ready','storage_unavailable'].includes(code)?code:'invalid_response',response.body?.error?.effect==='not_applied'?'not_applied':'unknown');
    }
    const result = response.body;
    if (!result || result.protocol_version !== '1' || result.client_type !== clientType || !/^enrolled-[0-9a-f-]{36}$/.test(result.credential_id)
      || !/^installation-[0-9a-f-]{36}$/.test(result.adapter_id) || !Array.isArray(result.scopes) || !result.scopes.length || result.scopes.length>32
      || result.scopes.some(s=>typeof s!=='string'||!/^[-a-zA-Z0-9_.]{1,128}$/.test(s)) || !Number.isFinite(Date.parse(result.expires_at))) fail('invalid_response','unknown');
    if(Date.parse(result.expires_at)<=Date.now())fail('credential_expired','unknown');
    save(join(attemptDir,'token'),state.token+'\n');
    const bundle = {format:'broker-client-bundle-v1',protocol_version:'1',broker_url:broker,token_file:'token',enrollment_receipt_file:'enrollment.json',file_paths_relative_to:'connection_file_directory',authorization_header:'Authorization',authorization_scheme:'Bearer',insecure_development:false,allowed_client_types:[clientType],scope:result.scopes[0]};
    const connectionFile = join(attemptDir,'connection.json');
    // Publish receipt before bundle: the returned bundle always has its token-bound receipt.
    save(join(attemptDir,'enrollment.json'),JSON.stringify({format:'psst-enrollment-receipt-v1',broker_url:broker,...result,token_sha256:hash(state.token)})+'\n');
    save(connectionFile,JSON.stringify(bundle,null,2)+'\n');
    return {connectionFile,credentialId:result.credential_id,expiresAt:result.expires_at};
  } catch(e) {
    if (e.effect && /^[a-z_]+$/.test(e.code)) throw e;
    fail('enrollment_local_error','unknown');
  } finally {
    if (lock !== undefined) { try { lock.close(); } catch { /* Never replace a sanitized result with raw filesystem details. */ } }
  }
}

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
