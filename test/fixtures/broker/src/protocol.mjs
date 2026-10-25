import { createHash } from 'node:crypto';

export const TYPES = Object.freeze(['pi', 'antigravity-cli', 'claude-code', 'opencode']);
export const DEFAULTS = Object.freeze({
  heartbeat_seconds: 60, lease_seconds: 180, claim_seconds: 120, max_wait_seconds: 30,
  default_ttl_seconds: 86400, min_ttl_seconds: 60, max_ttl_seconds: 604800,
  max_message_bytes: 65536, max_request_bytes: 98304,
  max_pending_messages: 1000, max_pending_bytes: 67108864,
  send_per_minute: 60, send_burst: 20, max_attempts: 10,
  retention_seconds: 604800, registration_retention_seconds: 86400,
  retry_window_seconds: 86400,
});

const ERROR_TEXT = Object.freeze({
  invalid_request: ['The request does not match the v1 contract.', 'Correct the indicated field before retrying.'],
  unauthenticated: ['Authentication is required.', 'Use an enrolled credential through the Authorization header.'],
  forbidden: ['This operation is not authorized.', 'Check the enrolled adapter permissions.'],
  recipient_not_found: ['The recipient is not available.', 'Select an exact authorized client ID from discovery.'],
  message_not_found: ['The message is not available.', 'Use a message ID owned by this principal.'],
  identity_conflict: ['The session identity conflicts with an existing registration.', 'Do not adopt another session; verify the local session identity.'],
  stale_lease_epoch: ['Reconnect this session before retrying.', 'Read owned registration state and reconnect; do not blindly replay a mutation.'],
  idempotency_conflict: ['This key was already used for a different request.', 'Reconcile the original request; do not change an uncertain request.'],
  metadata_conflict: ['The metadata revision changed.', 'Read the current revision and reconcile the metadata patch.'],
  claim_conflict: ['The claim is not current.', 'Reconcile the claim before acknowledging or requesting another.'],
  session_closed: ['This session is closed.', 'Create a new identity only for a new harness session.'],
  message_expired: ['The message transport deadline passed.', 'Read the receipt; expiry does not retract an accepted inbox item.'],
  payload_too_large: ['The request exceeds a byte or item limit.', 'Reduce the indicated field before retrying.'],
  incompatible_receiver_transport: ['The recipient does not support this durable-inbox transport.', 'Choose a compatible recipient or update its adapter.'],
  receiving_disabled: ['The recipient has disabled transport receiving.', 'Wait for the recipient operator to enable receiving.'],
  rate_limited: ['The request rate limit was reached.', 'Honor Retry-After; reuse the same key for an uncertain request.'],
  mailbox_full: ['The destination mailbox is full.', 'Honor Retry-After; do not discard or duplicate an uncertain send.'],
  storage_unavailable: ['Durable storage is unavailable.', 'Restore storage health; retry only with the original idempotency key.'],
  not_ready: ['The broker is not ready.', 'Wait for readiness; retry only idempotent operations.'],
});

function contractReference(field) {
  if (field === 'headers.X-Lease-Epoch') return 'openapi.json#/components/parameters/LeaseEpoch';
  if (field === 'headers.X-Client-ID') return 'openapi.json#/components/parameters/ClientId';
  if (field === 'headers.Idempotency-Key') return 'openapi.json#/components/parameters/IdempotencyKey';
  return 'openapi.json#/components/schemas/Error';
}

export class ApiError extends Error {
  constructor(status, code, field = null, options = {}) {
    const text = ERROR_TEXT[code] ?? ERROR_TEXT.invalid_request;
    super(options.message ?? text[0]);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.field = field;
    this.retryable = options.retryable ?? [429, 503].includes(status);
    this.effect = options.effect ?? 'not_applied';
    this.action = options.action ?? text[1];
    this.contract_ref = options.contract_ref ?? contractReference(field);
    this.retry_after = options.retry_after;
    this.details = options.details;
  }

  toJSON(requestId) {
    const error = {
      code: this.code, message: this.message, retryable: this.retryable,
      field: this.field, contract_ref: this.contract_ref, action: this.action,
      effect: this.effect, request_id: requestId ?? null,
    };
    if (this.details !== undefined) error.details = this.details;
    return { error };
  }
}

function invalid(field, code = 'invalid_request', status = 400) {
  throw new ApiError(status, code, field);
}

function object(value, allowed, required, path) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid(path);
  for (const key of Object.keys(value)) if (!allowed.includes(key)) invalid(path);
  for (const key of required) if (!Object.hasOwn(value, key)) invalid(`${path}.${key}`);
  return value;
}

function string(value, path, { maxChars = 256, maxBytes = maxChars * 4, minChars = 0, nullable = false, label = false } = {}) {
  if (nullable && value === null) return null;
  if (typeof value !== 'string' || !value.isWellFormed()) invalid(path);
  const size = [...value].length;
  if (size < minChars) invalid(path);
  if (size > maxChars || Buffer.byteLength(value, 'utf8') > maxBytes) invalid(path, 'payload_too_large', 413);
  if (label && /[\u0000-\u001f\u007f-\u009f]/u.test(value)) invalid(path);
  return value;
}

function integer(value, min, max, path) {
  if (!Number.isSafeInteger(value) || value < min || value > max) invalid(path);
  return value;
}

function boolean(value, path) {
  if (typeof value !== 'boolean') invalid(path);
  return value;
}

function oneOf(value, values, path) {
  if (!values.includes(value)) invalid(path);
  return value;
}

export function validateUuid(value, path = 'id') {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) invalid(path);
  return value.toLowerCase();
}

export function validateIdempotencyKey(value, path = 'headers.Idempotency-Key') {
  if (typeof value !== 'string' || !/^[A-Za-z0-9._~:+\/-]{1,128}$/.test(value)) invalid(path);
  return value;
}

function model(value, path) {
  object(value, ['provider', 'id', 'source'], ['provider', 'id', 'source'], path);
  const result = {
    provider: string(value.provider, `${path}.provider`, { maxChars: 128, nullable: true, label: true }),
    id: string(value.id, `${path}.id`, { maxChars: 256, nullable: true, label: true }),
    source: oneOf(value.source, ['observed', 'configured', 'unknown'], `${path}.source`),
  };
  if (result.source === 'unknown' && (result.id !== null || result.provider !== null)) invalid(path);
  return result;
}

export function validateMetadata(value, { patch = false, path = 'body.metadata' } = {}) {
  object(value, ['name', 'model', 'project'], patch ? [] : ['name', 'model', 'project'], path);
  if (patch && Object.keys(value).length === 0) invalid(path);
  const result = {};
  if (Object.hasOwn(value, 'name')) result.name = string(value.name, `${path}.name`, { maxChars: 128, minChars: 1, label: true });
  if (Object.hasOwn(value, 'model')) result.model = model(value.model, `${path}.model`);
  if (Object.hasOwn(value, 'project')) result.project = string(value.project, `${path}.project`, { maxChars: 256, nullable: true, label: true });
  return result;
}

export function validateRegistration(value) {
  const fields = ['protocol_version', 'client_id', 'client_type', 'session_instance_id', 'connection_id', 'previous_epoch', 'metadata', 'capabilities'];
  object(value, fields, fields, 'body');
  const type = oneOf(value.client_type, TYPES, 'body.client_type');
  const c = object(value.capabilities, ['protocol_version', 'adapter_version', 'client_type', 'receive_enabled', 'durable_inbox'], ['protocol_version', 'adapter_version', 'client_type', 'receive_enabled', 'durable_inbox'], 'body.capabilities');
  if (c.client_type !== type) invalid('body.capabilities.client_type');
  return {
    protocol_version: oneOf(value.protocol_version, ['1'], 'body.protocol_version'),
    client_id: validateUuid(value.client_id, 'body.client_id'),
    client_type: type,
    session_instance_id: validateUuid(value.session_instance_id, 'body.session_instance_id'),
    connection_id: validateUuid(value.connection_id, 'body.connection_id'),
    previous_epoch: integer(value.previous_epoch, 0, Number.MAX_SAFE_INTEGER - 1, 'body.previous_epoch'),
    metadata: validateMetadata(value.metadata),
    capabilities: {
      protocol_version: oneOf(c.protocol_version, ['1'], 'body.capabilities.protocol_version'),
      adapter_version: string(c.adapter_version, 'body.capabilities.adapter_version', { maxChars: 128, minChars: 1, label: true }),
      client_type: type,
      receive_enabled: boolean(c.receive_enabled, 'body.capabilities.receive_enabled'),
      durable_inbox: boolean(c.durable_inbox, 'body.capabilities.durable_inbox'),
    },
  };
}

export function validateMetadataPatch(value) {
  object(value, ['metadata_patch', 'expected_metadata_revision'], ['metadata_patch', 'expected_metadata_revision'], 'body');
  return {
    metadata_patch: validateMetadata(value.metadata_patch, { patch: true, path: 'body.metadata_patch' }),
    expected_metadata_revision: integer(value.expected_metadata_revision, 1, Number.MAX_SAFE_INTEGER, 'body.expected_metadata_revision'),
  };
}

function content(value, path, limits = DEFAULTS) {
  object(value, ['type', 'text'], ['type', 'text'], path);
  return {
    type: oneOf(value.type, ['text/plain'], `${path}.type`),
    text: string(value.text, `${path}.text`, { maxChars: Math.min(DEFAULTS.max_message_bytes, limits.max_message_bytes), maxBytes: Math.min(DEFAULTS.max_message_bytes, limits.max_message_bytes) }),
  };
}

export function validateSend(value, { limits: configured = DEFAULTS } = {}) {
  const limits = { ...DEFAULTS, ...configured };
  object(value, ['recipient_id', 'content', 'ttl_seconds', 'correlation_id', 'reply_to_message_id', 'metadata_patch', 'expected_metadata_revision'], ['recipient_id', 'content'], 'body');
  const result = {
    recipient_id: validateUuid(value.recipient_id, 'body.recipient_id'),
    content: content(value.content, 'body.content', limits),
    ttl_seconds: integer(value.ttl_seconds ?? limits.default_ttl_seconds, Math.max(DEFAULTS.min_ttl_seconds, limits.min_ttl_seconds), Math.min(DEFAULTS.max_ttl_seconds, limits.max_ttl_seconds), 'body.ttl_seconds'),
    correlation_id: string(value.correlation_id ?? null, 'body.correlation_id', { maxChars: 128, maxBytes: 512, nullable: true }),
    reply_to_message_id: value.reply_to_message_id == null ? null : validateUuid(value.reply_to_message_id, 'body.reply_to_message_id'),
  };
  if (Object.hasOwn(value, 'ttl_seconds') && value.ttl_seconds === null) invalid('body.ttl_seconds');
  if (Object.hasOwn(value, 'metadata_patch')) {
    if (!Object.hasOwn(value, 'expected_metadata_revision')) invalid('body.expected_metadata_revision');
    result.metadata_patch = validateMetadata(value.metadata_patch, { patch: true, path: 'body.metadata_patch' });
    result.expected_metadata_revision = integer(value.expected_metadata_revision, 1, Number.MAX_SAFE_INTEGER, 'body.expected_metadata_revision');
  } else if (Object.hasOwn(value, 'expected_metadata_revision')) invalid('body.expected_metadata_revision');
  return result;
}

export function validateClaim(value, { limits: configured = DEFAULTS } = {}) {
  const limits = { ...DEFAULTS, ...configured };
  object(value, ['wait_seconds'], [], 'body');
  return { wait_seconds: integer(Object.hasOwn(value, 'wait_seconds') ? value.wait_seconds : 0, 0, Math.min(DEFAULTS.max_wait_seconds, limits.max_wait_seconds), 'body.wait_seconds') };
}

export function validateRenew(value) {
  object(value, ['claim_id'], ['claim_id'], 'body');
  return { claim_id: validateUuid(value.claim_id, 'body.claim_id') };
}

export function validateCompletion(value) {
  object(value, ['claim_id', 'outcome', 'reason'], ['claim_id', 'outcome'], 'body');
  const outcome = oneOf(value.outcome, ['delivered', 'retryable_not_stored', 'permanent_not_stored'], 'body.outcome');
  const reason = oneOf(value.reason ?? 'none', ['none', 'inbox_full', 'storage_unavailable', 'unsupported_envelope'], 'body.reason');
  if (Object.hasOwn(value, 'reason') && value.reason === null) invalid('body.reason');
  if (outcome === 'delivered' && reason !== 'none') invalid('body.reason');
  return { claim_id: validateUuid(value.claim_id, 'body.claim_id'), outcome, reason };
}

export function validateEmpty(value) {
  object(value, [], [], 'body');
  return {};
}

function timestamp(value, path) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value) || !Number.isFinite(Date.parse(value))) invalid(path);
  const normalized = new Date(Date.parse(value)).toISOString();
  if (normalized !== (value.includes('.') ? value : value.replace('Z', '.000Z'))) invalid(path);
  return value;
}

export function validateEnvelope(value) {
  const fields = ['protocol_version', 'message_id', 'recipient_id', 'recipient_sequence', 'sender', 'origin', 'authority', 'content', 'accepted_at', 'expires_at', 'correlation_id', 'reply_to_message_id'];
  object(value, fields, fields, 'envelope');
  object(value.sender, ['client_id', 'client_type', 'name', 'model', 'project', 'metadata_revision'], ['client_id', 'client_type', 'name', 'model', 'project', 'metadata_revision'], 'envelope.sender');
  const meta = validateMetadata({ name: value.sender.name, model: value.sender.model, project: value.sender.project }, { path: 'envelope.sender' });
  const acceptedAt = timestamp(value.accepted_at, 'envelope.accepted_at');
  const expiresAt = timestamp(value.expires_at, 'envelope.expires_at');
  if (Date.parse(expiresAt) <= Date.parse(acceptedAt)) invalid('envelope.expires_at');
  return {
    protocol_version: oneOf(value.protocol_version, ['1'], 'envelope.protocol_version'),
    message_id: validateUuid(value.message_id, 'envelope.message_id'),
    recipient_id: validateUuid(value.recipient_id, 'envelope.recipient_id'),
    recipient_sequence: integer(value.recipient_sequence, 1, Number.MAX_SAFE_INTEGER, 'envelope.recipient_sequence'),
    sender: { client_id: validateUuid(value.sender.client_id, 'envelope.sender.client_id'), client_type: oneOf(value.sender.client_type, TYPES, 'envelope.sender.client_type'), ...meta, metadata_revision: integer(value.sender.metadata_revision, 1, Number.MAX_SAFE_INTEGER, 'envelope.sender.metadata_revision') },
    origin: oneOf(value.origin, ['broker_agent'], 'envelope.origin'),
    authority: oneOf(value.authority, ['untrusted_agent_input'], 'envelope.authority'),
    content: content(value.content, 'envelope.content'),
    accepted_at: acceptedAt, expires_at: expiresAt,
    correlation_id: string(value.correlation_id, 'envelope.correlation_id', { maxChars: 128, maxBytes: 512, nullable: true }),
    reply_to_message_id: value.reply_to_message_id === null ? null : validateUuid(value.reply_to_message_id, 'envelope.reply_to_message_id'),
  };
}

/**
 * v1 canonical JSON: recursively sort object keys by UTF-16 code units, serialize
 * primitives with JSON.stringify, preserve array order, and encode as UTF-8.
 * No Unicode normalization. Reject non-JSON values, malformed Unicode, cycles,
 * excessive nesting, unsafe/nonfinite numbers, and sparse arrays.
 */
export function canonical(value) {
  const ancestors = new Set();
  function visit(item, depth) {
    if (depth > 32) invalid('canonical.depth');
    if (item === null || typeof item === 'boolean') return JSON.stringify(item);
    if (typeof item === 'string') {
      if (!item.isWellFormed()) invalid('canonical.string');
      return JSON.stringify(item);
    }
    if (typeof item === 'number') {
      if (!Number.isFinite(item) || (Number.isInteger(item) && !Number.isSafeInteger(item))) invalid('canonical.number');
      return JSON.stringify(item);
    }
    if (typeof item !== 'object' || ancestors.has(item)) invalid('canonical.value');
    ancestors.add(item);
    let result;
    if (Array.isArray(item)) {
      if (item.length > 10000) invalid('canonical.array');
      const parts = [];
      for (let i = 0; i < item.length; i++) {
        if (!Object.hasOwn(item, i)) invalid('canonical.array');
        parts.push(visit(item[i], depth + 1));
      }
      result = `[${parts.join(',')}]`;
    } else {
      if (![Object.prototype, null].includes(Object.getPrototypeOf(item))) invalid('canonical.object');
      const keys = Object.keys(item).sort();
      if (keys.length > 10000) invalid('canonical.object');
      result = `{${keys.map((key) => {
        if (!key.isWellFormed()) invalid('canonical.key');
        return `${JSON.stringify(key)}:${visit(item[key], depth + 1)}`;
      }).join(',')}}`;
    }
    ancestors.delete(item);
    return result;
  }
  return visit(value, 0);
}

export function digest(value) {
  return createHash('sha256').update(canonical(value), 'utf8').digest('hex');
}
