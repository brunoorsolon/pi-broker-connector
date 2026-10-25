import { LocalError, safeError } from './errors.mjs';
import { provenance } from './runtime.mjs';

/** Native host tool facade, not an MCP transport or a generic TUI injection API. */
export function createTools({ client, inbox = client?.inbox, observeMetadata = null, cooperativeBoundary = null }) {
  if (!client || !inbox) throw new LocalError('invalid_configuration');
  return {
    async broker_list_clients(arguments_ = {}) { return client.listClients(arguments_); },
    async broker_send(arguments_) {
      if (!arguments_ || typeof arguments_ !== 'object' || Array.isArray(arguments_)
        || Object.keys(arguments_).some(key => !['recipient_id', 'text', 'ttl_seconds', 'correlation_id', 'reply_to_message_id', 'send_key'].includes(key))) throw new LocalError('invalid_configuration');
      let key = arguments_.send_key;
      try {
        const request = { recipient_id: arguments_.recipient_id, content: { type: 'text/plain', text: arguments_.text } };
        for (const field of ['ttl_seconds', 'correlation_id', 'reply_to_message_id']) if (Object.hasOwn(arguments_, field)) request[field] = arguments_[field];
        const original = key ? inbox.outgoing(key) : null;
        // Retry payload must still match. Preserve only its original metadata snapshot.
        if (original?.request.metadata_patch) {
          request.metadata_patch = original.request.metadata_patch;
          request.expected_metadata_revision = original.request.expected_metadata_revision;
        } else if (!original && observeMetadata) {
          const observed = await observeMetadata();
          if (observed) {
            await client.refreshOwnedMetadata();
            request.metadata_patch = observed; request.expected_metadata_revision = client.attachment.metadata_revision;
          }
        }
        key = client.prepareSend(request, key ? { key } : {});
        return await client.sendPrepared(key);
      } catch (error) { return { ...safeError(error), send_key: key ?? null }; }
    },
    async broker_update_metadata(arguments_) {
      if (!arguments_ || Object.keys(arguments_).some(key => !['metadata_patch', 'expected_metadata_revision'].includes(key))) throw new LocalError('invalid_configuration');
      return client.updateMetadata(arguments_.metadata_patch, { expectedRevision: arguments_.expected_metadata_revision });
    },
    async broker_message_status(arguments_) {
      if (!arguments_ || Object.keys(arguments_).join(',') !== 'message_id') throw new LocalError('invalid_configuration');
      return client.messageStatus(arguments_.message_id);
    },
    async broker_receive(arguments_ = {}) {
      if (Object.keys(arguments_).length || typeof cooperativeBoundary !== 'function') throw new LocalError('unsafe_boundary');
      // The integrating host must invoke this only inside a supported cooperative tool boundary.
      // It is deliberately a peek: returning from a JS function is not native acceptance proof.
      return cooperativeBoundary(() => {
        const head = inbox.head();
        if (!head) return { message: null, local_mode: 'cooperative_pull' };
        if (head.state !== 'pending') throw new LocalError('injection_uncertain', { effect: 'unknown' });
        return { message_id: head.message_id, message: provenance(head.envelope), local_state: 'pending',
          local_mode: 'cooperative_pull', native_acceptance_recorded: false };
      });
    },
  };
}

export async function invokeTool(tools, name, arguments_) {
  if (!Object.hasOwn(tools, name) || typeof tools[name] !== 'function') return new LocalError('unknown_tool').toJSON();
  try { return await tools[name](arguments_); }
  catch (error) { return safeError(error); }
}
