import { LocalError } from '../vendor/broker/reference/errors.mjs';
import { storageLayout } from './storage.mjs';
import { resolve, join } from 'node:path';
import {createHash} from 'node:crypto';
import {lstatSync} from 'node:fs';
import { readPrivateJson } from './config.mjs';
import { validateConfigPath } from './config-path.mjs';

// Only explicit /psst-connect invokes pairing. Loading a remembered bundle never
// creates credentials or exchanges pairing secrets in the background.
export async function resolveConnectionFile(file, { env = process.env,
  pairingConnector = async options => (await import('../vendor/broker/reference/enrollment.mjs')).connectPairingFile(options),
} = {}) {
  validateConfigPath(file);
  const raw = readPrivateJson(file);
  if (raw.format !== 'psst-pairing-v1') return file;
  const layout=storageLayout(env);let directory=layout.installationDirectory;
  // Only an already-persisted legacy attempt keeps its original retry identity.
  const previous=join(layout.stateDirectory,'installations');
  if(previous!==directory&&typeof raw.pairing_secret==='string'){try{lstatSync(join(previous,'enrollments',createHash('sha256').update(raw.pairing_secret).digest('hex'),'attempt.json'));directory=previous;}catch(e){if(e.code!=='ENOENT')throw new LocalError('invalid_configuration');}}
  try {
    const result = await pairingConnector({pairingFile:file,directory,clientType:'pi'});
    return validateConfigPath(result.connectionFile);
  } catch (error) {
    const codes = ['credential_expired','unauthenticated','forbidden','idempotency_conflict','rate_limited','enrollment_busy','enrollment_capacity','enrollment_transport_error','invalid_pairing_file','invalid_enrollment_receipt'];
    throw new LocalError(codes.includes(error?.code) ? error.code : 'invalid_configuration', {effect:error?.effect === 'not_applied' ? 'not_applied' : 'unknown'});
  }
}
