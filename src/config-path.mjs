import {constants,openSync,closeSync,fstatSync,readFileSync,realpathSync,mkdirSync,lstatSync,chmodSync} from 'node:fs';
import {homedir} from 'node:os';
import {isAbsolute,join} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {storageLayout} from './storage.mjs';
import {LocalError} from '../vendor/broker/reference/errors.mjs';
export function validateConfigPath(value){if(typeof value!=='string'||!isAbsolute(value)||value.length>4096||/[\x00-\x1f\x7f]/.test(value))throw new LocalError('invalid_configuration');return value;}
function privateFile(file){if(realpathSync(file)!==file)throw Error();const fd=openSync(file,constants.O_RDONLY|constants.O_NOFOLLOW);try{const s=fstatSync(fd);if(!s.isFile()||(s.mode&0o077)||(process.getuid&&s.uid!==process.getuid()))throw Error();}finally{closeSync(fd);}}
export function createConfigPathStore(home=homedir(),env=process.env){
 const {selectionDirectory:directory,legacySelection}=storageLayout(env,home),file=join(directory,'selection.sqlite'),previous=join(directory,'pi-config-path');
 function legacy(){for(const candidate of [previous,legacySelection]){try{lstatSync(candidate);}catch(e){if(e.code==='ENOENT')continue;throw e;}privateFile(candidate);if(lstatSync(candidate).size>4097)throw Error();const path=validateConfigPath(readFileSync(candidate,'utf8').replace(/\n$/,''));return{connectionFile:path,brokerUrl:null,revision:'legacy-'+createHash('sha256').update(path).digest('hex')};}return{connectionFile:null,brokerUrl:null,revision:'empty'};}
 function readDatabase(db){const row=db.prepare('SELECT value FROM selection WHERE id=1').get();if(!row)return legacy();const record=JSON.parse(row.value);validateConfigPath(record.connectionFile);if(typeof record.revision!=='string'||!/^[-a-z0-9]+$/.test(record.revision)||!(record.brokerUrl===null||typeof record.brokerUrl==='string'))throw Error();return record;}
 function read(){let db;try{try{lstatSync(file);}catch(e){if(e.code==='ENOENT')return legacy();throw e;}privateFile(file);db=new DatabaseSync(file,{readOnly:true});return readDatabase(db);}catch{throw new LocalError('invalid_configuration');}finally{try{db?.close();}catch{}}}
 return{
  read(){return read().connectionFile;},snapshot:read,
  write(path,brokerUrl=null,expectedRevision){
   validateConfigPath(path);let db;
   try{
    mkdirSync(directory,{recursive:true,mode:0o700});const stat=lstatSync(directory);if(realpathSync(directory)!==directory||!stat.isDirectory()||(stat.mode&0o077)||(process.getuid&&stat.uid!==process.getuid()))throw Error();
    try{privateFile(file);}catch(e){if(e.code!=='ENOENT')throw e;}
    const fd=openSync(file,constants.O_CREAT|constants.O_WRONLY|constants.O_NOFOLLOW,0o600);closeSync(fd);chmodSync(file,0o600);
    db=new DatabaseSync(file);db.exec('PRAGMA busy_timeout=2000; PRAGMA synchronous=FULL; BEGIN IMMEDIATE; CREATE TABLE IF NOT EXISTS selection(id INTEGER PRIMARY KEY CHECK(id=1),value TEXT NOT NULL);');
    const current=readDatabase(db);if(expectedRevision!==undefined&&current.revision!==expectedRevision){db.exec('ROLLBACK');return false;}
    const value=JSON.stringify({connectionFile:path,brokerUrl,revision:randomUUID()});db.prepare('INSERT INTO selection(id,value) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value').run(value);db.exec('COMMIT');return true;
   }catch{throw new LocalError('invalid_configuration');}finally{try{db?.close();}catch{}}
  },
 };
}
