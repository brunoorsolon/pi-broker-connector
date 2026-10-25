import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,writeFileSync,rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resolveConnectionFile } from '../src/connect-config.mjs';
test('one connect path accepts legacy bundle unchanged or private pairing file through shared helper',async t=>{
 const root=mkdtempSync(join(tmpdir(),'pi-pair-glue-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const file=join(root,'input.json'),env={PSST_STATE_DIR:join(root,'state')};let calls=0;
 const pairingConnector=async options=>{calls++;assert.deepEqual(options,{pairingFile:file,directory:join(root,'state/installations'),clientType:'pi'});return {connectionFile:join(root,'issued/connection.json'),credentialId:'fixture',expiresAt:'fixture'};};
 writeFileSync(file,JSON.stringify({format:'broker-client-bundle-v1'}),{mode:0o600});assert.equal(await resolveConnectionFile(file,{env,pairingConnector}),file);assert.equal(calls,0);
 writeFileSync(file,JSON.stringify({format:'psst-pairing-v1'}));assert.equal(await resolveConnectionFile(file,{env,pairingConnector}),join(root,'issued/connection.json'));assert.equal(calls,1);
 await assert.rejects(resolveConnectionFile(file,{env,pairingConnector:async()=>{throw Error('sanitized');}}),{code:'invalid_configuration'});
});
test('real shared pairing helper lost-response retry produces a private Pi-compatible enrollment',async t=>{
 const {randomBytes,randomUUID}=await import('node:crypto');
 const {connectPairingFile}=await import('../vendor/broker/reference/enrollment.mjs');
 const {readConfig}=await import('../src/config.mjs');
 const root=mkdtempSync(join(tmpdir(),'pi-real-pair-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const file=join(root,'pairing.json'),env={PSST_STATE_DIR:join(root,'state')};
 writeFileSync(file,JSON.stringify({format:'psst-pairing-v1',broker_url:'https://broker.example',client_type:'pi',pairing_secret:randomBytes(32).toString('base64url'),expires_at:new Date(Date.now()+60000).toISOString()}),{mode:0o600});
 let original,calls=0;const credentialId=`enrolled-${randomUUID()}`;
 const pairingConnector=options=>connectPairingFile(options,{transport:async(_url,_secret,body)=>{
  calls++;if(!original){original=body;throw Object.assign(Error('synthetic lost response'),{code:'enrollment_transport_error',effect:'unknown'});}
  assert.equal(body,original);assert.match(JSON.parse(body).token_sha256,/^[0-9a-f]{64}$/);
  return {status:200,body:{credential_id:credentialId,adapter_id:`installation-${randomUUID()}`,client_type:'pi',scopes:['psst'],expires_at:new Date(Date.now()+86400000).toISOString(),protocol_version:'1'}};
 }});
 await assert.rejects(resolveConnectionFile(file,{env,pairingConnector}),{code:'enrollment_transport_error'});
 const connectionFile=await resolveConnectionFile(file,{env,pairingConnector});assert.equal(calls,2);
 const config=readConfig(env,connectionFile);assert.equal(config.credentialId,credentialId);assert.equal(config.url,'https://broker.example/');assert.ok(config.tokenFile.endsWith('/token'));
 // Receipt is not trusted if it no longer matches the private credential.
 writeFileSync(config.tokenFile,randomBytes(32).toString('base64url'));assert.throws(()=>readConfig(env,connectionFile),{code:'invalid_configuration'});
});
