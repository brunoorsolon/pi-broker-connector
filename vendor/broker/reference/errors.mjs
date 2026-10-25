/** Local errors deliberately never include content, paths, credentials or native responses. */
const MESSAGES = {
  invalid_configuration: 'Correct the local adapter configuration before retrying.',
  session_mismatch: 'Verify the exact surviving harness session; do not adopt its mailbox.',
  owner_conflict: 'Another worker owns this session inbox. Stop it before starting another.',
  storage_unavailable: 'Restore local durable storage before retrying.',
  inbox_full: 'The local inbox or deduplication budget is full; preserve pending input.',
  envelope_mismatch: 'A message ID changed its immutable envelope. Pause and inspect the protocol.',
  envelope_expired: 'The transport deadline passed; do not accept a new inbox item.',
  invalid_envelope: 'The broker envelope is invalid; no inbox item was accepted.',
  invalid_response: 'The broker response is invalid. Reconcile the original operation.',
  request_failed: 'The network result is unknown. Retry only the original idempotent operation.',
  request_aborted: 'The request was canceled. Reconcile any potentially applied operation.',
  retry_window_elapsed: 'The automatic retry window ended. Reconcile; do not allocate a replacement key.',
  send_conflict: 'The local send key already names a different request.',
  injection_uncertain: 'Native acceptance is uncertain. The local FIFO head is paused for operator review.',
  unsafe_boundary: 'Keep the input pending until the harness provides a verified safe boundary.',
  receipt_required: 'A supported native acceptance receipt is required before consumption is recorded.',
  unknown_tool: 'Use a documented broker tool name.',
};

export class LocalError extends Error {
  constructor(code, { effect = 'not_applied', retryable = false, field = null } = {}) {
    super(MESSAGES[code] ?? MESSAGES.invalid_configuration);
    this.name = 'LocalError';
    this.code = code;
    this.effect = effect;
    this.retryable = retryable;
    this.field = field;
  }
  toJSON() {
    return { error: { code: this.code, message: this.message, action: this.message,
      retryable: this.retryable, effect: this.effect, field: this.field,
      contract_ref: 'docs/reference.md#local-errors' } };
  }
}

export function safeError(error) {
  if (error instanceof LocalError) return error.toJSON();
  if (error?.toJSON && error?.name === 'BrokerError') return error.toJSON();
  return new LocalError('storage_unavailable', { effect: 'unknown' }).toJSON();
}
