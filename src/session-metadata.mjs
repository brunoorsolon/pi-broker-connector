import { basename } from 'node:path';
import { createHash } from 'node:crypto';

const unsafe = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/gu;
function label(value, length) {
  if (typeof value !== 'string') return null;
  const clean = value.toWellFormed().replace(unsafe, ' ').trim();
  return clean ? [...clean].slice(0, length).join('') : null;
}
const read = getter => { try { return getter(); } catch { return undefined; } };

/** Observe supported Pi APIs only. Never inspect transcripts, provider config or credentials. */
export function nativeSessionMetadata(pi, ctx, { clientId, nameOverride } = {}) {
  const nativeId = read(() => ctx.sessionManager.getSessionId());
  const suffix = /^[0-9a-f-]{36}$/i.test(clientId ?? '') ? clientId.slice(0, 8)
    : createHash('sha256').update(String(nativeId ?? 'unknown')).digest('hex').slice(0, 8);
  const nativeName = read(() => ctx.sessionManager.getSessionName?.()) ?? read(() => pi.getSessionName?.());
  const name = `${label(nameOverride, 117) || label(nativeName, 117) || 'Pi'} [${suffix}]`;
  const cwd = read(() => ctx.cwd);
  // The project label is a basename, never a machine-specific absolute path.
  const project = typeof cwd === 'string' ? label(basename(cwd.replaceAll('\\', '/')), 256) : null;
  const selected = read(() => ctx.model);
  const provider = label(selected?.provider, 128), id = label(selected?.id, 256);
  const model = provider && id ? { provider, id, source: 'observed' }
    : { provider: null, id: null, source: 'unknown' };
  return { name, project: project === '.' || project === '..' ? null : project, model };
}

export function metadataSummary(metadata) {
  if (!metadata) return '';
  const model = metadata.model?.source === 'unknown' ? 'unknown' : `${metadata.model.provider}/${metadata.model.id}`;
  return `${metadata.name}; project ${metadata.project ?? 'unknown'}; model ${model}`;
}
