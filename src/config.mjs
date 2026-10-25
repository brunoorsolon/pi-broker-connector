import { openSync, closeSync, fstatSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, dirname, resolve, basename } from 'node:path';
import { homedir } from 'node:os';
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
  const name = env.PSST_NAME || 'Pi';
  if (name.length > 128 || /[\x00-\x1f\x7f]/.test(name)) throw new LocalError('invalid_configuration');
  return { url: url.href, tokenFile: resolve(dirname(path), raw.token_file),
    ...(raw.ca_file ? { caFile: resolve(dirname(path), raw.ca_file) } : {}),
    stateDirectory: resolve(env.PSST_STATE_DIR || resolve(homedir(), '.local/state/psst/pi')), name };
}
