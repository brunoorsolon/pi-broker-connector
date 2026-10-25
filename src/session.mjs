import { mkdirSync, writeFileSync, lstatSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { Inbox, newSessionIdentity } from '../vendor/broker/reference/inbox.mjs';
import { BrokerClient } from '../vendor/broker/reference/client.mjs';
import { AdapterRuntime } from '../vendor/broker/reference/runtime.mjs';
import { LocalError } from '../vendor/broker/reference/errors.mjs';
import { readPrivateJson } from './config.mjs';

function privateDirectory(path) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(path) !== path || (stat.mode & 0o077) !== 0
      || (process.getuid && stat.uid !== process.getuid())) throw new LocalError('invalid_configuration');
}

/** One native Pi session, one durable identity. Reload/resume reconnects it. */
export class PiBrokerSession {
  constructor({ config, hostSessionId, currentSessionId, onDiagnostic = () => {}, clientOptions = {} }) {
    if (typeof hostSessionId !== 'string' || !hostSessionId || hostSessionId.length > 256) throw new LocalError('session_mismatch');
    this.hostSessionId = hostSessionId;
    this.currentSessionId = currentSessionId;
    this.closed = false;
    this.operations = new Set();
    this.config = config;
    const root = resolve(config.stateDirectory); privateDirectory(root);
    // Endpoint and native-session binding prevent state adoption across brokers/sessions.
    const binding = createHash('sha256').update(JSON.stringify([config.url, hostSessionId])).digest('hex');
    this.directory = join(root, binding); privateDirectory(this.directory);
    const identityFile = join(this.directory, 'identity.json');
    try { writeFileSync(identityFile, JSON.stringify({ hostSessionId, brokerUrl: config.url, identity: newSessionIdentity('pi') }), { mode: 0o600, flag: 'wx' }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    const saved = readPrivateJson(identityFile);
    if (saved.hostSessionId !== hostSessionId || saved.brokerUrl !== config.url || saved.identity?.client_type !== 'pi') throw new LocalError('session_mismatch');
    this.inbox = new Inbox({ directory: this.directory, identity: saved.identity });
    try {
      this.client = new BrokerClient({ url: config.url, tokenFile: config.tokenFile, caFile: config.caFile, inbox: this.inbox, requestTimeoutMs: 40000, ...clientOptions });
      this.runtime = new AdapterRuntime({ client: this.client,
        verifySession: () => this.isAlive(), isAlive: () => this.isAlive(), onDiagnostic });
    } catch (error) { this.inbox.close(); throw error; }
  }
  isAlive() { return !this.closed && this.currentSessionId() === this.hostSessionId; }
  async start() {
    return this.runtime.start({ name: this.config.name,
      model: { provider: null, id: null, source: 'unknown' }, project: null });
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
