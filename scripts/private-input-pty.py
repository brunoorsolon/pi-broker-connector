# Actual POSIX PTY + official Pi ProcessTerminal/TUI, with terminal-side Kitty negotiation.
import os,sys,pty,subprocess,select,time,json,struct,fcntl,termios
node,script,module,mode,encoded=sys.argv[1:]
master,slave=pty.openpty()
fcntl.ioctl(slave,termios.TIOCSWINSZ,struct.pack('HHHH',24,100,0,0))
p=subprocess.Popen([node,script,module],stdin=slave,stdout=slave,stderr=slave,close_fds=True)
os.close(slave);out=b'';sent=False;query=False
secret=b'synthetic_'+b'A'*33
def read_for(duration):
 global out
 until=time.monotonic()+duration
 while time.monotonic()<until:
  if select.select([master],[],[],0.02)[0]:
   try:out+=os.read(master,65536)
   except OSError:return
try:
 deadline=time.monotonic()+5
 while p.poll() is None and time.monotonic()<deadline:
  read_for(.03)
  if b'\x1b[?u' in out and not query:
   os.write(master,b'\x1b[?7u\x1b[?1;2c' if encoded=='kitty' else b'\x1b[?1;2c');query=True
  if query and b'pairing secret (hidden)' in out and not sent:
   read_for(.10)
   # Deliberately split raw PTY paste markers/body: ProcessTerminal must reassemble them.
   for part in [b'\x1b[20',b'0~',secret[:17],secret[17:],b'\x1b[20',b'1~']:
    os.write(master,part);time.sleep(.002)
   read_for(.08)
   key={'enter':b'\x1b[13u','escape':b'\x1b[27u','ctrlc':b'\x1b[99;5u'}[mode] if encoded=='kitty' else {'enter':b'\r','escape':b'\x1b','ctrlc':b'\x03'}[mode]
   os.write(master,key);sent=True
 read_for(.05)
 if p.poll() is None:p.terminate();p.wait(timeout=2)
 assert secret not in out,'secret reached terminal output'
 marker=b'PROBE_RESULT:'
 result=None
 if marker in out:result=json.loads(out.split(marker)[-1].splitlines()[0])
 print(json.dumps({'sent':sent,'query':query,'result':result,'exit':p.returncode,'secret_rendered':False}))
finally:
 if p.poll() is None:p.terminate();p.wait(timeout=2)
 os.close(master)
