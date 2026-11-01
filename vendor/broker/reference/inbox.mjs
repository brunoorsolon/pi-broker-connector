import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, lstatSync, statfsSync, readdirSync, chmodSync, realpathSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { canonical, digest, validateEnvelope, validateUuid, validateSend, validateIdempotencyKey, validateResend, TYPES } from '../src/protocol.mjs';
import { LocalError } from './errors.mjs';

export function newSessionIdentity(clientType) {
  if (!TYPES.includes(clientType)) throw new LocalError('invalid_configuration');
  return { client_id: randomUUID(), session_instance_id: randomUUID(), client_type: clientType };
}

function identityValue(identity) {
  if (!identity || Object.keys(identity).sort().join(',') !== 'client_id,client_type,session_instance_id'
    || !TYPES.includes(identity.client_type)) throw new LocalError('invalid_configuration');
  return { client_id: validateUuid(identity.client_id), session_instance_id: validateUuid(identity.session_instance_id), client_type: identity.client_type };
}

/** One session-bound durable journal. A separate SQLite OS lock survives no process crash. */
export class Inbox {
  constructor({ directory, identity, now = Date.now, maxPendingCount = 1000,
    maxPendingBytes = 64 * 1024 * 1024, maxLedgerCount = 50000,
    maxOutgoingCount = 10000, maxDatabaseBytes = 128 * 1024 * 1024,
    minFreeBytes = 16 * 1024 * 1024, retentionSeconds = 8 * 86400,
    diskCheck, failurePoint = () => {} }) {
    this.identity = identityValue(identity);
    this.now = now;
    this.failurePoint = failurePoint;
    this.retentionSeconds = retentionSeconds;
    this.limits = { maxPendingCount, maxPendingBytes, maxLedgerCount, maxOutgoingCount, maxDatabaseBytes, minFreeBytes };
    for (const [key, value] of Object.entries({ ...this.limits, retentionSeconds })) {
      if (!Number.isSafeInteger(value) || value < (key === 'minFreeBytes' ? 0 : 1)) throw new LocalError('invalid_configuration');
    }
    if (retentionSeconds < 7 * 86400) throw new LocalError('invalid_configuration');
    this.directory = resolve(directory);
    this.diskCheck = diskCheck;
    this.closed = false;
    this.storageUncertain = false;
    try {
      mkdirSync(this.directory, { recursive: true, mode: 0o700 });
      const dir = lstatSync(this.directory);
      if (!dir.isDirectory() || dir.isSymbolicLink() || realpathSync(this.directory) !== this.directory || (dir.mode & 0o077) !== 0
        || (process.getuid && dir.uid !== process.getuid())) throw new LocalError('invalid_configuration');
      for (const name of ['inbox.sqlite', 'owner.sqlite']) {
        const path = join(this.directory, name);
        try {
          const file = lstatSync(path);
          if (!file.isFile() || file.isSymbolicLink() || (file.mode & 0o077) !== 0) throw new LocalError('invalid_configuration');
        } catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
      this.checkDisk();
      this.owner = new DatabaseSync(join(this.directory, 'owner.sqlite'));
      chmodSync(join(this.directory, 'owner.sqlite'), 0o600);
      try { this.owner.exec('PRAGMA busy_timeout=0; PRAGMA journal_mode=DELETE; BEGIN EXCLUSIVE; CREATE TABLE IF NOT EXISTS owner(singleton INTEGER PRIMARY KEY CHECK(singleton=1));'); }
      catch { throw new LocalError('owner_conflict'); }
      this.db = new DatabaseSync(join(this.directory, 'inbox.sqlite'));
      chmodSync(join(this.directory, 'inbox.sqlite'), 0o600);
      if (this.db.prepare('PRAGMA user_version').get().user_version > 1) throw new LocalError('invalid_configuration');
      this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;
        PRAGMA busy_timeout=0; PRAGMA wal_autocheckpoint=100;
        CREATE TABLE IF NOT EXISTS state(key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS inbox(
          message_id TEXT PRIMARY KEY, sequence INTEGER NOT NULL UNIQUE, digest TEXT NOT NULL,
          envelope TEXT NOT NULL, bytes INTEGER NOT NULL, state TEXT NOT NULL,
          received_at INTEGER NOT NULL, retain_until INTEGER NOT NULL,
          injection_id TEXT, native_receipt TEXT, consumed_at INTEGER);
        CREATE TABLE IF NOT EXISTS outgoing(
          key TEXT PRIMARY KEY, digest TEXT NOT NULL, request TEXT NOT NULL,
          created_at INTEGER NOT NULL, retry_until INTEGER NOT NULL, result TEXT);
        PRAGMA user_version=1;`);
      if(!this.db.prepare('PRAGMA table_info(outgoing)').all().some(c=>c.name==='kind'))this.db.exec("ALTER TABLE outgoing ADD COLUMN kind TEXT NOT NULL DEFAULT 'send'");
      for(const [name,type] of [['failure','TEXT'],['uncertain','INTEGER NOT NULL DEFAULT 0'],['operation_id','TEXT']]){
        if(!this.db.prepare('PRAGMA table_info(outgoing)').all().some(c=>c.name===name))this.db.exec(`ALTER TABLE outgoing ADD COLUMN ${name} ${type}`);
      }
      this.db.exec('CREATE UNIQUE INDEX IF NOT EXISTS outgoing_operation ON outgoing(operation_id) WHERE operation_id IS NOT NULL');
      this.db.exec('CREATE INDEX IF NOT EXISTS outgoing_recovery ON outgoing(retry_until,created_at,key) WHERE result IS NULL AND failure IS NULL');
      const stored = this.getState('identity');
      if (stored && canonical(stored) !== canonical(this.identity)) throw new LocalError('session_mismatch');
      if (!stored) this.setState('identity', this.identity);
      this.db.prepare("UPDATE inbox SET state='uncertain' WHERE state='injecting'").run();
    } catch (error) {
      this.db?.close();
      this.owner?.close();
      if (error instanceof LocalError) throw error;
      throw new LocalError('storage_unavailable');
    }
  }

  checkDisk(extra = 0) {
    this.assertUsable();
    if (this.closed) throw new LocalError('storage_unavailable');
    try {
      if (this.diskCheck && !this.diskCheck(extra)) throw new Error('disk');
      const disk = statfsSync(this.directory);
      if ([0x6969, 0x517b, 0xff534d42].includes(Number(disk.type))) throw new Error('unsupported filesystem');
      const bytes = readdirSync(this.directory).reduce((total, name) => {
        const stat = lstatSync(join(this.directory, name));
        return total + (stat.isFile() ? stat.size : 0);
      }, 0);
      if (Number(disk.bavail) * Number(disk.bsize) < this.limits.minFreeBytes + extra
        || bytes + extra > this.limits.maxDatabaseBytes) throw new Error('disk');
    } catch { throw new LocalError('storage_unavailable', { retryable: true }); }
  }

  transaction(callback, { growth = 0 } = {}) {
    this.checkDisk(growth);
    let commitAttempted = false;
    let committed = false;
    try {
      this.db.exec('BEGIN IMMEDIATE');
      const result = callback();
      this.failurePoint('before_commit');
      commitAttempted = true;
      this.db.exec('COMMIT');
      committed = true;
      this.failurePoint('after_commit');
      return result;
    } catch (error) {
      let rollbackConfirmed = false;
      try { this.failurePoint('before_rollback'); this.db.exec('ROLLBACK'); rollbackConfirmed = true; } catch { /* The effect may be unknown. */ }
      const effect = committed || (commitAttempted && !rollbackConfirmed) || !rollbackConfirmed ? 'unknown' : 'not_applied';
      // A failed rollback can leave uncommitted rows visible on this connection.
      // Do not allow a later duplicate lookup to ACK those rows. Reopen first.
      if (!committed && !rollbackConfirmed) this.storageUncertain = true;
      if (error instanceof LocalError && effect === 'not_applied') throw error;
      throw new LocalError('storage_unavailable', { retryable: true, effect });
    }
  }

  assertUsable() {
    if (this.closed || this.storageUncertain) throw new LocalError('storage_unavailable', { effect: this.storageUncertain ? 'unknown' : 'not_applied', retryable: true });
  }

  getState(key) {
    this.assertUsable();
    const row = this.db.prepare('SELECT value FROM state WHERE key=?').get(key);
    return row ? JSON.parse(row.value) : null;
  }

  setState(key, value) {
    if (!['identity', 'attachment', 'registration_pending', 'claim_pending', 'metadata'].includes(key)) throw new LocalError('invalid_configuration');
    const encoded = canonical(value);
    if (Buffer.byteLength(encoded) > 256 * 1024) throw new LocalError('invalid_configuration');
    return this.transaction(() => this.db.prepare('INSERT INTO state(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, encoded), { growth: Buffer.byteLength(encoded) + 4096 });
  }

  accept(rawEnvelope, { serverNow = this.now(), retentionSeconds = this.retentionSeconds, retryWindowSeconds = 86400 } = {}) {
    this.assertUsable();
    let envelope;
    try { envelope = validateEnvelope(rawEnvelope); }
    catch { throw new LocalError('invalid_envelope'); }
    if (envelope.recipient_id !== this.identity.client_id) throw new LocalError('session_mismatch');
    const encoded = canonical(envelope);
    const hash = digest(envelope);
    const bytes = Buffer.byteLength(encoded);
    if (!Number.isSafeInteger(retentionSeconds) || retentionSeconds < 7 * 86400
      || !Number.isSafeInteger(retryWindowSeconds) || retryWindowSeconds < 1) throw new LocalError('invalid_configuration');
    const existing = this.db.prepare('SELECT digest FROM inbox WHERE message_id=?').get(envelope.message_id);
    if (existing) {
      if (existing.digest !== hash) throw new LocalError('envelope_mismatch');
      // A late redelivery restarts the local retention guarantee. If extending it
      // fails, withhold ACK: saying not_stored would contradict this known row.
      try {
        this.transaction(() => this.db.prepare('UPDATE inbox SET retain_until=MAX(retain_until,?) WHERE message_id=?')
          .run(this.now() + Math.max(retentionSeconds, this.retentionSeconds) * 1000, envelope.message_id));
      } catch { throw new LocalError('storage_unavailable', { effect: 'unknown', retryable: true }); }
      return { stored: true, duplicate: true, message_id: envelope.message_id };
    }
    if (Date.parse(envelope.expires_at) <= serverNow) throw new LocalError('envelope_expired');
    return this.transaction(() => {
      const usage = this.stats();
      if (usage.pending_count >= this.limits.maxPendingCount || usage.pending_bytes + bytes > this.limits.maxPendingBytes
        || usage.ledger_count >= this.limits.maxLedgerCount) throw new LocalError('inbox_full', { retryable: true });
      const highest = this.db.prepare('SELECT MAX(sequence) AS sequence FROM inbox').get().sequence ?? 0;
      const lastSequence = this.getState('attachment')?.highest_received_sequence ?? 0;
      if (envelope.recipient_sequence <= Math.max(highest, lastSequence)) throw new LocalError('envelope_mismatch');
      const retainUntil = Math.max(this.now() + Math.max(retentionSeconds, this.retentionSeconds) * 1000,
        this.now() + Math.max(0, Date.parse(envelope.expires_at) - serverNow) + retryWindowSeconds * 1000);
      this.db.prepare(`INSERT INTO inbox(message_id,sequence,digest,envelope,bytes,state,received_at,retain_until)
        VALUES(?,?,?,?,?,'pending',?,?)`).run(envelope.message_id, envelope.recipient_sequence, hash, encoded, bytes, this.now(), retainUntil);
      const attachment = { ...(this.getState('attachment') ?? {}), highest_received_sequence: envelope.recipient_sequence };
      this.db.prepare('INSERT INTO state(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run('attachment', canonical(attachment));
      this.failurePoint('after_inbox_insert');
      return { stored: true, duplicate: false, message_id: envelope.message_id };
    }, { growth: bytes * 3 + 16384 });
  }

  stats() {
    this.assertUsable();
    const row = this.db.prepare("SELECT COUNT(*) AS ledger_count, COALESCE(SUM(CASE WHEN state!='consumed' THEN 1 ELSE 0 END),0) AS pending_count, COALESCE(SUM(CASE WHEN state!='consumed' THEN bytes ELSE 0 END),0) AS pending_bytes FROM inbox").get();
    return { ...row };
  }

  head() {
    this.assertUsable();
    const row = this.db.prepare("SELECT * FROM inbox WHERE state!='consumed' ORDER BY sequence LIMIT 1").get();
    return row ? { message_id: row.message_id, sequence: row.sequence, state: row.state,
      envelope: JSON.parse(row.envelope), injection_id: row.injection_id } : null;
  }

  beginInjection(messageId) {
    return this.transaction(() => {
      const head = this.head();
      if (!head || head.message_id !== messageId) throw new LocalError('unsafe_boundary');
      if (head.state !== 'pending') throw new LocalError('injection_uncertain');
      const injectionId = randomUUID();
      this.db.prepare("UPDATE inbox SET state='injecting', injection_id=? WHERE message_id=?").run(injectionId, messageId);
      return injectionId;
    });
  }

  recordNativeAcceptance(messageId, injectionId, receipt) {
    if (!receipt || receipt.accepted !== true || typeof receipt.receipt_id !== 'string'
      || receipt.receipt_id.length < 1 || receipt.receipt_id.length > 256
      || /[\x00-\x1f\x7f]/.test(receipt.receipt_id)) throw new LocalError('receipt_required', { effect: 'unknown' });
    return this.transaction(() => {
      const row = this.db.prepare('SELECT state,injection_id FROM inbox WHERE message_id=?').get(messageId);
      if (!row || !['injecting', 'uncertain'].includes(row.state) || row.injection_id !== injectionId) throw new LocalError('injection_uncertain');
      this.db.prepare("UPDATE inbox SET state='consumed', native_receipt=?, consumed_at=? WHERE message_id=?").run(receipt.receipt_id, this.now(), messageId);
    });
  }

  recordNativeRejection(messageId, injectionId, { definitelyNotAccepted } = {}) {
    if (definitelyNotAccepted !== true) throw new LocalError('injection_uncertain', { effect: 'unknown' });
    return this.transaction(() => {
      const row = this.db.prepare('SELECT state,injection_id FROM inbox WHERE message_id=?').get(messageId);
      if (!row || row.state !== 'injecting' || row.injection_id !== injectionId) throw new LocalError('injection_uncertain');
      this.db.prepare("UPDATE inbox SET state='pending', injection_id=NULL WHERE message_id=?").run(messageId);
    });
  }

  /** Operator-only local API. Never expose this through an agent tool. */
  resolveUncertain(messageId, { resolution, duplicateRiskAcknowledged = false } = {}) {
    if (!['accepted', 'retry'].includes(resolution) || (resolution === 'retry' && duplicateRiskAcknowledged !== true)) throw new LocalError('injection_uncertain');
    return this.transaction(() => {
      const row = this.db.prepare('SELECT state FROM inbox WHERE message_id=?').get(messageId);
      if (!row || !['injecting', 'uncertain'].includes(row.state)) throw new LocalError('injection_uncertain');
      if (resolution === 'accepted') this.db.prepare("UPDATE inbox SET state='consumed',native_receipt='operator-confirmed',consumed_at=? WHERE message_id=?").run(this.now(), messageId);
      else this.db.prepare("UPDATE inbox SET state='pending',injection_id=NULL WHERE message_id=?").run(messageId);
    });
  }

  prepareSend(rawRequest, options = {}) {
    return this.prepareOperation('send',validateSend(rawRequest),options);
  }

  prepareResend(messageId, input = {}, options = {}) {
    const validated=validateResend(input);
    return this.prepareOperation('resend',{message_id:validateUuid(messageId),...(input.ttl_seconds===undefined?{}:validated)},options);
  }

  prepareOperation(kind, request, { key, operationId, issuedAt=this.now(), retryUntil, retryWindowSeconds = 86400 } = {}) {
    if(operationId!==undefined&&(typeof operationId!=='string'||!/^[a-f0-9]{64}$/.test(operationId)))throw new LocalError('invalid_configuration');
    const mapped=operationId?this.outgoingForOperation(operationId):null;
    key = validateIdempotencyKey(key??mapped?.key??`op_${issuedAt}_${randomUUID().replaceAll('-','')}`);
    const encoded = canonical(request);
    const hash = digest(request);
    const existing = this.outgoing(key);
    if (existing) {
      if (existing.digest !== hash || existing.kind !== kind) throw new LocalError('send_conflict');
      return key;
    }
    const started=/^op_([0-9]{13})_/.exec(key);
    if(started&&issuedAt-Number(started[1])>=retryWindowSeconds*1000)throw new LocalError('retry_window_elapsed',{effect:'unknown'});
    if(retryUntil!==undefined&&(!Number.isSafeInteger(retryUntil)||retryUntil<=this.now()))throw new LocalError('retry_window_elapsed',{effect:'unknown'});
    if (!Number.isSafeInteger(retryWindowSeconds) || retryWindowSeconds < 1) throw new LocalError('invalid_configuration');
    this.transaction(() => {
      this.db.prepare('DELETE FROM outgoing WHERE key IN (SELECT key FROM outgoing WHERE (result IS NOT NULL OR failure IS NOT NULL) AND retry_until<? LIMIT 100)').run(this.now());
      if (this.db.prepare('SELECT COUNT(*) AS n FROM outgoing').get().n >= this.limits.maxOutgoingCount) throw new LocalError('inbox_full');
      this.db.prepare('INSERT INTO outgoing(key,digest,request,created_at,retry_until,kind,operation_id) VALUES(?,?,?,?,?,?,?)').run(key, hash, encoded, this.now(), Math.min(retryUntil??Infinity,this.now()+retryWindowSeconds*1000),kind,operationId??null);
    }, { growth: Buffer.byteLength(encoded) * 3 + 8192 });
    return key;
  }

  outgoingForOperation(operationId) {
    const row=this.db.prepare('SELECT key FROM outgoing WHERE operation_id=?').get(operationId);
    return row?this.outgoing(row.key):null;
  }

  outgoing(key) {
    this.assertUsable();
    const row = this.db.prepare('SELECT * FROM outgoing WHERE key=?').get(key);
    return row ? { ...row, request: JSON.parse(row.request), result: row.result ? JSON.parse(row.result) : null, failure: row.failure ? JSON.parse(row.failure) : null } : null;
  }

  unresolvedSends() {
    this.assertUsable();
    return this.db.prepare('SELECT key,created_at,retry_until FROM outgoing WHERE result IS NULL AND failure IS NULL ORDER BY created_at LIMIT 100').all().map(row => ({ ...row }));
  }

  outgoingRecovery(limit = 10, now = this.now()) {
    this.assertUsable();
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || !Number.isSafeInteger(now)) throw new LocalError('invalid_configuration');
    // Filter before LIMIT: retained, expired unknowns must never starve live retries.
    // Earliest deadline first uses the partial index without sorting/scanning old rows.
    const operations = this.db.prepare('SELECT key,created_at,retry_until FROM outgoing WHERE result IS NULL AND failure IS NULL AND retry_until>? ORDER BY retry_until,created_at,key LIMIT ?').all(now, limit).map(row => ({ ...row }));
    const expiredCount = this.db.prepare('SELECT count(*) AS n FROM outgoing WHERE result IS NULL AND failure IS NULL AND retry_until<=?').get(now).n;
    return { operations, expiredCount };
  }

  recordSendResult(key, result) {
    const encoded = canonical(result);
    if (Buffer.byteLength(encoded) > 16384) throw new LocalError('invalid_response', { effect: 'unknown' });
    this.transaction(() => {
      if (!this.outgoing(key)) throw new LocalError('invalid_configuration');
      this.db.prepare('UPDATE outgoing SET result=?,failure=NULL,uncertain=0 WHERE key=?').run(encoded, key);
    }, { growth: Buffer.byteLength(encoded) * 2 + 8192 });
  }

  markOutgoingAttempt(key) {
    this.transaction(()=>this.db.prepare('UPDATE outgoing SET uncertain=1 WHERE key=?').run(key));
  }

  recordSendFailure(key, failure) {
    const encoded=canonical(failure);
    if(Buffer.byteLength(encoded)>16384)throw new LocalError('invalid_response',{effect:'unknown'});
    this.transaction(()=>this.db.prepare('UPDATE outgoing SET failure=?,uncertain=0 WHERE key=? AND result IS NULL').run(encoded,key),{growth:Buffer.byteLength(encoded)*2+8192});
  }

  collect(limit = 100) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new LocalError('invalid_configuration');
    return this.transaction(() => {
      const removedInbox = this.db.prepare("DELETE FROM inbox WHERE message_id IN (SELECT message_id FROM inbox WHERE state='consumed' AND retain_until<? ORDER BY retain_until LIMIT ?)").run(this.now(), limit).changes;
      const removedSends = this.db.prepare('DELETE FROM outgoing WHERE key IN (SELECT key FROM outgoing WHERE (result IS NOT NULL OR failure IS NOT NULL) AND retry_until<? ORDER BY retry_until LIMIT ?)').run(this.now(), limit).changes;
      return { removed_inbox: removedInbox, removed_sends: removedSends };
    });
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    try { this.db.close(); } finally { this.owner.close(); }
  }
}
