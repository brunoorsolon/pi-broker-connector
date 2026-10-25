import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { installExtension } from '../src/extension.mjs';

export default function (pi: ExtensionAPI) {
  installExtension(pi, Type);
}
