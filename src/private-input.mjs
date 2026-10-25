import { matchesKey, isKeyRelease, decodeKittyPrintable } from '@earendil-works/pi-tui';
import { LocalError } from '../vendor/broker/reference/errors.mjs';

// A focused native component: the value never enters Pi's editor or a message.
// Use public host decoders for control keys and Kitty printable input; legacy text/paste stays masked.
export function maskedPairingComponent({done,requestRender}) {
  let value='',closed=false,pasting=false,paste='',invalidPaste=false,hint=false;
  const finish=result=>{if(closed)return;closed=true;value='';paste='';done(result);};
  const append=data=>{if(/^[A-Za-z0-9_-]+$/.test(data)&&value.length+data.length<=43){value+=data;hint=false;}};
  return {
    render(width){return ['Psst: enter the one-time pairing secret (hidden)', '*'.repeat(value.length), hint?'Paste the complete 43-character pairing secret.':'Enter: connect   Esc or Ctrl+C: cancel'].map(line=>line.slice(0,Math.max(0,width)));},
    invalidate(){},
    handleInput(data){
      if(closed||typeof data!=='string'||isKeyRelease(data))return;
      if(matchesKey(data,'escape')||matchesKey(data,'ctrl+c')){finish(undefined);return;}
      if(matchesKey(data,'enter')){if(!pasting){if(/^[A-Za-z0-9_-]{43}$/.test(value))finish(value);else{hint=true;requestRender();}}return;}
      if(!pasting&&matchesKey(data,'backspace')){value=value.slice(0,-1);hint=false;requestRender();return;}
      // Pi normally wraps a whole paste; tolerate marker/body/end delivered separately.
      if(data.startsWith('\x1b[200~')){pasting=true;paste='';invalidPaste=false;data=data.slice(6);}
      if(pasting){
        const end=data.indexOf('\x1b[201~');
        const body=end<0?data:data.slice(0,end);
        if(!/^[A-Za-z0-9_-]*$/.test(body)||paste.length+body.length>43)invalidPaste=true;
        if(!invalidPaste)paste+=body;
        if(end>=0){if(data.slice(end+6))invalidPaste=true;if(!invalidPaste)append(paste);else hint=true;paste='';pasting=false;invalidPaste=false;}
      }else{
        append(decodeKittyPrintable(data)??data);
      }
      requestRender();
    },
    dispose(){closed=true;value='';paste='';},
  };
}
export async function promptPairingSecret(ctx) {
  if(!ctx?.hasUI||typeof ctx.ui?.custom!=='function')throw new LocalError('native_private_input_unavailable');
  return ctx.ui.custom((tui,_theme,_keys,done)=>maskedPairingComponent({done,requestRender:()=>tui.requestRender()}));
}
