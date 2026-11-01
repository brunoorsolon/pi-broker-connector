import { digest } from '../src/protocol.mjs';
import { LocalError, safeError } from './errors.mjs';
import { provenance } from './runtime.mjs';

/** Native host tool facade, not an MCP transport or a generic TUI injection API. */
export function createTools({ client, inbox = client?.inbox, observeMetadata = null, cooperativeBoundary = null }) {
  if (!client || !inbox) throw new LocalError('invalid_configuration');
  const internalOperation=(kind,context)=>{
    if(context?.operationId!==undefined){
      if(typeof context.operationId!=='string'||!context.operationId||context.operationId.length>1024)throw new LocalError('invalid_configuration');
      const operationId=digest({kind,operation_id:context.operationId}),existing=inbox.outgoingForOperation(operationId);
      return {operationId,...(existing?{key:existing.key}:{}),...(context.operationStartedAt===undefined?{}:{operationStartedAt:context.operationStartedAt})};
    }
    return {};
  };
  const publicResult=value=>{const {send_key,...result}=value;return result;};
  return {
    async broker_list_clients(arguments_ = {}, context = {}) { return client.listClients(arguments_,{signal:context.signal}); },
    async broker_send(arguments_, context = {}) {
      if (!arguments_ || typeof arguments_ !== 'object' || Array.isArray(arguments_)
        || Object.keys(arguments_).some(key => !['recipient_id', 'text', 'ttl_seconds', 'correlation_id', 'reply_to_message_id'].includes(key))) throw new LocalError('invalid_configuration');
      const operation=internalOperation('send',context);let key=operation.key;
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
            await client.refreshOwnedMetadata({signal:context.signal});
            request.metadata_patch = observed; request.expected_metadata_revision = client.attachment.metadata_revision;
          }
        }
        key = client.prepareSend(request,operation);
        return publicResult(await client.sendPrepared(key,{signal:context.signal}));
      } catch (error) { return safeError(error); }
    },
    async broker_update_metadata(arguments_, context = {}) {
      if (!arguments_ || Object.keys(arguments_).some(key => !['metadata_patch', 'expected_metadata_revision'].includes(key))) throw new LocalError('invalid_configuration');
      return client.updateMetadata(arguments_.metadata_patch, { expectedRevision: arguments_.expected_metadata_revision, signal:context.signal });
    },
    async broker_sent_history(arguments_ = {}, context = {}) { return client.sentHistory(arguments_,{signal:context.signal}); },
    async broker_resend(arguments_, context = {}) {
      if(!arguments_||Object.keys(arguments_).some(key=>!['message_id','ttl_seconds'].includes(key)))throw new LocalError('invalid_configuration');
      const operation=internalOperation('resend',context),{message_id,...input}=arguments_;
      return publicResult(await client.resendPrepared(client.prepareResend(message_id,input,operation),{signal:context.signal}));
    },
    async broker_cancel(arguments_, context = {}) {
      if(!arguments_||Object.keys(arguments_).join(',')!=='message_id')throw new LocalError('invalid_configuration');
      return client.cancelMessage(arguments_.message_id,{signal:context.signal});
    },
    async broker_message_content(arguments_, context = {}) {
      if(!arguments_||Object.keys(arguments_).join(',')!=='message_id') throw new LocalError('invalid_configuration');
      return client.messageContent(arguments_.message_id,{signal:context.signal});
    },
    async broker_presence_events(arguments_ = {}, context = {}) { return client.presenceEvents(arguments_, {signal:context.signal}); },
    async broker_acknowledge_presence_event(arguments_, context = {}) {
      if (!arguments_ || Object.keys(arguments_).join(',') !== 'event_id') throw new LocalError('invalid_configuration');
      return client.acknowledgePresenceEvent(arguments_.event_id, {signal:context.signal});
    },
    async broker_message_status(arguments_, context = {}) {
      if (!arguments_ || Object.keys(arguments_).join(',') !== 'message_id') throw new LocalError('invalid_configuration');
      return client.messageStatus(arguments_.message_id,{signal:context.signal});
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

export async function invokeTool(tools, name, arguments_, context = {}) {
  if (!Object.hasOwn(tools, name) || typeof tools[name] !== 'function') return new LocalError('unknown_tool').toJSON();
  try { return await tools[name](arguments_,context); }
  catch (error) { return safeError(error); }
}
