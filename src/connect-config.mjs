import { LocalError } from '../vendor/broker/reference/errors.mjs';
import { homedir } from 'node:os';
import { resolve, join } from 'node:path';
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
  const root = resolve(env.PSST_STATE_DIR || resolve(homedir(), '.local/state/psst/pi'));
  try {
    const result = await pairingConnector({pairingFile:file,directory:join(root,'installations'),clientType:'pi'});
    return validateConfigPath(result.connectionFile);
  } catch (error) {
    const codes = ['credential_expired','unauthenticated','forbidden','idempotency_conflict','rate_limited','enrollment_busy','enrollment_capacity','enrollment_transport_error','invalid_pairing_file','invalid_enrollment_receipt'];
    throw new LocalError(codes.includes(error?.code) ? error.code : 'invalid_configuration', {effect:error?.effect === 'not_applied' ? 'not_applied' : 'unknown'});
  }
}
