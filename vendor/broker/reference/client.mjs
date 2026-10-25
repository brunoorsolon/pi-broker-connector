import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { readFileSync, openSync, fstatSync, closeSync, constants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { ApiError, canonical, validateMetadata, validateRegistration, validateMetadataPatch,
  validateClaim, validateCompletion, validateRenew, validateUuid } from '../src/protocol.mjs';
import { LocalError } from './errors.mjs';

const ALLOWED_ERROR_CODES = new Set(['invalid_request', 'unauthenticated', 'forbidden', 'recipient_not_found',
  'message_not_found', 'identity_conflict', 'stale_lease_epoch', 'idempotency_conflict', 'metadata_conflict',
  'claim_conflict', 'session_closed', 'message_expired', 'payload_too_large',
  'incompatible_receiver_transport', 'receiving_disabled', 'rate_limited', 'mailbox_full',
  'storage_unavailable', 'not_ready']);

export class BrokerError extends LocalError {
  constructor(status, value, retryAfter = 0) {
    super('invalid_response', { effect: 'unknown' });
    this.name = 'BrokerError';
    this.status = status;
    this.retryAfter = retryAfter;
    const raw = value?.error;
    const code = ALLOWED_ERROR_CODES.has(raw?.code) ? raw.code : 'invalid_request';
    // Never reproduce a remote free-text message or details in local tools/logs.
    this.api = new ApiError(status, code, null, {
      effect: ['not_applied', 'unknown'].includes(raw?.effect) ? raw.effect : 'unknown',
      retryable: raw?.retryable === true && [429, 503].includes(status),
    });
    this.code = this.api.code;
    this.message = this.api.message;
    this.effect = this.api.effect;
    this.retryable = this.api.retryable;
  }
  toJSON() { return this.api.toJSON(null); }
}

function readSecret(path) {
  let fd;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(fd);
    if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.size > 8192
      || (process.getuid && stat.uid !== process.getuid())) throw new Error('invalid');
    const token = readFileSync(fd, 'utf8').trim();
    if (!/^[A-Za-z0-9_-]{43,256}$/.test(token)) throw new Error('invalid');
    return token;
  } catch { throw new LocalError('invalid_configuration', { field: 'tokenFile' }); }
  finally { if (fd !== undefined) closeSync(fd); }
}

function positiveSeconds(value, fallback) {
  return Number.isSafeInteger(value) && value > 0 && value <= 365 * 86400 ? value : fallback;
}

/** HTTPS-only by default. No redirects; no credential-bearing URLs or command-line arguments. */
export class BrokerClient {
  constructor({ url, tokenFile, tokenEnvironment, caFile, insecureDevelopment = false, inbox,
    now = Date.now, random = Math.random, sleep = delay, maxAttempts = 4,
    maxResponseBytes = 256 * 1024, requestTimeoutMs = 40000 }) {
    try { this.base = new URL(url); } catch { throw new LocalError('invalid_configuration', { field: 'url' }); }
    const host = this.base.hostname.replace(/^\[|\]$/g, '');
    if (this.base.username || this.base.password || this.base.search || this.base.hash || this.base.pathname !== '/'
      || !['https:', 'http:'].includes(this.base.protocol)
      || (this.base.protocol === 'http:' && (!insecureDevelopment || !['127.0.0.1', '::1'].includes(host)))) {
      throw new LocalError('invalid_configuration', { field: 'url' });
    }
    if (!inbox || (!tokenFile && !tokenEnvironment) || (tokenFile && tokenEnvironment)
      || !Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 10
      || !Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1024 || maxResponseBytes > 1048576
      || !Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs < 100 || requestTimeoutMs > 120000) throw new LocalError('invalid_configuration');
    this.inbox = inbox;
    this.now = now;
    this.random = random;
    this.sleep = sleep;
    this.maxAttempts = maxAttempts;
    this.maxResponseBytes = maxResponseBytes;
    this.requestTimeoutMs = requestTimeoutMs;
    this.tokenFile = tokenFile;
    this.tokenEnvironment = tokenEnvironment;
    try { this.ca = caFile ? readFileSync(caFile) : undefined; }
    catch { throw new LocalError('invalid_configuration', { field: 'caFile' }); }
    this.clockOffset = 0;
    this.connectPromise = null;
  }

  get identity() { return this.inbox.identity; }
  get attachment() { return this.inbox.getState('attachment') ?? {}; }
  get policy() { return this.attachment.policy ?? {}; }
  serverNow() { return this.now() + this.clockOffset; }

  credential() {
    if (this.tokenFile) return readSecret(this.tokenFile);
    const token = process.env[this.tokenEnvironment];
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43,256}$/.test(token)) throw new LocalError('invalid_configuration', { field: 'tokenEnvironment' });
    return token;
  }

  async request(method, path, { body, key, session = true, signal, idempotent = false, deadline = Infinity } = {}) {
    if (!/^\/v1\/[A-Za-z0-9_/?=&.%+~-]+$/.test(path)) throw new LocalError('invalid_configuration');
    for (let attempt = 0; ; attempt++) {
      if (this.now() >= deadline) throw new LocalError('retry_window_elapsed', { effect: 'unknown' });
      try { return await this.requestOnce(method, path, { body, key, session, signal, timeoutMs: Math.min(this.requestTimeoutMs, deadline - this.now()) }); }
      catch (error) {
        if (signal?.aborted) throw new LocalError('request_aborted', { effect: 'unknown' });
        const retryable = error instanceof BrokerError ? error.retryable
          : error instanceof LocalError && error.code === 'request_failed';
        if (!idempotent || !retryable || attempt + 1 >= this.maxAttempts) throw error;
        const milliseconds = Math.max(error.retryAfter * 1000 || 0, Math.min(10000, 250 * 2 ** attempt) * (0.8 + this.random() * 0.4));
        if (this.now() + milliseconds >= deadline) throw new LocalError('retry_window_elapsed', { effect: 'unknown' });
        try { await this.sleep(milliseconds, undefined, { signal }); }
        catch { throw new LocalError('request_aborted', { effect: 'unknown' }); }
      }
    }
  }

  requestOnce(method, path, { body, key, session, signal, timeoutMs }) {
    const serialized = body === undefined ? null : canonical(body);
    if (serialized && Buffer.byteLength(serialized) > 98304) throw new LocalError('invalid_configuration', { field: 'body' });
    const headers = { Accept: 'application/json', Authorization: `Bearer ${this.credential()}` };
    if (session) {
      if (!Number.isSafeInteger(this.attachment.lease_epoch) || this.attachment.lease_epoch < 1) throw new LocalError('session_mismatch');
      headers['X-Client-ID'] = this.identity.client_id;
      headers['X-Lease-Epoch'] = String(this.attachment.lease_epoch);
    }
    if (key) headers['Idempotency-Key'] = key;
    if (serialized !== null) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(serialized); }
    const target = new URL(path, this.base);
    return new Promise((resolve, reject) => {
      let settled = false;
      let absoluteTimer;
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(absoluteTimer);
        if (error) reject(error); else resolve(value);
      };
      const transport = target.protocol === 'https:' ? httpsRequest : httpRequest;
      const request = transport(target, { method, headers, signal, ca: this.ca,
        rejectUnauthorized: true, timeout: timeoutMs, maxHeaderSize: 16384 }, response => {
        const chunks = [];
        let bytes = 0;
        response.on('data', chunk => {
          bytes += chunk.length;
          if (bytes > this.maxResponseBytes) { finish(new LocalError('invalid_response', { effect: 'unknown' })); response.destroy(); }
          else chunks.push(chunk);
        });
        response.on('error', () => finish(new LocalError('request_failed', { effect: 'unknown', retryable: true })));
        response.on('end', () => {
          try {
            const status = response.statusCode;
            if (status === 204) { finish(null, null); return; }
            if (!String(response.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) throw new LocalError('invalid_response', { effect: 'unknown' });
            const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
            if (status < 200 || status >= 300) {
              const retryAfter = /^\d+$/.test(String(response.headers['retry-after'] ?? '')) ? Math.min(3600, Number(response.headers['retry-after'])) : 0;
              finish(new BrokerError(status, value, retryAfter)); return;
            }
            const timestamp = value?.server_time;
            // Registration/send/completion retries may return their original
            // stored result. Historical server_time is not a current clock sample.
            if ((method === 'GET' || path.endsWith('/heartbeat') || method === 'PATCH')
              && typeof timestamp === 'string' && Number.isFinite(Date.parse(timestamp))) this.clockOffset = Date.parse(timestamp) - this.now();
            finish(null, value);
          } catch (error) { finish(error instanceof LocalError ? error : new LocalError('invalid_response', { effect: 'unknown' })); }
        });
      });
      request.on('timeout', () => request.destroy());
      request.on('error', () => finish(new LocalError(signal?.aborted ? 'request_aborted' : 'request_failed', { effect: 'unknown', retryable: !signal?.aborted })));
      absoluteTimer = setTimeout(() => request.destroy(), timeoutMs);
      request.end(serialized);
    });
  }

  capabilities(receiveEnabled = true) {
    return { protocol_version: '1', adapter_version: '0.1.0', client_type: this.identity.client_type,
      receive_enabled: receiveEnabled, durable_inbox: true };
  }

  applyRegistration(result, pending) {
    if (!result || result.client_id !== this.identity.client_id || !Number.isSafeInteger(result.lease_epoch)
      || result.lease_epoch !== pending.body.previous_epoch + 1 || !Number.isSafeInteger(result.metadata_revision)
      || result.metadata_revision < 1 || !result.policy) throw new LocalError('invalid_response', { effect: 'unknown' });
    this.inbox.setState('attachment', { ...this.attachment, ...result, connection_id: pending.body.connection_id });
    this.inbox.setState('metadata', pending.body.metadata);
    this.inbox.setState('registration_pending', null);
    this.inbox.setState('claim_pending', null);
    return result;
  }

  async register(metadata, { receiveEnabled = true, signal } = {}) {
    let pending = this.inbox.getState('registration_pending');
    if (!pending) {
      const body = validateRegistration({ protocol_version: '1', ...this.identity, connection_id: randomUUID(),
        previous_epoch: this.attachment.lease_epoch ?? 0, metadata: validateMetadata(metadata), capabilities: this.capabilities(receiveEnabled) });
      pending = { body, retry_until: this.now() + positiveSeconds(this.policy.registration_retry_seconds, 86400) * 1000 };
      this.inbox.setState('registration_pending', pending);
    }
    const result = await this.request('POST', '/v1/sessions', { body: pending.body, session: false,
      idempotent: true, deadline: pending.retry_until, signal });
    const state = await this.request('GET', `/v1/sessions/${this.identity.client_id}`, { session: false, idempotent: true, signal });
    if (state?.client_id !== this.identity.client_id || state.session_instance_id !== this.identity.session_instance_id
      || state.client_type !== this.identity.client_type || state.connection_id !== pending.body.connection_id
      || state.lease_epoch !== result?.lease_epoch) throw new LocalError('session_mismatch', { effect: 'unknown' });
    const confirmed = this.applyRegistration({ ...result, server_time: state.server_time, lease_expires_at: state.lease_expires_at }, pending);
    if (state.closed === true) throw new BrokerError(410, { error: { code: 'session_closed', effect: 'unknown' } });
    if (state.connected !== true || Date.parse(state.lease_expires_at) <= this.serverNow()) {
      throw new BrokerError(409, { error: { code: 'stale_lease_epoch', effect: 'unknown' } });
    }
    return confirmed;
  }

  async reconnect({ verifySession, signal, metadata, receiveEnabled } = {}) {
    if (this.connectPromise) return this.connectPromise;
    this.connectPromise = this.reconnectOnce({ verifySession, signal, metadata, receiveEnabled });
    try { return await this.connectPromise; } finally { this.connectPromise = null; }
  }

  async reconnectOnce({ verifySession, signal, metadata, receiveEnabled }) {
    if (typeof verifySession !== 'function' || await verifySession(this.identity) !== true) throw new LocalError('session_mismatch');
    const local = this.attachment;
    const pending = this.inbox.getState('registration_pending');
    const state = await this.request('GET', `/v1/sessions/${this.identity.client_id}`, { session: false, idempotent: true, signal });
    if (state.client_id !== this.identity.client_id || state.session_instance_id !== this.identity.session_instance_id
      || state.client_type !== this.identity.client_type || !Number.isSafeInteger(state.lease_epoch)
      || ![local.connection_id, pending?.body.connection_id].filter(Boolean).includes(state.connection_id)) throw new LocalError('session_mismatch');
    if (state.closed === true || state.closed_at != null) throw new BrokerError(410, { error: { code: 'session_closed', effect: 'not_applied' } });
    // The owned-state read is a reconciliation, not permission to steal a different attachment.
    this.inbox.setState('attachment', { ...local, lease_epoch: state.lease_epoch, connection_id: state.connection_id,
      metadata_revision: state.metadata_revision, policy: state.policy ?? local.policy });
    this.inbox.setState('registration_pending', null);
    const refreshedMetadata = metadata ?? pending?.body.metadata ?? state.metadata ?? this.inbox.getState('metadata');
    return this.register(refreshedMetadata, { receiveEnabled: receiveEnabled ?? pending?.body.capabilities.receive_enabled ?? state.capabilities?.receive_enabled ?? false, signal });
  }

  async heartbeat({ signal } = {}) {
    return this.request('POST', `/v1/sessions/${this.identity.client_id}/heartbeat`, { body: {}, idempotent: true, signal });
  }

  async closeSession({ signal } = {}) {
    return this.request('POST', `/v1/sessions/${this.identity.client_id}/close`, { body: {}, idempotent: true, signal });
  }

  async listClients(filters = {}, { signal } = {}) {
    const allowed = ['connected', 'client_type', 'name', 'project', 'limit', 'cursor'];
    if (Object.keys(filters).some(key => !allowed.includes(key))) throw new LocalError('invalid_configuration');
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(filters)) query.set(key, String(value));
    return this.request('GET', `/v1/clients${query.size ? `?${query}` : ''}`, { idempotent: true, signal });
  }

  async updateMetadata(patch, { expectedRevision = this.attachment.metadata_revision, signal } = {}) {
    const body = validateMetadataPatch({ metadata_patch: patch, expected_metadata_revision: expectedRevision });
    // CAS is not blindly retried after response loss: read owned state to reconcile first.
    const result = await this.request('PATCH', `/v1/sessions/${this.identity.client_id}/metadata`, { body, signal });
    if (!Number.isSafeInteger(result?.metadata_revision)) throw new LocalError('invalid_response', { effect: 'unknown' });
    this.inbox.setState('attachment', { ...this.attachment, metadata_revision: result.metadata_revision });
    this.inbox.setState('metadata', { ...this.inbox.getState('metadata'), ...patch });
    return result;
  }

  async refreshOwnedMetadata({ signal } = {}) {
    const state = await this.request('GET', `/v1/sessions/${this.identity.client_id}`, { session: false, idempotent: true, signal });
    if (state.client_id !== this.identity.client_id || state.session_instance_id !== this.identity.session_instance_id
      || state.connection_id !== this.attachment.connection_id || state.lease_epoch !== this.attachment.lease_epoch
      || !Number.isSafeInteger(state.metadata_revision)) throw new LocalError('session_mismatch');
    const metadata = validateMetadata(state.metadata);
    this.inbox.setState('attachment', { ...this.attachment, metadata_revision: state.metadata_revision });
    this.inbox.setState('metadata', metadata);
    return metadata;
  }

  prepareSend(request, options = {}) {
    return this.inbox.prepareSend(request, { retryWindowSeconds: positiveSeconds(this.policy.send_retry_seconds, 86400), ...options });
  }

  async sendPrepared(key, { signal } = {}) {
    const operation = this.inbox.outgoing(key);
    if (!operation) throw new LocalError('invalid_configuration');
    if (operation.result) return { ...operation.result, send_key: key };
    const result = await this.request('POST', '/v1/messages', { body: operation.request, key, idempotent: true,
      deadline: operation.retry_until, signal });
    try { validateUuid(result?.message_id); } catch { throw new LocalError('invalid_response', { effect: 'unknown' }); }
    this.inbox.recordSendResult(key, result);
    if (operation.request.metadata_patch) {
      this.inbox.setState('metadata', { ...this.inbox.getState('metadata'), ...operation.request.metadata_patch });
      // Sender revision is not guessed; reconcile from owned state before a future CAS mutation.
    }
    return { ...result, send_key: key };
  }

  async messageStatus(messageId, { signal } = {}) {
    return this.request('GET', `/v1/messages/${validateUuid(messageId)}`, { idempotent: true, signal });
  }

  async claim(waitSeconds = 30, { signal } = {}) {
    let pending = this.inbox.getState('claim_pending');
    if (!pending) {
      pending = { key: randomUUID(), body: validateClaim({ wait_seconds: waitSeconds }), lease_epoch: this.attachment.lease_epoch };
      this.inbox.setState('claim_pending', pending);
    }
    if (pending.lease_epoch !== this.attachment.lease_epoch) throw new LocalError('session_mismatch');
    const result = await this.request('POST', '/v1/mailbox/claim', { body: pending.body, key: pending.key, idempotent: true, signal });
    if (result === null) this.inbox.setState('claim_pending', null);
    return result;
  }

  async complete(messageId, completion, { signal } = {}) {
    const result = await this.request('POST', `/v1/mailbox/${validateUuid(messageId)}/complete`, {
      body: validateCompletion(completion), idempotent: true, signal });
    this.inbox.setState('claim_pending', null);
    return result;
  }

  async renew(messageId, claimId, { signal } = {}) {
    return this.request('POST', `/v1/mailbox/${validateUuid(messageId)}/renew`, {
      body: validateRenew({ claim_id: claimId }), idempotent: true, signal });
  }
}
