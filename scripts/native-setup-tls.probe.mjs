// Explicit development probe: disposable credentials/CA only; no model account.
import {pathToFileURL,fileURLToPath} from 'node:url';
if(!process.env.PSST_TEST_BROKER_ROOT||!process.env.PI_TEST_INSTALL)throw Error('Set PSST_TEST_BROKER_ROOT and PI_TEST_INSTALL to reviewed local test sources.');
const {enrollmentTlsFixture}=await import(pathToFileURL(process.env.PSST_TEST_BROKER_ROOT+'/test/enrollment-tls-fixture.mjs').href);
import {writeFileSync} from 'node:fs';import {join} from 'node:path';import {spawn} from 'node:child_process';import {once} from 'node:events';
const clean=[];const f=await enrollmentTlsFixture({after:fn=>clean.push(fn)});
try{const ticket=await f.issue('pi');writeFileSync(join(f.directory,'probe.json'),JSON.stringify({ticket,cert:f.certFile,brokerUrl:f.brokerUrl}),{mode:0o600});
const child=spawn('python3',[fileURLToPath(new URL('./native-setup-tls-host.py',import.meta.url)),join(f.directory,'probe.json')],{stdio:['ignore','pipe','pipe']});let out='',err='';child.stdout.on('data',b=>out+=b);child.stderr.on('data',b=>err+=b);const[code]=await once(child,'exit');if(code!==0)throw Error('fixture failed: '+err);
const credentials=f.store.db.prepare('SELECT count(*) n FROM enrolled_credentials').get().n;const sessions=f.store.db.prepare('SELECT count(*) n FROM sessions').get().n;if(credentials!==1||sessions!==2)throw Error('unexpected issuance or sessions');console.log(JSON.stringify({...JSON.parse(out),credentials,sessions}));}finally{for(const fn of clean.reverse())await fn();}
