import { readEnrollmentReceipt } from '../vendor/broker/reference/enrollment.mjs';
import { openSync, closeSync, fstatSync, readFileSync, realpathSync, lstatSync } from 'node:fs';
import { isAbsolute, dirname, resolve, basename } from 'node:path';
import { storageLayout } from './storage.mjs';
import { constants } from 'node:fs';
import { LocalError } from '../vendor/broker/reference/errors.mjs';

export function readPrivateJson(path) {
  let fd;
  try {
    if (!isAbsolute(path) || realpathSync(path) !== path) throw new Error();
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 65536 || (stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid())) throw new Error();
    return JSON.parse(readFileSync(fd, 'utf8'));
  } catch { throw new LocalError('invalid_configuration'); }
  finally { if (fd !== undefined) closeSync(fd); }
}

export function readConfig(env = process.env, explicitPath) {
  const selected = explicitPath || env.PSST_CONFIG_FILE || env.PSST_CONFIG;
  if (!selected) return null;
  const path = resolve(selected);
  const raw = readPrivateJson(path);
  if (raw.format !== 'broker-client-bundle-v1' || !Array.isArray(raw.allowed_client_types) || !raw.allowed_client_types.includes('pi')
      || raw.protocol_version !== '1' || raw.file_paths_relative_to !== 'connection_file_directory'
      || raw.authorization_header !== 'Authorization' || raw.authorization_scheme !== 'Bearer' || raw.insecure_development !== false
      || typeof raw.token_file !== 'string' || !raw.token_file || basename(raw.token_file) !== raw.token_file || ['.', '..'].includes(raw.token_file)
      || typeof raw.broker_url !== 'string' || (raw.ca_file !== undefined && (typeof raw.ca_file !== 'string' || !raw.ca_file))) throw new LocalError('invalid_configuration');
  let url;
  try { url = new URL(raw.broker_url); } catch { throw new LocalError('invalid_configuration'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new LocalError('invalid_configuration');
  let credentialId;
  const enrollmentFile = resolve(dirname(path), 'enrollment.json');
  let hasEnrollment = false;
  try { lstatSync(enrollmentFile); hasEnrollment = true; } catch (error) { if (error.code !== 'ENOENT') throw new LocalError('invalid_configuration'); }
  if (raw.enrollment_receipt_file !== undefined && raw.enrollment_receipt_file !== 'enrollment.json') throw new LocalError('invalid_configuration');
  if (hasEnrollment || raw.enrollment_receipt_file === 'enrollment.json') {
    try { credentialId = readEnrollmentReceipt({connectionFile:path,clientType:'pi'}).credentialId; }
    catch (error) { throw new LocalError(error?.code === 'credential_expired' ? 'credential_expired' : 'invalid_configuration'); }
  }
  const configuredBroker=env.PSST_BROKER_URL;
  if(configuredBroker){let expected;try{expected=new URL(configuredBroker);}catch{throw new LocalError('invalid_configuration');}if(expected.protocol!=='https:'||expected.username||expected.password||expected.search||expected.hash||expected.pathname!=='/'||expected.origin!==url.origin)throw new LocalError('broker_origin_mismatch');}
  const name = env.PSST_NAME || 'Pi';
  if (name.length > 128 || /[\x00-\x1f\x7f]/.test(name)) throw new LocalError('invalid_configuration');
  return { url: url.href, ...(credentialId ? {credentialId} : {}), tokenFile: resolve(dirname(path), raw.token_file),
    ...(raw.ca_file ? { caFile: resolve(dirname(path), raw.ca_file) } : {}),
    ...storageLayout(env), name };
}
