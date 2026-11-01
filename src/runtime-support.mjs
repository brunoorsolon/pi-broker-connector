// Keep this module free of SQLite/runtime imports: it runs before loading the adapter.
import { readFileSync } from 'node:fs';
export const CONNECTOR_VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
export const NODE_RANGE = '>=24.19.0 <25';
export function supportedNode(version = process.versions.node) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  return Boolean(match && Number(match[1]) === 24 && Number(match[2]) >= 19);
}
export function runtimeDescription(version = process.versions.node) {
  const shown = /^\d+\.\d+\.\d+$/.test(version) ? version : 'unknown';
  return `Psst connector ${CONNECTOR_VERSION}; Node ${shown}; required ${NODE_RANGE}; setup=url-approval`;
}
export function installUnsupportedRuntime(pi, version = process.versions.node) {
  const message = `${runtimeDescription(version)}. Unsupported runtime: start Pi with a supported Node 24 version, then reload. No enrollment or storage changes were attempted.`;
  const report = async (_args, ctx) => { if (ctx?.hasUI) ctx.ui.notify(message, 'warning'); };
  for (const name of ['psst-setup', 'psst-connect', 'psst-status', 'psst-doctor']) {
    pi.registerCommand(name, { description: 'Explain the unsupported Psst runtime', handler: report });
  }
  pi.on('session_start', report);
}
