import os,pty,subprocess,tempfile,pathlib,select,time,json,signal,shutil,sys,sqlite3
control=json.loads(pathlib.Path(sys.argv[1]).read_text());ticket=json.loads(pathlib.Path(control['ticket']).read_text());secret=ticket['pairing_secret'];root=pathlib.Path(tempfile.mkdtemp(prefix='pi-setup-tls-'));agent=root/'persistent-agent';project=str(pathlib.Path(__file__).resolve().parents[1]);host=pathlib.Path(os.environ['PI_TEST_INSTALL'])
assert json.loads((host/'node_modules/@earendil-works/pi-coding-agent/package.json').read_text())['version']=='1.4.0'
allout=b''
def cycle(first):
 global allout
 home=root/('home-first' if first else 'home-recreated');home.mkdir()
 if first:
  legacy=home/'.local/state/psst/pi';legacy.mkdir(parents=True,mode=0o700);(legacy/'old-pending-marker').write_text('old inbox data stays put')
 m,s=pty.openpty();env={'PATH':os.environ['PATH'],'HOME':str(home),'PI_CODING_AGENT_DIR':str(agent),'PI_OFFLINE':'1','TERM':'xterm-256color','NODE_EXTRA_CA_CERTS':control['cert']}
 p=subprocess.Popen(['node',str(host/'node_modules/@earendil-works/pi-coding-agent/dist/cli.js'),'--offline','--no-extensions','--no-mcp','--no-skills','--no-context-files','--no-approve','--no-prompt-templates','--no-themes','--no-tools','-e',project+'/extensions/psst.ts'],stdin=s,stdout=s,stderr=s,env=env,cwd=home,start_new_session=True);os.close(s);out=b''
 def read(seconds):
  nonlocal out
  end=time.monotonic()+seconds
  while time.monotonic()<end:
   if select.select([m],[],[],0.1)[0]:
    try:out+=os.read(m,65536)
    except OSError:return
 try:
  read(3)
  if first:
   os.write(m,b'/psst-setup\r');read(1);assert b'broker HTTPS URL' in out,'URL UI absent'
   os.write(m,control['brokerUrl'].encode()+b'\r');read(1)
   os.write(m,b'\r');read(1)
   assert b'one-time pairing secret' in out,'private UI absent'
   os.write(m,b'\x1b[200~'+secret.encode()+b'\x1b[201~');read(.2);os.write(m,b'\r');read(3)
   assert b'installation connected' in out,'native setup did not connect'
   assert (legacy/'old-pending-marker').read_text()=='old inbox data stays put'
  else:
   assert b'Psst: connected' in out,'recreated HOME did not auto-connect'
  assert secret.encode() not in out,'secret echoed';allout+=out
 finally:
  os.killpg(p.pid,signal.SIGTERM);p.wait(timeout=5);os.close(m)
try:
 cycle(True)
 def saved():
  db=sqlite3.connect(agent/'psst/selection.sqlite');value=json.loads(db.execute('SELECT value FROM selection').fetchone()[0]);db.close();return value
 pointer=saved();assert str(agent) in pointer['connectionFile']
 cycle(False);assert saved()==pointer
 print(json.dumps({'native_setup_real_tls':True,'home_recreated_autoconnect':True,'initial_legacy_root_preserved':True,'terminal_secret_leak':False}))
finally:shutil.rmtree(root)
