// Watches a durable explicit request. Caller supplies GET polling or a still-active
// explicit setup retry; startup must never supply begin/create operations.
export class ApprovalWatch {
  constructor({poll, onState, onError, isCurrent, delay=2000}) {
    this.poll=poll; this.onState=onState; this.onError=onError;
    this.isCurrent=isCurrent; this.delay=Math.max(2000,delay); this.stopped=false;
  }
  stop(){this.stopped=true;clearTimeout(this.timer);}
  start(delay=this.delay){if(this.stopped)return;this.timer=setTimeout(()=>this.tick(),delay);this.timer.unref?.();}
  current(){try{return !this.stopped&&this.isCurrent();}catch(error){this.stop();this.onError(error);return false;}}
  async tick(){
    if(!this.current()){this.stop();return;}
    let nextDelay=this.delay;
    try{
      const result=await this.poll();
      if(!this.current()){this.stop();return;}
      await this.onState(result);
      if(result.state!=='pending'){this.stop();return;}
    }catch(error){
      if(!this.current()){this.stop();return;}
      // Uncertain network outcomes retain the candidate and honor shared backoff.
      this.onError(error);
      if(Number.isFinite(error?.retryAfterMs))nextDelay=Math.min(300000,Math.max(this.delay,error.retryAfterMs));
    }
    this.start(nextDelay);
  }
}
