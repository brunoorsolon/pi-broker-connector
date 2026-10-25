import { LocalError } from '../vendor/broker/reference/errors.mjs';

// A focused native component: the value never enters Pi's editor or a message.
// Only base64url ticket bytes are accepted, rendering is always masked.
export function maskedPairingComponent({done,requestRender}) {
  let value='',closed=false,pasting=false;
  const finish=result=>{if(closed)return;closed=true;value='';done(result);};
  return {
    render(width){return ['Psst: enter the one-time pairing secret (hidden)', '*'.repeat(value.length), 'Enter: connect   Esc: cancel'].map(line=>line.slice(0,Math.max(0,width)));},
    invalidate(){},
    handleInput(data){
      if(closed)return;
      if(data==='\x1b'||data==='\x03'){finish(undefined);return;}
      if(data==='\r'||data==='\n'){if(!pasting&&/^[A-Za-z0-9_-]{43}$/.test(value))finish(value);return;}
      if(data==='\x7f'||data==='\b'){value=value.slice(0,-1);requestRender();return;}
      // Pi TUI may deliver bracketed paste as one event or separate chunks.
      if(data.startsWith('\x1b[200~')){pasting=true;data=data.slice(6);}
      if(data.endsWith('\x1b[201~')){pasting=false;data=data.slice(0,-6);}
      if(/^[A-Za-z0-9_-]+$/.test(data)&&value.length+data.length<=43)value+=data;
      requestRender();
    },
    dispose(){closed=true;value='';},
  };
}
export async function promptPairingSecret(ctx) {
  if(!ctx?.hasUI||typeof ctx.ui?.custom!=='function')throw new LocalError('native_private_input_unavailable');
  return ctx.ui.custom((tui,_theme,_keys,done)=>maskedPairingComponent({done,requestRender:()=>tui.requestRender()}));
}
