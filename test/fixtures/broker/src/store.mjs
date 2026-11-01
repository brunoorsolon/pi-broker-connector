import { DatabaseSync, backup } from 'node:sqlite';
import { PresenceService, presenceSnapshot } from './presence.mjs';
import { randomUUID } from 'node:crypto';
import { mkdirSync, chmodSync, statfsSync, statSync, realpathSync, lstatSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { ApiError, DEFAULTS, canonical, digest, validateRegistration, validateMetadataPatch, validateSend, validateClaim, validateCompletion, validateRenew, validateIdempotencyKey, validateUuid, validateResend, validateOperationTime } from './protocol.mjs';

const iso = n => new Date(n).toISOString();
const parse = JSON.parse;
const terminal = s => ['delivered', 'expired', 'failed', 'cancelled'].includes(s);
const fail = (status, code, field, options) => { throw new ApiError(status, code, field, options); };
const HISTORY_BYTES = 32768, HISTORY_SCAN = 1000;
const intersects = (a, b) => a.some(x => b.includes(x));

/** One synchronous writer. All state transitions run in BEGIN IMMEDIATE transactions. */
export class BrokerStore {
  constructor({ path, clock = Date.now, limits = {}, diskCheck, fault = () => {} }) {
    this.clock = clock;
    this.fault = fault;
    this.limits = { ...DEFAULTS, min_free_bytes: 64 * 1024 * 1024, max_disk_bytes: 1024 * 1024 * 1024,
      principal_send_per_minute: 600, principal_send_burst: 100, global_send_per_minute: 6000, global_send_burst: 1000, max_polls: 1000, request_per_minute: 1200, ...limits };
    const allowedLimits=new Set([...Object.keys(DEFAULTS),'min_free_bytes','max_disk_bytes','principal_send_per_minute','principal_send_burst','global_send_per_minute','global_send_burst','max_polls','request_per_minute']);
    if(Object.keys(limits).some(k=>!allowedLimits.has(k)))throw new Error('Unknown configured limit.');
    for (const [key, value] of Object.entries(this.limits)) {
      if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`Invalid finite limit: ${key}`);
    }
    if (this.limits.lease_seconds < 3 * this.limits.heartbeat_seconds) throw new Error('Lease must cover three heartbeat intervals.');
    const l=this.limits;
    if(l.offline_notice_seconds>604800)throw new Error('Offline notice grace exceeds seven days.');
    if(l.retention_seconds<DEFAULTS.retention_seconds||l.registration_retention_seconds<DEFAULTS.registration_retention_seconds)throw new Error('Retention cannot be shorter than the v1 minimum.');
    if(l.min_ttl_seconds<60||l.max_ttl_seconds>604800||l.default_ttl_seconds<l.min_ttl_seconds||l.default_ttl_seconds>l.max_ttl_seconds||l.max_wait_seconds>30||l.max_message_bytes>65536||l.max_request_bytes>98304)throw new Error('Configured limits exceed the v1 wire bounds.');

    this.path = resolve(path);
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    if (realpathSync(dirname(this.path)) !== dirname(this.path)) throw new Error('Database directory must not use symlinks.');
    const directory=statSync(dirname(this.path));
    if((directory.mode&0o077)!==0||(process.getuid&&![process.getuid(),0].includes(directory.uid)))throw new Error('Database directory must be private and operator-owned.');

    for (const file of [this.path, `${this.path}.owner`]) {
      try { if (lstatSync(file).isSymbolicLink()) throw new Error('Database must not be a symlink.'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    }
    this.diskCheck = diskCheck ?? (() => {
      const fs = statfsSync(dirname(this.path));
      const unsupported = new Set([0x6969, 0x517b, 0xff534d42]); // NFS, SMB, CIFS
      if (unsupported.has(fs.type)) return false;
      let bytes = 0;
      for (const suffix of ['', '-wal', '-shm', '.owner']) { try { bytes += statSync(this.path + suffix).size; } catch (e) { if (e.code !== 'ENOENT') throw e; } }
      return fs.bavail * fs.bsize >= this.limits.min_free_bytes && bytes < this.limits.max_disk_bytes;
    });
    try {
      // Separate SQLite advisory owner DB gives a kernel lock released even after SIGKILL.
      this.owner = new DatabaseSync(`${this.path}.owner`);
      chmodSync(`${this.path}.owner`, 0o600);
      this.owner.exec('PRAGMA journal_mode=DELETE; PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE; CREATE TABLE IF NOT EXISTS owner (id INTEGER);');
      this.db = new DatabaseSync(this.path);
      chmodSync(this.path, 0o600);
      this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=1000; PRAGMA trusted_schema=OFF;');
      this.migrate();
      this.presence = new PresenceService(this);
      this.tx(() => {
        this.db.exec('UPDATE sessions SET lease_until=0;');
        this.db.exec("UPDATE messages SET state='queued', claim_id=NULL, claim_epoch=NULL, claim_until=NULL WHERE state='claimed';");
      });
      this.closed = false;
    } catch (e) {
      try { this.db?.close(); } catch {}
      try { this.owner?.close(); } catch {}
      throw e;
    }
  }
  migrate() {
    const version = this.db.prepare('PRAGMA user_version').get().user_version;
    if (version > 4) throw new Error('Unsupported database schema version.');
    this.db.exec(`BEGIN IMMEDIATE;
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY, principal TEXT NOT NULL, adapter TEXT NOT NULL, instance TEXT NOT NULL,
        type TEXT NOT NULL, connection TEXT NOT NULL, epoch INTEGER NOT NULL, lease_until INTEGER NOT NULL,
        heartbeat_at INTEGER NOT NULL, closed INTEGER NOT NULL DEFAULT 0, metadata TEXT NOT NULL,
        revision INTEGER NOT NULL, capabilities TEXT NOT NULL, scopes TEXT NOT NULL, credential TEXT NOT NULL,
        next_sequence INTEGER NOT NULL DEFAULT 0, UNIQUE(principal,adapter,instance));
      CREATE TABLE IF NOT EXISTS registrations (
        client TEXT NOT NULL, connection TEXT NOT NULL, request TEXT NOT NULL, result TEXT NOT NULL,
        created INTEGER NOT NULL, PRIMARY KEY(client,connection));
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY, sender TEXT NOT NULL, recipient TEXT NOT NULL, scope TEXT NOT NULL,
        sequence INTEGER NOT NULL, envelope TEXT, bytes INTEGER NOT NULL, state TEXT NOT NULL,
        accepted INTEGER NOT NULL, expires INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
        reason TEXT, uncertain INTEGER NOT NULL DEFAULT 0, claim_prior_uncertain INTEGER NOT NULL DEFAULT 0, claim_id TEXT, claim_epoch INTEGER, claim_until INTEGER,
        claimed_at INTEGER, delivered_at INTEGER, terminal_at INTEGER, UNIQUE(recipient,sequence));
      CREATE INDEX IF NOT EXISTS mailbox ON messages(recipient,state,sequence);
      CREATE INDEX IF NOT EXISTS retention ON messages(terminal_at);
      CREATE INDEX IF NOT EXISTS outgoing_history ON messages(sender,accepted DESC,id DESC);
      CREATE INDEX IF NOT EXISTS outgoing_expiry ON messages(sender,state,expires);
      CREATE TABLE IF NOT EXISTS history_revisions (sender TEXT PRIMARY KEY, revision INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS history_state_revisions (sender TEXT NOT NULL,state TEXT NOT NULL,revision INTEGER NOT NULL,PRIMARY KEY(sender,state));
      DROP TRIGGER IF EXISTS history_updated;
      CREATE TRIGGER history_updated AFTER UPDATE OF state ON messages WHEN OLD.state<>NEW.state AND NEW.state<>'expired' BEGIN
        INSERT INTO history_state_revisions VALUES(NEW.sender,OLD.state,1) ON CONFLICT(sender,state) DO UPDATE SET revision=revision+1;
        INSERT INTO history_state_revisions VALUES(NEW.sender,NEW.state,1) ON CONFLICT(sender,state) DO UPDATE SET revision=revision+1;
      END;
      CREATE TRIGGER IF NOT EXISTS history_deleted AFTER DELETE ON messages BEGIN
        INSERT INTO history_revisions VALUES(OLD.sender,1) ON CONFLICT(sender) DO UPDATE SET revision=revision+1;
      END;
      CREATE TABLE IF NOT EXISTS sends (
        principal TEXT NOT NULL, sender TEXT NOT NULL, key TEXT NOT NULL, request TEXT NOT NULL,
        message TEXT NOT NULL REFERENCES messages(id), scope TEXT NOT NULL, result TEXT NOT NULL,
        PRIMARY KEY(principal,sender,key));
      CREATE TABLE IF NOT EXISTS claims (
        client TEXT NOT NULL, epoch INTEGER NOT NULL, key TEXT NOT NULL, request TEXT NOT NULL,
        result TEXT, created INTEGER NOT NULL, PRIMARY KEY(client,epoch,key));
      CREATE TABLE IF NOT EXISTS completions (
        claim TEXT PRIMARY KEY, client TEXT NOT NULL, epoch INTEGER NOT NULL, message TEXT NOT NULL,
        request TEXT NOT NULL, result TEXT NOT NULL, created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS rates (id TEXT PRIMARY KEY, tokens REAL NOT NULL, updated INTEGER NOT NULL);
      COMMIT;`);
    this.db.exec('BEGIN IMMEDIATE');
    try{
      if(!this.db.prepare('PRAGMA table_info(messages)').all().some(c=>c.name==='claim_prior_uncertain'))this.db.exec('ALTER TABLE messages ADD COLUMN claim_prior_uncertain INTEGER NOT NULL DEFAULT 0');
      for(const [name,type] of [['resent_from','TEXT'],['cancelled_at','INTEGER']]){
        if(!this.db.prepare('PRAGMA table_info(messages)').all().some(c=>c.name===name))this.db.exec(`ALTER TABLE messages ADD COLUMN ${name} ${type}`);
      }
      if(!this.db.prepare('PRAGMA table_info(messages)').all().some(c=>c.name==='history_order')){
        this.db.exec('ALTER TABLE messages ADD COLUMN history_order INTEGER; UPDATE messages SET history_order=rowid;');
      }
      this.db.exec(`CREATE TABLE IF NOT EXISTS history_clock(id INTEGER PRIMARY KEY CHECK(id=1),n INTEGER NOT NULL);
        INSERT OR IGNORE INTO history_clock SELECT 1,coalesce(max(history_order),0) FROM messages;
        CREATE TRIGGER IF NOT EXISTS history_inserted AFTER INSERT ON messages BEGIN
          UPDATE history_clock SET n=n+1 WHERE id=1;
          UPDATE messages SET history_order=(SELECT n FROM history_clock WHERE id=1) WHERE id=NEW.id;
        END;`);
      this.db.exec(`PRAGMA user_version=${Math.max(version, 2)}; COMMIT`);
    }catch(e){this.db.exec('ROLLBACK');throw e;}
  }
  tx(fn) {
    if (!this.safe()) fail(503, 'storage_unavailable', null, { retryable: true });
    this.db.exec('BEGIN IMMEDIATE');
    let committed = false, commitAttempted = false, rollbackConfirmed = false;
    try {
      const result = fn();
      this.fault('before_commit');
      commitAttempted = true;
      this.fault('commit_attempt');
      this.db.exec('COMMIT');
      committed = true;
      this.fault('after_commit');
      return result;
    } catch (error) {
      if (!committed) { try { this.fault('before_rollback'); this.db.exec('ROLLBACK'); rollbackConfirmed = true; } catch { this.poisoned = true; } }
      if (error instanceof ApiError) throw error;
      throw new ApiError(503, 'storage_unavailable', null, { retryable: true, effect: committed || !rollbackConfirmed ? 'unknown' : 'not_applied' });
    }
  }
  safe() { try { return !this.closed && !this.poisoned && this.diskCheck(); } catch { return false; } }
  close() { if (this.closed) return; this.closed = true; this.db.close(); this.owner.close(); }
  async backup(destination) { await backup(this.db, destination); chmodSync(destination, 0o600); }
  policy() { const l = this.limits; return { heartbeat_interval_seconds: l.heartbeat_seconds, lease_seconds: l.lease_seconds, claim_seconds: l.claim_seconds, retention_seconds: l.retention_seconds, registration_retry_seconds: l.registration_retention_seconds, send_retry_seconds: l.retry_window_seconds, offline_notice_seconds:l.offline_notice_seconds, resumable_disconnect:true, presence_events:true }; }
  own(auth, id) {
    const s = this.db.prepare('SELECT * FROM sessions WHERE id=?').get(id);
    if (!s || s.principal !== auth.principal_id || s.adapter !== auth.adapter_id || !auth.client_types.includes(s.type)) fail(404, 'recipient_not_found', 'headers.X-Client-ID');
    return s;
  }
  live(auth, id, epoch) {
    const s = this.own(auth, id);
    if (!intersects(parse(s.scopes), auth.scopes)) fail(403, 'forbidden');
    if (s.closed) fail(410, 'session_closed');
    if (!Number.isSafeInteger(epoch) || s.epoch !== epoch || s.lease_until <= this.clock()) fail(409, 'stale_lease_epoch', 'headers.X-Lease-Epoch');
    return s;
  }
  registrationResult(s, now=this.clock()) { return { client_id: s.id, lease_epoch: s.epoch, metadata_revision: s.revision, lease_expires_at: iso(s.lease_until), server_time: iso(now), policy: this.policy() }; }
  register(auth, input) {
    const b = validateRegistration(input), request = canonical(b), now = this.clock();
    if (!auth.client_types.includes(b.client_type)) fail(403, 'forbidden', 'client_type');
    return this.tx(() => {
      const old = this.db.prepare('SELECT * FROM sessions WHERE id=?').get(b.client_id);
      if (old && (old.principal !== auth.principal_id || old.adapter !== auth.adapter_id || old.instance !== b.session_instance_id || old.type !== b.client_type)) fail(409, 'identity_conflict');
      const prior = this.db.prepare('SELECT * FROM registrations WHERE client=? AND connection=?').get(b.client_id,b.connection_id);
      if (prior) {
        if (prior.request !== request) fail(409, 'idempotency_conflict');
        if (!old || !intersects(parse(old.scopes), auth.scopes)) fail(403, 'forbidden');
        return parse(prior.result); // never renews lease or changes epoch
      }
      if (old?.closed) fail(410, 'session_closed');
      if ((old?.epoch ?? 0) !== b.previous_epoch) fail(409, 'stale_lease_epoch', 'previous_epoch');
      const collision = this.db.prepare('SELECT id FROM sessions WHERE principal=? AND adapter=? AND instance=?').get(auth.principal_id, auth.adapter_id, b.session_instance_id);
      if (collision && collision.id !== b.client_id) fail(409, 'identity_conflict');
      const epoch = b.previous_epoch + 1, revision = (old?.revision ?? 0) + 1;
      const values = [b.client_id, auth.principal_id, auth.adapter_id, b.session_instance_id, b.client_type, b.connection_id, epoch, now + this.limits.lease_seconds * 1000, now, canonical(b.metadata), revision, canonical(b.capabilities), canonical(auth.scopes), auth.credential_id];
      this.db.prepare(`INSERT INTO sessions(id,principal,adapter,instance,type,connection,epoch,lease_until,heartbeat_at,metadata,revision,capabilities,scopes,credential)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET connection=excluded.connection,epoch=excluded.epoch,lease_until=excluded.lease_until,heartbeat_at=excluded.heartbeat_at,metadata=excluded.metadata,revision=excluded.revision,capabilities=excluded.capabilities,scopes=excluded.scopes,credential=excluded.credential`).run(...values);
      this.db.prepare('DELETE FROM session_disconnects WHERE session=?').run(b.client_id);
      this.db.prepare("UPDATE messages SET state='queued',claim_id=NULL,claim_epoch=NULL,claim_until=NULL WHERE recipient=? AND state='claimed'").run(b.client_id);
      const result = this.registrationResult(this.own(auth,b.client_id));
      this.db.prepare('INSERT INTO registrations VALUES(?,?,?,?,?)').run(b.client_id,b.connection_id,request,canonical(result),now);
      return result;
    });
  }
  session(auth, id) {
    const s = this.own(auth,id), now=this.clock();
    return { ...this.registrationResult(s,now), client_type:s.type,session_instance_id:s.instance,connection_id:s.connection,metadata:parse(s.metadata),capabilities:parse(s.capabilities),closed:!!s.closed,...presenceSnapshot(s,now) };
  }
  heartbeat(auth, id, epoch) { return this.tx(() => {
    this.live(auth,id,epoch);
    const now = this.clock(), until = now + this.limits.lease_seconds*1000;
    this.db.prepare('UPDATE sessions SET lease_until=?,heartbeat_at=?,credential=? WHERE id=?').run(until,now,auth.credential_id,id);
    return {client_id:id,lease_epoch:epoch,lease_expires_at:iso(until),server_time:iso(now)};
  }); }
  disconnect(auth, id, epoch) { return this.tx(() => {
    const s = this.own(auth, id);
    if (!intersects(parse(s.scopes), auth.scopes)) fail(403, 'forbidden');
    if (s.closed) fail(410, 'session_closed');
    if (!Number.isSafeInteger(epoch) || s.epoch !== epoch) fail(409, 'stale_lease_epoch', 'headers.X-Lease-Epoch');
    // Idempotent for this attachment, but an old process cannot disconnect a
    // replacement epoch. Identity, mailbox and reconnect capability survive.
    const now = this.clock();
    this.db.prepare('UPDATE sessions SET lease_until=min(lease_until,?) WHERE id=?').run(now, id);
    // Only ending a live lease mints later terminal-close authority. Retrying an
    // already marked epoch preserves it; an ordinary expired lease gains none.
    if(s.lease_until>now)this.db.prepare('INSERT INTO session_disconnects(session,epoch) VALUES(?,?) ON CONFLICT(session) DO UPDATE SET epoch=excluded.epoch').run(id,epoch);
    this.sweepInternal();
    return {client_id:id,lease_epoch:epoch,...presenceSnapshot(this.own(auth,id),now),server_time:iso(now)};
  }); }
  patch(s, b) {
    if (s.revision !== b.expected_metadata_revision) fail(409,'metadata_conflict','expected_metadata_revision',{details:{current_revision:s.revision}});
    const metadata = { ...parse(s.metadata), ...b.metadata_patch };
    this.db.prepare('UPDATE sessions SET metadata=?,revision=revision+1 WHERE id=?').run(canonical(metadata),s.id);
    return {...s,metadata:canonical(metadata),revision:s.revision+1};
  }
  metadata(auth,id,epoch,input) { const b=validateMetadataPatch(input); return this.tx(()=>{
    const s=this.patch(this.live(auth,id,epoch),b);
    return {client_id:id,metadata:parse(s.metadata),metadata_revision:s.revision,server_time:iso(this.clock())};
  }); }
  closeSession(auth,id,epoch) { return this.tx(()=>{
    const s=this.own(auth,id);
    if (!s.closed) {
      const disconnected=this.db.prepare('SELECT epoch FROM session_disconnects WHERE session=?').get(id);
      if(disconnected?.epoch===epoch && s.epoch===epoch) {
        // An explicit resumable disconnect keeps the authority to later close
        // that exact attachment. Expired leases without this marker stay fenced.
        if(!intersects(parse(s.scopes),auth.scopes)) fail(403,'forbidden');
      } else this.live(auth,id,epoch);
      this.db.prepare('DELETE FROM session_disconnects WHERE session=?').run(id);
      this.db.prepare('UPDATE sessions SET closed=1,lease_until=0 WHERE id=?').run(id);
      this.db.prepare("UPDATE messages SET state='failed',reason='recipient_closed',terminal_at=? WHERE recipient=? AND state IN ('queued','claimed')").run(this.clock(),id);
    } else if (s.epoch!==epoch) fail(409,'stale_lease_epoch');
    return {client_id:id,closed:true,server_time:iso(this.clock())};
  }); }
  revoke(credentials) {
    if (!credentials.length) return;
    this.tx(()=>{for(const id of credentials) this.db.prepare('UPDATE sessions SET lease_until=0 WHERE credential=?').run(id);});
  }
  applyAuthorizationPolicies(entries) {
    this.tx(()=>{
      for(const s of this.db.prepare('SELECT id,principal,adapter,type,scopes FROM sessions').all()){
        const active=entries.filter(c=>c.principal_id===s.principal&&c.adapter_id===s.adapter&&c.client_types.includes(s.type));
        // Policy reload may remove access, but never silently grants a session new scopes.
        const scopes=parse(s.scopes).filter(scope=>active.some(c=>c.scopes.includes(scope)));
        if(canonical(scopes)!==s.scopes)this.db.prepare('UPDATE sessions SET scopes=?,lease_until=0 WHERE id=?').run(canonical(scopes),s.id);
      }
    });
  }
  list(auth, query={}) {
    const allowed=['connected','client_type','name','project','cursor','limit'];
    if(Object.keys(query).some(k=>!allowed.includes(k))) fail(400,'invalid_request','query');
    if(query.connected!==undefined&&!['true','false'].includes(query.connected)) fail(400,'invalid_request','query.connected');
    const limit=query.limit===undefined?50:Number(query.limit);
    if(!Number.isInteger(limit)||limit<1||limit>100) fail(400,'invalid_request','query.limit');
    const rows=this.db.prepare('SELECT * FROM sessions WHERE id>? ORDER BY id').iterate(query.cursor??'');
    const clients=[], observedAt=this.clock(); let more=false;
    for(const s of rows){
      const m=parse(s.metadata), connected=!s.closed&&s.lease_until>observedAt;
      if(!intersects(auth.scopes,parse(s.scopes)) || ((query.connected??'true')==='true'&&!connected)|| (query.client_type&&s.type!==query.client_type)||(query.name&&m.name!==query.name)||(query.project&&m.project!==query.project)) continue;
      if(clients.length===limit){more=true;break;}
      clients.push({client_id:s.id,client_type:s.type,...m,metadata_revision:s.revision,capabilities:parse(s.capabilities),...presenceSnapshot(s,observedAt)});
    }
    return {clients,next_cursor:more?clients.at(-1).client_id:null,server_time:iso(observedAt)};
  }
  rate(id, perMinute, burst) {
    const now=this.clock(), old=this.db.prepare('SELECT * FROM rates WHERE id=?').get(id);
    const tokens=Math.min(burst,old?old.tokens+Math.max(0,now-old.updated)*perMinute/60000:burst);
    if(tokens<1) fail(429,'rate_limited',null,{retryable:true,retry_after:Math.ceil((1-tokens)*60/perMinute)});
    this.db.prepare('INSERT INTO rates VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET tokens=excluded.tokens,updated=excluded.updated').run(id,tokens-1,now);
  }
  sendReplay(auth,id,key,request) {
    const existing=this.db.prepare('SELECT * FROM sends WHERE principal=? AND sender=? AND key=?').get(auth.principal_id,id,key);
    if(existing){
      if(!auth.scopes.includes(existing.scope)) fail(403,'forbidden');
      if(existing.request!==request) fail(409,'idempotency_conflict','headers.Idempotency-Key');
      return Object.defineProperty(parse(existing.result),'_replayed',{value:true});
    }
    return null;
  }
  send(auth,id,epoch,key,input) {
    return this.tx(()=>this.acceptSend(auth,id,epoch,key,input));
  }
  resend(auth,id,epoch,key,message,input) {
    const options=validateResend(input,{limits:this.limits});validateIdempotencyKey(key);
    const request=canonical({operation:'resend',message_id:message,...options});
    return this.tx(()=>{
      this.live(auth,id,epoch);
      const replay=this.sendReplay(auth,id,key,request);if(replay)return replay;
      validateOperationTime(key,this.clock(),this.limits.retry_window_seconds);
      const original=this.ownedMessage(auth,id,message);
      if(!original.envelope) fail(410,'content_unavailable');
      const envelope=parse(original.envelope);
      return this.acceptSend(auth,id,epoch,key,{recipient_id:original.recipient,content:envelope.content,...options,correlation_id:envelope.correlation_id,reply_to_message_id:envelope.reply_to_message_id},{request,resentFrom:message});
    });
  }
  cancel(auth,id,epoch,message) {
    return this.tx(()=>{
      this.live(auth,id,epoch);let m=this.ownedMessage(auth,id,message);
      if(!terminal(m.state)&&m.expires<=this.clock()){
        this.db.prepare("UPDATE messages SET state='expired',reason='ttl_expired',terminal_at=? WHERE id=?").run(this.clock(),message);
      } else if(!terminal(m.state)){
        // Keep an outstanding claim identity so a late valid delivered receipt can
        // resolve uncertainty. Cancellation cannot retract a recipient's inbox.
        this.db.prepare("UPDATE messages SET state='cancelled',reason='sender_cancelled',cancelled_at=?,terminal_at=? WHERE id=?").run(this.clock(),this.clock(),message);
      }
      m=this.ownedMessage(auth,id,message);
      return {...this.receiptRow(m),cancel_result:m.state==='cancelled'?'cancelled':m.state==='delivered'?'already_delivered':'already_terminal',further_delivery_stopped:true,delivery_may_have_occurred:m.state==='delivered'||!!m.uncertain};
    });
  }
  acceptSend(auth,id,epoch,key,input,{request:operationRequest,resentFrom}={}) {
    const b=validateSend(input,{limits:this.limits}); validateIdempotencyKey(key);
    const request=operationRequest??canonical(b);
      let sender=this.live(auth,id,epoch);
      const replay=this.sendReplay(auth,id,key,request);if(replay)return replay;
      validateOperationTime(key,this.clock(),this.limits.retry_window_seconds);
      const recipient=this.db.prepare('SELECT * FROM sessions WHERE id=?').get(b.recipient_id);
      const scope=recipient&&auth.scopes.find(x=>parse(sender.scopes).includes(x)&&parse(recipient.scopes).includes(x));
      if(!recipient||!scope) fail(404,'recipient_not_found','recipient_id');
      if(recipient.closed) fail(410,'session_closed','recipient_id');
      const caps=parse(recipient.capabilities);
      if(!caps.receive_enabled) fail(422,'receiving_disabled','recipient_id');
      if(!caps.durable_inbox||caps.protocol_version!=='1') fail(422,'incompatible_receiver_transport','recipient_id');
      this.sweepInternal(100);
      const pending=this.db.prepare("SELECT count(*) n,coalesce(sum(bytes),0) bytes FROM messages WHERE recipient=? AND state IN ('queued','claimed')").get(recipient.id);
      const bytes=Buffer.byteLength(b.content.text);
      if(pending.n>=this.limits.max_pending_messages||pending.bytes+bytes>this.limits.max_pending_bytes) fail(429,'mailbox_full','recipient_id',{retryable:true,retry_after:5});
      this.rate(`sender:${id}`,this.limits.send_per_minute,this.limits.send_burst);
      this.rate(`principal:${auth.principal_id}`,this.limits.principal_send_per_minute,this.limits.principal_send_burst);
      this.rate('global',this.limits.global_send_per_minute,this.limits.global_send_burst);
      if(b.metadata_patch!==undefined) sender=this.patch(sender,b);
      const now=this.clock(), expires=now+b.ttl_seconds*1000, messageId=randomUUID(), sequence=recipient.next_sequence+1;
      const envelope={protocol_version:'1',message_id:messageId,recipient_id:recipient.id,recipient_sequence:sequence,sender:{client_id:id,client_type:sender.type,...parse(sender.metadata),metadata_revision:sender.revision},origin:'broker_agent',authority:'untrusted_agent_input',content:b.content,accepted_at:iso(now),expires_at:iso(expires),correlation_id:b.correlation_id??null,reply_to_message_id:b.reply_to_message_id??null};
      this.db.prepare('UPDATE sessions SET next_sequence=? WHERE id=?').run(sequence,recipient.id);
      this.db.prepare("INSERT INTO messages(id,sender,recipient,scope,sequence,envelope,bytes,state,accepted,expires,resent_from) VALUES(?,?,?,?,?,?,?,'queued',?,?,?)").run(messageId,id,recipient.id,scope,sequence,canonical(envelope),bytes,now,expires,resentFrom??null);
      const result={message_id:messageId,recipient_sequence:sequence,delivery_state:'queued',recipient_connected_at_acceptance:recipient.lease_until>now,expires_at:iso(expires),status_url:`/v1/messages/${messageId}`,server_time:iso(now),...(resentFrom?{resent_from_message_id:resentFrom}:{})};
      this.db.prepare('INSERT INTO sends VALUES(?,?,?,?,?,?,?)').run(auth.principal_id,id,key,request,messageId,scope,canonical(result));
      return result;
  }
  receiptRow(m) {return {message_id:m.id,recipient_id:m.recipient,recipient_sequence:m.sequence,delivery_state:m.state,attempt_count:m.attempts,reason:m.reason,delivery_uncertain:!!m.uncertain,accepted_at:iso(m.accepted),expires_at:iso(m.expires),claimed_at:m.claimed_at===null?null:iso(m.claimed_at),delivered_at:m.delivered_at===null?null:iso(m.delivered_at),terminal_at:m.terminal_at===null?null:iso(m.terminal_at),server_time:iso(this.clock()),...(m.resent_from?{resent_from_message_id:m.resent_from}:{}),...(m.cancelled_at!==null&&m.cancelled_at!==undefined?{cancelled_at:iso(m.cancelled_at)}:{})};}
  receipt(auth,client,id) {
    this.own(auth,client);
    this.sweep();
    let m=this.db.prepare('SELECT * FROM messages WHERE id=?').get(id);
    if(!m||![m.sender,m.recipient].includes(client)||!auth.scopes.includes(m.scope)) fail(404,'message_not_found');
    if(!terminal(m.state)&&m.expires<=this.clock()){
      this.tx(()=>this.db.prepare("UPDATE messages SET state='expired',reason='ttl_expired',terminal_at=? WHERE id=?").run(this.clock(),id));
      m=this.db.prepare('SELECT * FROM messages WHERE id=?').get(id);
    }
    return this.receiptRow(m);
  }
  ownedMessage(auth, client, id) {
    this.own(auth,client);
    const m=this.db.prepare('SELECT * FROM messages WHERE id=?').get(id);
    if(!m||m.sender!==client||!auth.scopes.includes(m.scope)) fail(404,'message_not_found');
    return m;
  }
  messageContent(auth,client,id) {
    this.sweep();
    const m=this.ownedMessage(auth,client,id);
    if(!m.envelope) fail(410,'content_unavailable');
    return {sender_id:m.sender,...this.receiptRow(m),envelope:parse(m.envelope)};
  }
  history(auth,client,query={}) {
    this.own(auth,client);
    const allowed=['recipient_id','status','accepted_after','accepted_before','limit','cursor'];
    if(Object.keys(query).some(k=>!allowed.includes(k))) fail(400,'invalid_request','query');
    const limit=query.limit===undefined?10:Number(query.limit);
    if(!Number.isSafeInteger(limit)||limit<1||limit>100||query.limit!==undefined&&!/^[1-9][0-9]*$/.test(String(query.limit))) fail(400,'invalid_request','query.limit');
    const filter={};
    if(query.recipient_id!==undefined) filter.recipient_id=validateUuid(query.recipient_id,'query.recipient_id');
    if(query.status!==undefined){
      if(!['queued','claimed','delivered','expired','failed','cancelled'].includes(query.status)) fail(400,'invalid_request','query.status');
      filter.status=query.status;
    }
    for(const key of ['accepted_after','accepted_before']) if(query[key]!==undefined){
      const n=Date.parse(query[key]);
      if(!Number.isSafeInteger(n)||iso(n)!==query[key]) fail(400,'invalid_request',`query.${key}`);
      filter[key]=n;
    }
    if(filter.accepted_after!==undefined&&filter.accepted_before!==undefined&&filter.accepted_after>=filter.accepted_before) fail(400,'invalid_request','query');
    this.sweep();
    const fingerprint=digest({client,filter,scopes:[...auth.scopes].sort()}), revision=this.db.prepare('SELECT revision FROM history_revisions WHERE sender=?').get(client)?.revision??0;
    const stateRevision=filter.status?(this.db.prepare('SELECT revision FROM history_state_revisions WHERE sender=? AND state=?').get(client,filter.status)?.revision??0):0;
    let cursor;
    if(query.cursor!==undefined){
      try{
        if(typeof query.cursor!=='string'||query.cursor.length>1024||!/^[A-Za-z0-9_-]+$/.test(query.cursor)) throw Error();
        cursor=parse(Buffer.from(query.cursor,'base64url').toString());
        if(!cursor||Object.keys(cursor).sort().join(',')!=='after,id,revision,snapshot,state_revision,time,valid_until,view'||cursor.view!==fingerprint||!Number.isSafeInteger(cursor.snapshot)||cursor.snapshot<0||!Number.isSafeInteger(cursor.revision)||cursor.revision<0||!Number.isSafeInteger(cursor.state_revision)||cursor.state_revision<0||!Number.isSafeInteger(cursor.after)||!Number.isSafeInteger(cursor.valid_until)||!Number.isSafeInteger(cursor.time)||Math.abs(cursor.time)>8640000000000000||Math.abs(cursor.after)>8640000000000000) throw Error();
        validateUuid(cursor.id);
      }catch{fail(400,'invalid_request','query.cursor');}
      if(cursor.state_revision!==stateRevision||['queued','claimed','expired'].includes(filter.status)&&this.clock()>=cursor.valid_until) fail(409,'history_changed','query.cursor');
    } else cursor={view:fingerprint,revision,state_revision:stateRevision,snapshot:this.db.prepare('SELECT n FROM history_clock WHERE id=1').get().n,time:this.clock(),valid_until:this.db.prepare("SELECT min(expires) n FROM messages WHERE sender=? AND state IN ('queued','claimed') AND expires>?").get(client,this.clock()).n??8640000000000000,after:8640000000000000,id:'ffffffff-ffff-4fff-bfff-ffffffffffff'};
    // Only metadata is selected. A page inspects at most 1000 candidates; sparse
    // filters may yield empty pages with a continuation, never an unbounded scan.
    const columns='history_order,id,sender,recipient,scope,sequence,state,accepted,expires,attempts,reason,uncertain,claimed_at,delivered_at,terminal_at,resent_from,cancelled_at';
    const rows=this.db.prepare(`SELECT ${columns} FROM messages WHERE sender=? AND (accepted,id)<(?,?) ORDER BY accepted DESC,id DESC LIMIT ?`).all(client,cursor.after,cursor.id,HISTORY_SCAN+1);
    const result={messages:[],next_cursor:null,retention_changed:cursor.revision!==revision,snapshot_at:iso(cursor.time),server_time:iso(this.clock())};
    const encode=c=>Buffer.from(canonical(c)).toString('base64url');
    let consumed=0,last=cursor;
    for(const m of rows){
      // Expiry is a clock fact even when bounded background cleanup has not yet
      // persisted this row. Its cursor deadline handles filter membership changes.
      if(!terminal(m.state)&&m.expires<=this.clock()){m.state='expired';m.reason='ttl_expired';m.terminal_at=m.expires;}
      if(consumed===HISTORY_SCAN||result.messages.length===limit) break;
      const next={...cursor,after:m.accepted,id:m.id};
      const matches=m.history_order<=cursor.snapshot&&auth.scopes.includes(m.scope)&&(!filter.recipient_id||m.recipient===filter.recipient_id)&&(!filter.status||m.state===filter.status)&&(filter.accepted_after===undefined||m.accepted>=filter.accepted_after)&&(filter.accepted_before===undefined||m.accepted<filter.accepted_before);
      if(matches){
        const item={sender_id:m.sender,...this.receiptRow(m)};
        if(Buffer.byteLength(JSON.stringify({...result,messages:[...result.messages,item],next_cursor:encode(next)}))>HISTORY_BYTES) break;
        result.messages.push(item);
      }
      consumed++;last=next;
    }
    if(consumed<rows.length) result.next_cursor=encode(last);
    return result;
  }
  sweepInternal(batch=100) {
    const now=this.clock();
    this.db.prepare("UPDATE messages SET state='expired',reason='ttl_expired',terminal_at=? WHERE id IN (SELECT id FROM messages WHERE state IN ('queued','claimed') AND expires<=? LIMIT ?)").run(now,now,batch);
    this.db.prepare("UPDATE messages SET state=CASE WHEN attempts>=? THEN 'failed' ELSE 'queued' END,reason=CASE WHEN attempts>=? THEN 'attempts_exhausted' ELSE NULL END,terminal_at=CASE WHEN attempts>=? THEN ? ELSE NULL END,claim_id=NULL,claim_epoch=NULL,claim_until=NULL WHERE id IN (SELECT m.id FROM messages m JOIN sessions s ON s.id=m.recipient WHERE m.state='claimed' AND (m.claim_until<=? OR s.lease_until<=? OR m.claim_epoch!=s.epoch) LIMIT ?)").run(this.limits.max_attempts,this.limits.max_attempts,this.limits.max_attempts,now,now,now,batch);
    const old=this.db.prepare('SELECT id FROM messages WHERE terminal_at IS NOT NULL AND terminal_at<=? AND expires<=? LIMIT ?').all(now-this.limits.retention_seconds*1000,now-this.limits.retry_window_seconds*1000,batch);
    for(const m of old){
      this.db.prepare('DELETE FROM sends WHERE message=?').run(m.id);this.db.prepare('DELETE FROM messages WHERE id=?').run(m.id);
    }
    this.db.prepare('DELETE FROM registrations WHERE rowid IN (SELECT rowid FROM registrations WHERE created<? LIMIT ?)').run(now-this.limits.registration_retention_seconds*1000,batch);
    this.db.prepare('DELETE FROM claims WHERE rowid IN (SELECT rowid FROM claims WHERE created<? LIMIT ?)').run(now-(this.limits.max_ttl_seconds+this.limits.retention_seconds)*1000,batch);
    this.db.prepare('DELETE FROM completions WHERE rowid IN (SELECT rowid FROM completions WHERE created<? LIMIT ?)').run(now-(this.limits.max_ttl_seconds+this.limits.retention_seconds)*1000,batch);
    this.presence?.sweep(batch);
  }
  sweep() {return this.tx(()=>this.sweepInternal());}
  claim(auth,id,epoch,key,input,{finalizeEmpty=true}={}) {
    const b=validateClaim(input,{limits:this.limits});validateIdempotencyKey(key);const request=canonical(b);
    return this.tx(()=>{
      this.live(auth,id,epoch);this.sweepInternal();
      const prior=this.db.prepare('SELECT * FROM claims WHERE client=? AND epoch=? AND key=?').get(id,epoch,key);
      if(prior){
        if(prior.request!==request) fail(409,'idempotency_conflict','headers.Idempotency-Key');
        if(prior.result===null)return null;
        const result=parse(prior.result), m=this.db.prepare('SELECT * FROM messages WHERE id=?').get(result.envelope.message_id);
        if(m&&!auth.scopes.includes(m.scope)) fail(403,'forbidden');
        if(!m||m.claim_id!==result.claim_id||m.claim_epoch!==epoch||m.state!=='claimed'||m.claim_until<=this.clock()) fail(409,'claim_conflict');
        return result;
      }
      const empty=()=>{if(finalizeEmpty)this.db.prepare('INSERT INTO claims VALUES(?,?,?,?,NULL,?)').run(id,epoch,key,request,this.clock());return null;};
      const head=this.db.prepare("SELECT * FROM messages WHERE recipient=? AND state IN ('queued','claimed') ORDER BY sequence LIMIT 1").get(id);
      if(head&&!auth.scopes.includes(head.scope)) fail(403,'forbidden');
      if(head&&head.expires<=this.clock()){
        this.db.prepare("UPDATE messages SET state='expired',reason='ttl_expired',terminal_at=? WHERE id=?").run(this.clock(),head.id);
        return empty(); // bounded work; next poll advances past this expired head
      }
      if(!head||head.state==='claimed'){
        return empty();
      }
      if(head.attempts>=this.limits.max_attempts){this.db.prepare("UPDATE messages SET state='failed',reason='attempts_exhausted',terminal_at=? WHERE id=?").run(this.clock(),head.id);return empty();}
      const now=this.clock(), claimId=randomUUID(), until=Math.min(head.expires,now+this.limits.claim_seconds*1000);
      const result={envelope:parse(head.envelope),claim_id:claimId,lease_epoch:epoch,attempt:head.attempts+1,claim_expires_at:iso(until)};
      this.db.prepare("UPDATE messages SET state='claimed',claim_id=?,claim_epoch=?,claim_until=?,attempts=attempts+1,claim_prior_uncertain=uncertain,uncertain=1,claimed_at=? WHERE id=?").run(claimId,epoch,until,now,head.id);
      this.db.prepare('INSERT INTO claims VALUES(?,?,?,?,?,?)').run(id,epoch,key,request,canonical(result),now);
      return result;
    });
  }
  currentClaim(auth,id,epoch,message,claimId,{allowCancelled=false}={}){
    this.live(auth,id,epoch);
    const m=this.db.prepare('SELECT * FROM messages WHERE id=?').get(message);
    if(!m||m.recipient!==id||!auth.scopes.includes(m.scope)) fail(404,'message_not_found');
    if(m.expires<=this.clock()) fail(410,'message_expired');
    if(!(m.state==='claimed'||allowCancelled&&m.state==='cancelled')||m.claim_id!==claimId||m.claim_epoch!==epoch||m.claim_until<=this.clock()) fail(409,'claim_conflict');
    return m;
  }
  renew(auth,id,epoch,message,input){const b=validateRenew(input);return this.tx(()=>{
    const m=this.currentClaim(auth,id,epoch,message,b.claim_id),until=Math.min(m.expires,this.clock()+this.limits.claim_seconds*1000);
    this.db.prepare('UPDATE messages SET claim_until=? WHERE id=?').run(until,message);
    return {claim_id:b.claim_id,lease_epoch:epoch,claim_expires_at:iso(until)};
  });}
  complete(auth,id,epoch,message,input){const b=validateCompletion(input),request=canonical(b);return this.tx(()=>{
    this.live(auth,id,epoch);
    const prior=this.db.prepare('SELECT * FROM completions WHERE claim=?').get(b.claim_id);
    if(prior){
      const accepted=this.db.prepare('SELECT scope,recipient FROM messages WHERE id=?').get(message);
      if(!accepted||accepted.recipient!==id||!auth.scopes.includes(accepted.scope))fail(404,'message_not_found');
      if(prior.client!==id||prior.epoch!==epoch||prior.message!==message||prior.request!==request)fail(409,'claim_conflict');return parse(prior.result);
    }
    const m=this.currentClaim(auth,id,epoch,message,b.claim_id,{allowCancelled:true}),now=this.clock();
    let state=b.outcome==='delivered'?'delivered':m.state==='cancelled'?'cancelled':b.outcome==='permanent_not_stored'||m.attempts>=this.limits.max_attempts?'failed':'queued';
    const reason=state==='delivered'?null:state==='cancelled'?'sender_cancelled':state==='failed'?(b.outcome==='permanent_not_stored'?'recipient_rejected':'attempts_exhausted'):(b.reason??null);
    // A not-stored response resolves only this attempt, not an earlier unconfirmed delivery.
    const uncertain=state==='delivered'?0:m.claim_prior_uncertain;
    this.db.prepare('UPDATE messages SET state=?,reason=?,uncertain=?,delivered_at=?,terminal_at=?,claim_id=NULL,claim_epoch=NULL,claim_until=NULL WHERE id=?').run(state,reason,uncertain,state==='delivered'?now:null,terminal(state)?now:null,message);
    const result=this.receiptRow(this.db.prepare('SELECT * FROM messages WHERE id=?').get(message));
    this.db.prepare('INSERT INTO completions VALUES(?,?,?,?,?,?,?)').run(b.claim_id,id,epoch,message,request,canonical(result),now);
    return result;
  });}
}
