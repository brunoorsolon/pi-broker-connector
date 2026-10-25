import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { lstatSync, readdirSync, realpathSync } from 'node:fs';
import { LocalError } from '../vendor/broker/reference/errors.mjs';

const present = path => { try { lstatSync(path); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw new LocalError('invalid_configuration'); } };

// Match Pi's documented agent-directory scope. Never move a live legacy inbox:
// old plugin processes do not participate in a new migration lock.
export function storageLayout(env = process.env, home = homedir()) {
  const configured = env.PI_CODING_AGENT_DIR;
  const agent = configured ? resolve(configured === '~' ? home : configured.startsWith('~/') ? join(home, configured.slice(2)) : configured) : join(home, '.pi', 'agent');
  const nativeRoot = join(agent, 'psst');
  const legacyRoot = join(home, '.local', 'state', 'psst', 'pi');
  const legacySelection = join(home, '.config', 'psst', 'pi-config-path');
  const legacy = !env.PSST_STATE_DIR && present(legacyRoot);
  if (legacy && present(nativeRoot)) {
    const stat=lstatSync(nativeRoot);
    if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(nativeRoot)!==nativeRoot || (stat.mode&0o077) || (process.getuid && stat.uid!==process.getuid())) throw new LocalError('invalid_configuration');
    // A selection pointer alone is not a second mailbox. Any other content may
    // be enrollment/inbox state: never choose one history and hide the other.
    if (readdirSync(nativeRoot).some(name => {
      if (name === 'pi-config-path' || name === 'selection.sqlite' || name === 'selection.sqlite-journal') return false;
      if (/^\.(?:pi-config-path-|broker-)[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(name)) {
        try { const temp=lstatSync(join(nativeRoot,name)); return !temp.isFile() || temp.isSymbolicLink() || Boolean(temp.mode&0o077) || Boolean(process.getuid && temp.uid!==process.getuid()); }
        catch (error) { if (error.code==='ENOENT') return false; throw new LocalError('invalid_configuration'); }
      }
      return true;
    })) throw new LocalError('storage_migration_required');
  }
  const stateDirectory = resolve(env.PSST_STATE_DIR || (legacy ? legacyRoot : nativeRoot));
  return { stateDirectory, selectionDirectory: nativeRoot, legacySelection, legacyStorage: legacy };
}
