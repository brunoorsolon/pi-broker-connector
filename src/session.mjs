import { mkdirSync, writeFileSync, lstatSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { Inbox, newSessionIdentity } from '../vendor/broker/reference/inbox.mjs';
import { BrokerClient } from '../vendor/broker/reference/client.mjs';
import { AdapterRuntime } from '../vendor/broker/reference/runtime.mjs';
import { LocalError } from '../vendor/broker/reference/errors.mjs';
import { readPrivateJson } from './config.mjs';
import { canonical, validateMetadata } from '../vendor/broker/src/protocol.mjs';

function privateDirectory(path) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(path) !== path || (stat.mode & 0o077) !== 0
      || (process.getuid && stat.uid !== process.getuid())) throw new LocalError('invalid_configuration');
}

/** One native Pi session, one durable identity. Reload/resume reconnects it. */
export class PiBrokerSession {
  constructor({ config, hostSessionId, currentSessionId, observeMetadata, onDiagnostic = () => {}, clientOptions = {} }) {
    if (typeof hostSessionId !== 'string' || !hostSessionId || hostSessionId.length > 256) throw new LocalError('session_mismatch');
    this.hostSessionId = hostSessionId;
    this.currentSessionId = currentSessionId;
    this.closed = false;
    this.operations = new Set();
    this.config = config;
    this.observeMetadata = observeMetadata;
    this.observedMetadata = null;
    this.metadataSync = 'pending';
    this.metadataNeedsReconcile = false;
    this.metadataRefreshPromise = null;
    this.metadataRefreshRequested = false;
    this.metadataController = null;
    const root = resolve(config.stateDirectory); privateDirectory(root);
    // Endpoint and native-session binding prevent state adoption across brokers/sessions.
    const binding = createHash('sha256').update(JSON.stringify(config.credentialId ? [config.url, hostSessionId, config.credentialId] : [config.url, hostSessionId])).digest('hex');
    this.directory = join(root, binding); privateDirectory(this.directory);
    const identityFile = join(this.directory, 'identity.json');
    try { writeFileSync(identityFile, JSON.stringify({ hostSessionId, brokerUrl: config.url, ...(config.credentialId ? {credentialId:config.credentialId} : {}), identity: newSessionIdentity('pi') }), { mode: 0o600, flag: 'wx' }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    const saved = readPrivateJson(identityFile);
    if (saved.hostSessionId !== hostSessionId || saved.brokerUrl !== config.url || saved.identity?.client_type !== 'pi' || saved.credentialId !== config.credentialId) throw new LocalError('session_mismatch');
    this.inbox = new Inbox({ directory: this.directory, identity: saved.identity });
    try {
      this.client = new BrokerClient({ url: config.url, tokenFile: config.tokenFile, caFile: config.caFile, inbox: this.inbox, requestTimeoutMs: 40000, ...clientOptions });
      this.runtime = new AdapterRuntime({ client: this.client,
        verifySession: () => this.isAlive(), isAlive: () => this.isAlive(), onDiagnostic });
    } catch (error) { this.inbox.close(); throw error; }
  }
  isAlive() { return !this.closed && this.currentSessionId() === this.hostSessionId; }
  deliveryAllowed() { return this.isAlive() && !this.runtime.paused && !this.runtime.closed; }
  readMetadata() {
    return validateMetadata(this.observeMetadata ? this.observeMetadata(this.inbox.identity)
      : { name: this.config.name, model: { provider: null, id: null, source: 'unknown' }, project: null });
  }
  get metadata() { return this.observedMetadata ?? this.readMetadata(); }
  async start() {
    this.observedMetadata = this.readMetadata();
    const result = await this.runtime.start(this.observedMetadata);
    this.metadataSync = 'synced';
    return result;
  }
  async refreshMetadata() {
    if (!this.isAlive() || !this.client.attachment.lease_epoch) return false;
    this.metadataRefreshRequested = true;
    if (this.metadataRefreshPromise) return this.metadataRefreshPromise;
    const controller = new AbortController();
    this.metadataController = controller;
    // Metadata is descriptive; a failed update must not stall transport tools or
    // shutdown behind the normal long-poll request timeout.
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(3000)]);
    const pending = this.run(async () => {
      while (this.metadataRefreshRequested && this.isAlive()) {
        this.metadataRefreshRequested = false;
        const desired = this.readMetadata();
        this.observedMetadata = desired;
        this.metadataSync = 'pending';
        try {
          // A lost PATCH response may have applied. Reconcile ownership and revision
          // before another mutation; never blindly retry a stale compare-and-swap.
          if (this.metadataNeedsReconcile) await this.client.refreshOwnedMetadata({ signal });
          if (!this.isAlive()) return false;
          if (canonical(this.inbox.getState('metadata')) !== canonical(desired)) {
            await this.client.updateMetadata(desired, { signal });
          }
          this.metadataNeedsReconcile = false;
          this.metadataSync = 'synced';
        } catch (error) {
          this.metadataNeedsReconcile = true;
          throw error;
        }
      }
      return true;
    });
    this.metadataRefreshPromise = pending;
    try { return await pending; }
    finally {
      if (this.metadataRefreshPromise === pending) this.metadataRefreshPromise = null;
      if (this.metadataController === controller) this.metadataController = null;
    }
  }
  async run(operation) {
    if (!this.isAlive()) throw new LocalError('session_mismatch');
    const work = Promise.resolve().then(operation);
    this.operations.add(work);
    try { return await work; } finally { this.operations.delete(work); }
  }
  async close() {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    this.metadataController?.abort();
    this.closePromise = (async () => {
      // Do not permanently close broker identity on /reload or /resume. Lease expires
      // when absent; same verified native-session identity reconnects on return.
      await this.runtime.stop({ closeSession: false });
      await Promise.allSettled([...this.operations]);
      this.inbox.close();
    })();
    return this.closePromise;
  }
}
