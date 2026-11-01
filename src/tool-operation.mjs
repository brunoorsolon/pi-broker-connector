import { LocalError } from '../vendor/broker/reference/errors.mjs';

// The original native assistant entry owns both identity and time. Never invent
// a new timestamp/key when replaying an old tool call or after journal cleanup.
export function toolOperationContext(ctx, callId, toolName) {
  const fail = () => new LocalError('invalid_configuration', { field: 'native_operation_context' });
  if (typeof callId !== 'string' || !callId || callId.length > 512) throw fail();
  const manager = ctx?.sessionManager, sessionId = manager?.getSessionId?.();
  if (typeof sessionId !== 'string' || !sessionId || sessionId.length > 256 || typeof manager.getBranch !== 'function') throw fail();
  const branch = manager.getBranch();
  if (!Array.isArray(branch)) throw fail();
  const entry = branch.slice(-1024).reverse().find(item => item?.type === 'message' && item.message?.role === 'assistant');
  const matching = entry?.message.content?.filter?.(block => block?.type === 'toolCall' && block.id === callId && block.name === toolName);
  const operationStartedAt = Date.parse(entry?.timestamp);
  if (typeof entry?.id !== 'string' || !entry.id || entry.id.length > 128 || matching?.length !== 1 || !Number.isSafeInteger(operationStartedAt) || operationStartedAt <= 0) throw fail();
  return { operationId: JSON.stringify([sessionId, entry.id, callId]), operationStartedAt };
}
