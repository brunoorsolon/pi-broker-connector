import { readFileSync, openSync, fstatSync, closeSync, constants } from 'node:fs';
import { createHash, timingSafeEqual } from 'node:crypto';
import { ApiError, TYPES } from './protocol.mjs';

/** Operator-owned verifier file. Empty means deny-all, never authentication bypass. */
export class CredentialStore {
  constructor({ path, onRevoke = () => {}, onPolicyChange = () => {}, clock = Date.now, additionalCredentials = () => [] }) {
    this.additionalCredentials=additionalCredentials;this.path=path;this.onRevoke=onRevoke;this.onPolicyChange=onPolicyChange;this.clock=clock;this.entries=[];this.serial=null;
    this.reload();
  }
  reload() {
    try {
      let raw;const fd=openSync(this.path,constants.O_RDONLY|constants.O_NOFOLLOW);
      try{
        const stat=fstatSync(fd);
        if((stat.mode&0o077)!==0||!stat.isFile()||stat.size>1024*1024||(process.getuid&&![process.getuid(),0].includes(stat.uid))) throw new Error('Credential file must be a private, bounded operator-owned regular file.');
        raw=readFileSync(fd,'utf8');
      }finally{closeSync(fd);}
      const value=JSON.parse(raw);
      if(!value||Object.keys(value).some(k=>k!=='credentials')||!Array.isArray(value.credentials)||value.credentials.length>1000) throw new Error('Invalid credential configuration.');
      value.credentials.push(...this.additionalCredentials());
      const seen=new Set(),hashes=new Set();
      for(const c of value.credentials){
        const keys=['credential_id','token_sha256','principal_id','adapter_id','client_types','scopes','expires_at','revoked'];
        if(!c||Object.keys(c).some(k=>!keys.includes(k)))throw new Error('Invalid credential fields.');
        for(const key of ['credential_id','principal_id','adapter_id'])if(typeof c[key]!=='string'||!/^[-a-zA-Z0-9_.]{1,128}$/.test(c[key]))throw new Error('Invalid credential identity.');
        if(typeof c.token_sha256!=='string'||!/^([a-f0-9]{64})$/.test(c.token_sha256)||seen.has(c.credential_id)||hashes.has(c.token_sha256))throw new Error('Invalid or duplicate token verifier.');
        if(!Array.isArray(c.client_types)||!c.client_types.length||c.client_types.some(t=>!TYPES.includes(t))||c.client_types.length>16)throw new Error('Invalid allowed types.');
        if(!Array.isArray(c.scopes)||!c.scopes.length||c.scopes.length>32||c.scopes.some(s=>typeof s!=='string'||!/^[-a-zA-Z0-9_.]{1,128}$/.test(s)))throw new Error('Invalid communication scopes.');
        if(c.expires_at!==undefined&&(!Number.isFinite(Date.parse(c.expires_at))||typeof c.expires_at!=='string'))throw new Error('Invalid credential expiry.');
        if(c.revoked!==undefined&&typeof c.revoked!=='boolean')throw new Error('Invalid revocation flag.');
        seen.add(c.credential_id);hashes.add(c.token_sha256);
      }
      this.configuredEntries=value.credentials; // includes revoked/expired hashes for issuance collision checks
      const active=value.credentials.filter(c=>!c.revoked&&(c.expires_at===undefined||Date.parse(c.expires_at)>this.clock()));
      const revoked=this.entries.filter(c=>!active.some(n=>JSON.stringify(n)===JSON.stringify(c))).map(c=>c.credential_id);
      if(revoked.length)this.onRevoke(revoked);
      if(JSON.stringify(this.entries)!==JSON.stringify(active))this.onPolicyChange(active);
      this.entries=active;this.serial=raw;this.ready=active.length>0;
    }catch(error){this.ready=false;throw error;}
  }
  authenticate(header) {
    try{this.reload();}catch{throw new ApiError(503,'not_ready',null,{retryable:true});}
    const match=typeof header==='string'&&/^Bearer ([A-Za-z0-9_-]{43,256})$/.exec(header);
    const hash=createHash('sha256').update(match?match[1]:'invalid').digest();
    let found;
    for(const entry of this.entries){if(timingSafeEqual(hash,Buffer.from(entry.token_sha256,'hex')))found=entry;}
    if(!match||!found)throw new ApiError(401,'unauthenticated','headers.Authorization');
    return found;
  }
}
