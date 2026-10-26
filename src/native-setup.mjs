import {createConfigPathStore} from './config-path.mjs';
import {storageLayout} from './storage.mjs';
import {LocalError} from '../vendor/broker/reference/errors.mjs';
export function brokerOrigin(value) {
 let u;try{u=new URL(value);}catch{throw new LocalError('invalid_configuration');}
 if(typeof value!=='string'||/[\u0000-\u0020\u007f]/.test(value)||u.protocol!=='https:'||u.username||u.password||u.pathname!=='/'||u.search||u.hash)throw new LocalError('invalid_configuration');
 return u.origin;
}
export function nativeBrokerSettings(env=process.env) {
 const store=createConfigPathStore(undefined,env);
 return {read(){const url=env.PSST_BROKER_URL||store.snapshot().brokerUrl||store.readPending()?.brokerUrl;return url?brokerOrigin(url):null;}};
}
// Called only from an explicit native command, never session_start/auth recovery.
export async function nativeSetup(ctx,{env=process.env,settings=nativeBrokerSettings(env),approvalClient,resumeRequest,beforeBegin=()=>{},stillCurrent=()=>true}={}) {
 if(!ctx?.hasUI)throw new LocalError('native_input_unavailable');
 const entered=await ctx.ui.input('Psst broker HTTPS URL',settings.read()||'https://');
 if(entered===undefined||!stillCurrent())return null;
 const brokerUrl=brokerOrigin(entered);
 if(env.PSST_BROKER_URL&&brokerOrigin(env.PSST_BROKER_URL)!==brokerUrl)throw new LocalError('broker_origin_mismatch');
 const options={brokerUrl,directory:storageLayout(env).installationDirectory,clientType:'pi'};
 const previous=await approvalClient.readApprovalState(options);
 if(!stillCurrent())return null;
 if(previous&&previous.state!=='pending'&&!(resumeRequest?.brokerUrl===brokerUrl&&resumeRequest.requestId===previous.requestId&&previous.state==='approved')){
  if(!await ctx.ui.confirm('Request replacement authorization?', 'The existing connection stays selected until the administrator approves the replacement and it connects successfully.')||!stillCurrent())return null;
  options.replaceRequestId=previous.requestId;
 }
 await beforeBegin(options);
 if(!stillCurrent())return null;
 const result=await approvalClient.beginApproval(options);
 if(!stillCurrent())return null;
 return {...result,brokerUrl,options};
}
