import { constants, openSync, closeSync, fstatSync, readFileSync, realpathSync, mkdirSync, lstatSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { LocalError } from '../vendor/broker/reference/errors.mjs';

export function validateConfigPath(value) {
  if (typeof value !== 'string' || !isAbsolute(value) || value.length > 4096 || /[\x00-\x1f\x7f]/.test(value)) throw new LocalError('invalid_configuration');
  return value;
}

// This TXT contains a path only, never the bundle or token.
export function createConfigPathStore(home = homedir()) {
  const directory = join(home, '.config', 'psst');
  const file = join(directory, 'pi-config-path');
  return {
    read() {
      let fd;
      try {
        try { lstatSync(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
        if (realpathSync(file) !== file) throw new Error();
        fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
        const stat = fstatSync(fd);
        if (!stat.isFile() || stat.size > 4097 || (stat.mode & 0o077) || (process.getuid && stat.uid !== process.getuid())) throw new Error();
        return validateConfigPath(readFileSync(fd, 'utf8').replace(/\n$/, ''));
      } catch { throw new LocalError('invalid_configuration'); }
      finally { if (fd !== undefined) closeSync(fd); }
    },
    write(path) {
      validateConfigPath(path);
      let temporary;
      try {
        mkdirSync(directory, { recursive: true, mode: 0o700 });
        const stat = lstatSync(directory);
        if (realpathSync(directory) !== directory || !stat.isDirectory() || (stat.mode & 0o077) || (process.getuid && stat.uid !== process.getuid())) throw new Error();
        temporary = join(directory, `.pi-config-path-${randomUUID()}`);
        writeFileSync(temporary, `${path}\n`, { mode: 0o600, flag: 'wx' });
        renameSync(temporary, file);
      } catch { throw new LocalError('invalid_configuration'); }
      finally { if (temporary) { try { unlinkSync(temporary); } catch {} } }
    },
  };
}
