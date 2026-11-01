import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { supportedNode, installUnsupportedRuntime } from '../src/runtime-support.mjs';

export default async function (pi: ExtensionAPI) {
  if (!supportedNode()) { installUnsupportedRuntime(pi); return; }
  const { installExtension } = await import('../src/extension.mjs');
  installExtension(pi, Type);
}
