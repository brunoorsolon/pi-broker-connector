"""Disposable official-Pi PTY driver. Control JSON contains paths/URL, no credentials.
Parent owns real HTTPS broker/admin interactions via JSON-line event notifications.
"""
import os, pty, subprocess, pathlib, select, time, json, signal, sys, shutil, uuid, sqlite3
signal.signal(signal.SIGTERM,lambda *_: (_ for _ in ()).throw(InterruptedError('fixture canceled')))
control=json.loads(pathlib.Path(sys.argv[1]).read_text())
root=pathlib.Path(control['directory']); agent=root/'persistent-agent'; agent.mkdir(mode=0o700,exist_ok=True); transcript=b''
def event(name):
 print(json.dumps({'event':name}),flush=True)
def cycle(first):
 global transcript
 home=root/('home-first' if first else 'home-recreated');home.mkdir()
 master,slave=pty.openpty()
 env={'PATH':os.environ['PATH'],'HOME':str(home),'PI_CODING_AGENT_DIR':str(agent),'PI_OFFLINE':'1','TERM':'xterm-256color','NODE_EXTRA_CA_CERTS':control['cert']}
 args=['node',control['piCli'],'--offline','--no-extensions','--no-mcp','--no-skills','--no-context-files','--no-approve','--no-prompt-templates','--no-themes','--no-tools','-e',control['extension']]
 container=None
 if control.get('containerImage'):
  engine=control.get('containerEngine','docker');container='psst-pi-fixture-'+str(uuid.uuid4())
  args=[engine,'run','--rm','--name',container,'--network','host','--interactive','--tty','--user',str(os.getuid())+':'+str(os.getgid()),
   '--mount','type=bind,src='+str(agent)+',dst=/persistent-agent',
   '--mount','type=bind,src='+control['cert']+',dst=/fixture-ca.pem,readonly',
   '--env','HOME=/tmp/pi-home','--env','PI_CODING_AGENT_DIR=/persistent-agent','--env','PI_OFFLINE=1','--env','TERM=xterm-256color','--env','NODE_EXTRA_CA_CERTS=/fixture-ca.pem',
   '--entrypoint','/bin/sh',control['containerImage'],'-c','mkdir -p /tmp/pi-home; cd /tmp/pi-home; exec "$@"','--',
   'node','/opt/pi-host/node_modules/@earendil-works/pi-coding-agent/dist/cli.js',*args[2:-1],'/connector/extensions/psst.ts']
 proc=subprocess.Popen(args,stdin=slave,stdout=slave,stderr=slave,env=env,cwd=home,start_new_session=True);os.close(slave);output=b''
 def read(seconds=.1):
  nonlocal output
  end=time.monotonic()+seconds
  while time.monotonic()<end:
   if select.select([master],[],[],.1)[0]:
    try:output+=os.read(master,65536)
    except OSError:return
 def until(predicate,label,timeout=30):
  end=time.monotonic()+timeout
  while time.monotonic()<end:
   read()
   if predicate():return
   if proc.poll() is not None:raise RuntimeError('Pi exited before '+label)
  raise RuntimeError('Timed out waiting for '+label)
 def has_native_message(marker):
  receipt=False
  for database in agent.glob('psst/**/inbox.sqlite'):
   connection=sqlite3.connect('file:'+str(database)+'?mode=ro',uri=True,timeout=.1)
   try:
    for envelope,native_receipt in connection.execute("SELECT envelope,native_receipt FROM inbox WHERE native_receipt LIKE 'pi:%'"):
     if json.loads(envelope)['content']['text']==marker:receipt=True
    assert connection.execute('SELECT count(*) FROM cooperative_receipts').fetchone()[0]==0,'automatic delivery fabricated explicit-read receipt'
   finally:connection.close()
  if not receipt:return False
  for file in agent.glob('sessions/**/*.jsonl'):
   for line in file.read_text().splitlines():
    try:row=json.loads(line)
    except ValueError:continue
    if row.get('type')=='custom_message' and row.get('customType')=='psst-agent-message' and marker in str(row.get('content')):return True
  return False
 try:
  read(3)
  if first:
   os.write(master,b'/psst-setup\r');until(lambda:b'broker HTTPS URL' in output,'URL input')
   os.write(master,control['brokerUrl'].encode()+b'\r')
   until(lambda:b'pending administrator approval' in output,'pending request')
   assert b'one-time pairing secret' not in output,'obsolete secret input shown'
   event('pending')
   if control.get('deferApproval'):return
   until(lambda:b'installation connected' in output,'admin-approved connection')
   event('connected')
   until(lambda:has_native_message(control['messageMarker']),'automatic native JSONL receipt')
   event('native_received')
  else:
   until(lambda:b'Psst: connected' in output,'persisted automatic connection')
   assert b'broker HTTPS URL' not in output,'recreated HOME prompted setup'
   event('recreated_connected')
   until(lambda:has_native_message(control['messageMarker']+'-reopened'),'reopened automatic native JSONL receipt')
   event('recreated_received')
 finally:
  transcript+=output
  if proc.poll() is None:os.killpg(proc.pid,signal.SIGTERM)
  try:proc.wait(timeout=10)
  finally:
   if container:subprocess.run([engine,'rm','-f',container],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=15,check=False)
   os.close(master)
try:
 cycle(True)
 if control.get('deferApproval'):event('pending_closed')
 # Simulate disposable HOME removal, retaining only the documented native directory.
 shutil.rmtree(root/'home-first')
 cycle(False)
 (root/'terminal-output.bin').write_bytes(transcript)
 event('complete')
except Exception as error:
 (root/'terminal-output.bin').write_bytes(transcript)
 print(json.dumps({'event':'failure','reason':str(error)}),flush=True)
 raise
