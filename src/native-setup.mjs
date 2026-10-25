import {createConfigPathStore} from './config-path.mjs';
import {join} from 'node:path';
import {storageLayout} from './storage.mjs';
import {LocalError} from '../vendor/broker/reference/errors.mjs';
import {promptPairingSecret} from './private-input.mjs';
export function brokerOrigin(value) {
 let u;try{u=new URL(value);}catch{throw new LocalError('invalid_configuration');}
 if(typeof value!=='string'||/[\u0000-\u0020\u007f]/.test(value)||u.protocol!=='https:'||u.username||u.password||u.pathname!=='/'||u.search||u.hash)throw new LocalError('invalid_configuration');
 return u.origin;
}
export function nativeBrokerSettings(env=process.env) {
 const store=createConfigPathStore(undefined,env);
 return {read(){const url=env.PSST_BROKER_URL||store.snapshot().brokerUrl;return url?brokerOrigin(url):null;}};
}
// Called only from an explicit native command, never session_start/auth recovery.
export async function nativeSetup(ctx,{env=process.env,settings=nativeBrokerSettings(env),privateInput=promptPairingSecret,pairingConnector,stillCurrent=()=>true}={}) {
 if(!ctx?.hasUI)throw new LocalError('native_private_input_unavailable');
 const known=settings.read();
 const entered=await ctx.ui.input('Psst broker HTTPS URL',known||'https://');
 if(entered===undefined||!stillCurrent())return null;
 const brokerUrl=brokerOrigin(entered);
 if(env.PSST_BROKER_URL&&brokerOrigin(env.PSST_BROKER_URL)!==brokerUrl)throw new LocalError('broker_origin_mismatch');
 if(!await ctx.ui.confirm('Psst first-time authorization',`Connect this installation to ${brokerUrl}? The next field accepts a one-time secret privately; it is not a message.`)||!stillCurrent())return null;
 let pairingSecret=await privateInput(ctx);
 if(pairingSecret===undefined||!stillCurrent())return null;
 try {
  const result=await pairingConnector({brokerUrl,pairingSecret,directory:storageLayout(env).installationDirectory,clientType:'pi'});
  if(!stillCurrent())throw new LocalError('session_mismatch');
  return {connectionFile:result.connectionFile,brokerUrl};
 } finally {pairingSecret=undefined;}
}
