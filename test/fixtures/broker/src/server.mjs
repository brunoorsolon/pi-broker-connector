import http from 'node:http';
import https from 'node:https';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { ApiError, validateEmpty, validateUuid, validateClaim } from './protocol.mjs';

export const isLoopback = host => ['127.0.0.1','::1','localhost'].includes(host);
export function createBrokerServer({ store, auth, enrollment, approval, admin, reservations=()=>[], host='127.0.0.1', port=8787, insecureDevelopment=false, proxyLoopback=false, proxyTransport=false, tls, pollIntervalMs=250, maxPolls=1000, requestRate=1200 }) {
  if([insecureDevelopment,proxyLoopback,proxyTransport].some(value=>typeof value!=='boolean'))throw new Error('Transport modes must be booleans.');
  if(Number(insecureDevelopment)+Number(proxyLoopback)+Number(proxyTransport)+Number(Boolean(tls))>1)throw new Error('Select exactly one TLS or explicit plaintext transport mode.');
  if(!tls&&!proxyTransport&&(!isLoopback(host)||(!insecureDevelopment&&!proxyLoopback)))throw new Error('Verified TLS is required; plaintext needs an explicit transport mode.');
  if(proxyLoopback&&!isLoopback(host))throw new Error('Loopback proxy mode is loopback-only.');
  if(insecureDevelopment&&!isLoopback(host))throw new Error('Insecure development is loopback-only.');
  if(tls&&(!tls.certFile||!tls.keyFile))throw new Error('Both TLS certificate and key files are required.');
  const polls=new Map(),peers=new Map();let stopping=false,globalWindow={at:Date.now(),count:0};
  const reply=(res,status,value,headers={})=>{if(res.destroyed||res.writableEnded)return;res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff',...headers});res.end(status===204?undefined:JSON.stringify(value));};
  const error=(res,e,id)=>{const known=e instanceof ApiError?e:new ApiError(503,'storage_unavailable',null,{retryable:true,effect:'unknown'});reply(res,known.status,known.toJSON(id),{'X-Request-ID':id,...(known.retry_after?{'Retry-After':String(known.retry_after)}:{})});};
  function guardPeer(req,enrollmentOnly=false){
    const now=Date.now(),key=(req.socket.remoteAddress??'unknown')+(enrollmentOnly?':enrollment':'');
    if(!enrollmentOnly){
      if(now-globalWindow.at>=60000)globalWindow={at:now,count:0};
      if(++globalWindow.count>requestRate*4)throw new ApiError(429,'rate_limited',null,{retryable:true,retry_after:60});
    }
    for(const [address,entry] of peers)if(now-entry.at>60000)peers.delete(address);
    if(!peers.has(key)&&peers.size>=10000)throw new ApiError(429,'rate_limited',null,{retryable:true,retry_after:60});
    const prior=peers.get(key)??{at:now,count:0};prior.count++;peers.set(key,prior);
    const limit=enrollmentOnly?Math.min(requestRate,20):requestRate;
    if(prior.count>limit)throw new ApiError(429,'rate_limited',null,{retryable:true,retry_after:60});

  }
  async function body(req,{absoluteTimeoutMs}={}){
    if(req.headers['content-encoding'])throw new ApiError(400,'invalid_request','headers.Content-Encoding');
    if(!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers['content-type']??''))throw new ApiError(400,'invalid_request','headers.Content-Type');
    if(Number(req.headers['content-length'])>store.limits.max_request_bytes)throw new ApiError(413,'payload_too_large');
    let size=0;const parts=[];
    // Node requestTimeout is periodically checked; this is a strict body deadline.
    const deadline=absoluteTimeoutMs?setTimeout(()=>req.destroy(),absoluteTimeoutMs):undefined;
    deadline?.unref();
    try{for await(const part of req){size+=part.length;if(size>store.limits.max_request_bytes)throw new ApiError(413,'payload_too_large');parts.push(part);}}
    finally{clearTimeout(deadline);}
    try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(parts)));}catch{throw new ApiError(400,'invalid_request','body');}
  }
  async function handler(req,res){
    const requestId=randomUUID();res.setHeader('X-Request-ID',requestId);
    try{
      guardPeer(req);
      const url=new URL(req.url,'http://broker.invalid');
      if(req.method==='GET'&&url.pathname==='/healthz')return reply(res,200,{status:'ok'});
      if(req.method==='GET'&&url.pathname==='/readyz'){
        try{auth.reload();}catch{}
        return reply(res,!stopping&&auth.ready&&store.safe()?200:503,{status:!stopping&&auth.ready&&store.safe()?'ready':'not_ready'});
      }
      if(admin&&req.method==='GET'&&url.pathname==='/'&&!url.search){res.writeHead(303,{Location:'/admin','Cache-Control':'no-store'});res.end();return;}
      if(admin && url.pathname.startsWith('/admin')){
        if(stopping)throw new ApiError(503,'not_ready');
        if(await admin.handle(req,res,url))return;
      }
      const approvalRoute=/^\/v1\/enrollment-requests(?:\/([^/]+))?$/.exec(url.pathname);
      if(approval&&approvalRoute){
        if(stopping)throw new ApiError(503,'not_ready');
        if(req.headers.origin)throw new ApiError(403,'forbidden','headers.Origin');
        if(url.search)throw new ApiError(400,'invalid_request','query');
        approval.proof(req.headers.authorization); // reject malformed proof before upload
        if(req.method==='GET'&&approvalRoute[1]){return reply(res,200,approval.status(req.headers.authorization,approvalRoute[1]));}
        if(req.method==='POST'&&!approvalRoute[1]){
          guardPeer(req,true);
          const input=await body(req,{absoluteTimeoutMs:10000});
          auth.reload();
          const result=approval.request(req.headers.authorization,input,[...auth.configuredEntries,...reservations()]);
          return reply(res,result.status,result.result);
        }
        throw new ApiError(400,'invalid_request');
      }
      if(enrollment && url.pathname==='/v1/enrollments' && req.method==='POST'){
        guardPeer(req,true);
        if(stopping)throw new ApiError(503,'not_ready',null,{retryable:true});
        if(req.headers.origin)throw new ApiError(403,'forbidden','headers.Origin');
        if(url.search)throw new ApiError(400,'invalid_request','query');
        try{enrollment.preflight(req.headers.authorization);}
        catch(e){res.setHeader('Connection','close');throw e instanceof ApiError?e:new ApiError(503,'not_ready',null,{retryable:true});}
        const input=await body(req,{absoluteTimeoutMs:10000});
        // Refresh after asynchronous upload; no await may separate policy snapshot and issuance.
        try{auth.reload();}catch{throw new ApiError(503,'not_ready',null,{retryable:true});}
        const issued=enrollment.redeem(req.headers.authorization,input,[...auth.configuredEntries,...reservations()]);
        return reply(res,issued.status,issued.result);
      }
      const principal=auth.authenticate(req.headers.authorization); // all API routes, including unknown ones
      if(stopping)throw new ApiError(503,'not_ready',null,{retryable:true});
      if(req.headers.origin)throw new ApiError(403,'forbidden','headers.Origin');
      // Query-string authentication and duplicate parameters are never accepted.
      const params={};for(const[k,v]of url.searchParams){if(Object.hasOwn(params,k))throw new ApiError(400,'invalid_request','query');params[k]=v;}
      if(!['/v1/clients','/v1/messages','/v1/presence-events'].includes(url.pathname)&&Object.keys(params).length)throw new ApiError(400,'invalid_request','query');
      if(url.pathname==='/v1/sessions'&&req.method==='POST')return reply(res,200,store.register(principal,await body(req)));
      if(url.pathname==='/v1/clients'&&req.method==='GET')return reply(res,200,store.list(principal,params));
      const sessionRoute=/^\/v1\/sessions\/([^/]+)(?:\/(heartbeat|metadata|close|disconnect))?$/.exec(url.pathname);
      if(sessionRoute&&req.method==='GET'&&!sessionRoute[2]){sessionRoute[1]=validateUuid(sessionRoute[1],'path.client_id');return reply(res,200,store.session(principal,sessionRoute[1]));}
      const id=validateUuid(req.headers['x-client-id'],'headers.X-Client-ID');
      if(url.pathname==='/v1/presence-events'&&req.method==='GET')return reply(res,200,store.presence.page(principal,id,params));
      const eventRoute=/^\/v1\/presence-events\/([^/]+)\/ack$/.exec(url.pathname);
      if(eventRoute&&req.method==='POST'){validateEmpty(await body(req));return reply(res,200,store.presence.acknowledge(principal,id,eventRoute[1]));}
      const rawEpoch=req.headers['x-lease-epoch'],epoch=Number(rawEpoch);
      if(url.pathname==='/v1/messages'&&req.method==='GET')return reply(res,200,store.history(principal,id,params));
      if(Object.keys(params).length)throw new ApiError(400,'invalid_request','query');
      const contentRoute=/^\/v1\/messages\/([^/]+)\/content$/.exec(url.pathname);
      if(contentRoute&&req.method==='GET')return reply(res,200,store.messageContent(principal,id,validateUuid(contentRoute[1],'path.message_id')));
      const messageRoute=/^\/v1\/messages\/([^/]+)$/.exec(url.pathname);
      if(messageRoute&&req.method==='GET'){messageRoute[1]=validateUuid(messageRoute[1],'path.message_id');return reply(res,200,store.receipt(principal,id,messageRoute[1]));}
      if(typeof rawEpoch!=='string'||!/^[1-9]\d*$/.test(rawEpoch)||!Number.isSafeInteger(epoch)||epoch<1)throw new ApiError(400,'invalid_request','headers.X-Lease-Epoch');
      if(sessionRoute){
        sessionRoute[1]=validateUuid(sessionRoute[1],'path.client_id');
        if(sessionRoute[1]!==id)throw new ApiError(403,'forbidden','headers.X-Client-ID');
        const action=sessionRoute[2],b=await body(req);
        if(action==='disconnect'&&req.method==='POST'){validateEmpty(b);return reply(res,200,store.disconnect(principal,id,epoch));}
        if(action==='heartbeat'&&req.method==='POST'){validateEmpty(b);return reply(res,200,store.heartbeat(principal,id,epoch));}
        if(action==='metadata'&&req.method==='PATCH')return reply(res,200,store.metadata(principal,id,epoch,b));
        if(action==='close'&&req.method==='POST'){validateEmpty(b);return reply(res,200,store.closeSession(principal,id,epoch));}
      }
      const lifecycle=/^\/v1\/messages\/([^/]+)\/(resend|cancel)$/.exec(url.pathname);
      if(lifecycle&&req.method==='POST'){
        const message=validateUuid(lifecycle[1],'path.message_id'),b=await body(req);
        if(lifecycle[2]==='resend'){const result=store.resend(principal,id,epoch,req.headers['idempotency-key'],message,b);return reply(res,202,result,{'Idempotency-Replayed':String(!!result._replayed)});}
        validateEmpty(b);return reply(res,200,store.cancel(principal,id,epoch,message));
      }
      if(url.pathname==='/v1/messages'&&req.method==='POST'){const result=store.send(principal,id,epoch,req.headers['idempotency-key'],await body(req));return reply(res,202,result,{'Idempotency-Replayed':String(!!result._replayed)});}
      if(url.pathname==='/v1/mailbox/claim'&&req.method==='POST'){
        const b=validateClaim(await body(req),{limits:store.limits}),key=req.headers['idempotency-key'],pollKey=`${id}:${epoch}`;
        if(polls.has(pollKey))throw new ApiError(409,'claim_conflict');
        if(polls.size>=maxPolls)throw new ApiError(429,'rate_limited',null,{retryable:true,retry_after:1});
        polls.set(pollKey,res);
        try{
          let result=store.claim(principal,id,epoch,key,b,{finalizeEmpty:false});
          const deadline=Date.now()+b.wait_seconds*1000;
          while(!result&&Date.now()<deadline&&!res.destroyed){
            await delay(Math.min(pollIntervalMs,Math.max(0,deadline-Date.now())));
            if(stopping)throw new ApiError(503,'not_ready',null,{retryable:true});
            const current=auth.authenticate(req.headers.authorization);
            result=store.claim(current,id,epoch,key,b,{finalizeEmpty:false});
          }
          if(!result&&!res.destroyed)result=store.claim(auth.authenticate(req.headers.authorization),id,epoch,key,b,{finalizeEmpty:true});
          return reply(res,result?200:204,result);
        }finally{polls.delete(pollKey);}
      }
      const mailbox=/^\/v1\/mailbox\/([^/]+)\/(renew|complete)$/.exec(url.pathname);
      if(mailbox&&req.method==='POST'){mailbox[1]=validateUuid(mailbox[1],'path.message_id');return reply(res,200,store[mailbox[2]](principal,id,epoch,mailbox[1],await body(req)));}
      throw new ApiError(404,'recipient_not_found');
    }catch(e){error(res,e,requestId);}
  }
  const server=tls?https.createServer({cert:readFileSync(tls.certFile),key:readFileSync(tls.keyFile),minVersion:'TLSv1.2'},handler):http.createServer(handler);
  server.requestTimeout=10000;server.headersTimeout=10000;server.keepAliveTimeout=5000;server.maxHeadersCount=64;server.maxConnections=1024;server.maxRequestsPerSocket=1000;
  server.on('clientError',(_err,socket)=>{if(socket.writable)socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');});
  let sweep;
  return {
    server, polls,
    async listen(){await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,host,()=>{server.removeListener('error',reject);resolve();});});sweep=setInterval(()=>{try{auth.reload();store.sweep();}catch{}},1000);sweep.unref();return server.address();},
    async close(){stopping=true;clearInterval(sweep);for(const res of polls.values())error(res,new ApiError(503,'not_ready',null,{retryable:true}),randomUUID());await new Promise(resolve=>{const timer=setTimeout(()=>server.closeAllConnections(),2000);timer.unref();server.close(()=>{clearTimeout(timer);resolve();});});server.closeAllConnections();},
  };
}
