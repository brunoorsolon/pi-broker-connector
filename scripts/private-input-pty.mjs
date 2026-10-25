// Synthetic terminal probe only. Never run with a real pairing secret.
import {TuiMainScreen,ProcessTerminal,isKittyProtocolActive} from '@earendil-works/pi-tui';
import {pathToFileURL} from 'node:url';
const {maskedPairingComponent}=await import(pathToFileURL(process.argv[2]));
const terminal=new ProcessTerminal(),tui=new TuiMainScreen(terminal);
const c=maskedPairingComponent({requestRender:()=>tui.requestRender(),done(value){
 const negotiated=isKittyProtocolActive();tui.stop();
 process.stdout.write(`\nPROBE_RESULT:${JSON.stringify({kind:value===undefined?'cancel':'submit',valid:value===undefined||value==='synthetic_'.padEnd(43,'A'),negotiated})}\n`);
 process.exit(0);
}});
tui.addChild(c);tui.setFocus(c);tui.start();
setTimeout(()=>{tui.stop();process.stdout.write('\nPROBE_TIMEOUT\n');process.exit(2);},2500).unref();
