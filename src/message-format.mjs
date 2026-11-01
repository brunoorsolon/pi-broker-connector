import { canonical, validateEnvelope } from '../vendor/broker/src/protocol.mjs';
import { provenance as legacyProvenance } from '../vendor/broker/reference/runtime.mjs';
import { LocalError } from '../vendor/broker/reference/errors.mjs';

export const NATIVE_FORMAT = 'compact-v1';

// Versioned presentation only. Wire validation/authenticated origin and native
// custom-message role are unchanged. Do not change compact-v1 after publication:
// persisted handoffs must reconcile against the exact format originally sent.
export function nativeMessage(rawEnvelope, format = NATIVE_FORMAT) {
  if (format === null || format === 'legacy-v1') return legacyProvenance(rawEnvelope);
  if (format !== NATIVE_FORMAT) throw new LocalError('invalid_configuration');
  const envelope = validateEnvelope(rawEnvelope);
  const sender = { name: envelope.sender.name, client_type: envelope.sender.client_type };
  if (envelope.sender.project?.trim()) sender.project = envelope.sender.project;
  const model = {};
  for (const key of ['provider', 'id']) if (envelope.sender.model[key]?.trim()) model[key] = envelope.sender.model[key];
  if (Object.keys(model).length) sender.model = { ...model, source: envelope.sender.model.source };
  const data = { message_id: envelope.message_id, sender, text: envelope.content.text };
  if (envelope.correlation_id) data.correlation_id = envelope.correlation_id;
  if (envelope.reply_to_message_id) data.reply_to_message_id = envelope.reply_to_message_id;
  // ASCII controls are JSON escaped; escape terminal/bidi controls as well.
  const escaped = canonical(data).replace(/[\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/gu,
    char => `\\u${char.codePointAt(0).toString(16).padStart(4, '0')}`);
  return `Broker message from AI agent ${envelope.sender.client_id}\n${escaped}`;
}
