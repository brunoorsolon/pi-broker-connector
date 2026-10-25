import os,pty,subprocess,tempfile,pathlib,select,time,json,signal,shutil
project=pathlib.Path(__file__).resolve().parents[1]
host=pathlib.Path(os.environ['PI_TEST_INSTALL'])
root=pathlib.Path(tempfile.mkdtemp(prefix='psst-pi-private-probe-')); secret='synthetic_'.ljust(43,'A')
(root/'probe.ts').write_text('''import {promptPairingSecret} from '__PRIVATE_INPUT__';
import {writeFileSync} from 'node:fs';
export default function(pi){pi.registerCommand('psst-private-probe',{description:'synthetic private UI fixture',handler:async(_args,ctx)=>{const value=await promptPairingSecret(ctx);writeFileSync(process.env.PROBE_RESULT,JSON.stringify({matches:value==='synthetic_'.padEnd(43,'A'),nativeEntriesLeak:JSON.stringify(ctx.sessionManager.getEntries()).includes(value)}));pi.appendEntry('psst-private-probe',{result:'complete'});ctx.ui.notify('PRIVATE_PROBE_COMPLETE');}});}
'''.replace('__PRIVATE_INPUT__',str(project/'src/private-input.mjs')))
assert json.loads((host/'node_modules/@earendil-works/pi-coding-agent/package.json').read_text())['version']=='1.4.0'
m,s=pty.openpty();env={'PATH':os.environ['PATH'],'HOME':str(root),'PI_CODING_AGENT_DIR':str(root/'agent'),'PI_OFFLINE':'1','TERM':'xterm-256color','PROBE_RESULT':str(root/'result.json')}
p=subprocess.Popen(['node',str(host/'node_modules/@earendil-works/pi-coding-agent/dist/cli.js'),'--offline','--no-extensions','--no-mcp','--no-skills','--no-context-files','--no-approve','--no-prompt-templates','--no-themes','--no-tools','-e',str(root/'probe.ts')],stdin=s,stdout=s,stderr=s,env=env,cwd=root,start_new_session=True);os.close(s);out=b''
def read_for(seconds):
 global out
 end=time.monotonic()+seconds
 while time.monotonic()<end:
  if select.select([m],[],[],0.1)[0]:
   try:out+=os.read(m,65536)
   except OSError:return
try:
 read_for(3);os.write(m,b'/psst-private-probe\r');read_for(2)
 assert b'one-time pairing secret' in out, 'private prompt not shown: '+repr(out[-1000:])
 os.write(m,b'\x1b[200~'+secret.encode()+b'\x1b[201~');read_for(0.5);os.write(m,b'\r');read_for(1)
 result=json.loads((root/'result.json').read_text());assert result['matches'];assert not result['nativeEntriesLeak']
 assert secret.encode() not in out, 'secret leaked to terminal output'
 files=list((root/'agent').rglob('*.jsonl'))
 assert all(secret not in f.read_text() for f in files),'secret in native transcript'
 print(json.dumps({'official_host':'Pi1.4.0','private_ui':True,'terminal_secret_leak':False,'native_entries_secret_leak':False,'transcripts_checked':len(files),'transcript_secret_leak':False}))
finally:
 os.killpg(p.pid,signal.SIGTERM);p.wait(timeout=5);os.close(m);shutil.rmtree(root)
