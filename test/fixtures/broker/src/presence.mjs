import { randomUUID } from 'node:crypto';
import { ApiError, validateUuid } from './protocol.mjs';

const iso = value => new Date(value).toISOString();
const MAX_EVENTS = 10000;
const MAX_PAGE_BYTES = 65536;
const MESSAGE_SAMPLE = 10;

/** A lease observation, not a probe of a process or model. */
export function presenceSnapshot(session, now) {
  const connected = !session.closed && session.lease_until > now;
  return {
    connected,
    presence_state: session.closed ? 'closed' : connected ? 'connected' : 'disconnected',
    last_heartbeat_at: iso(session.heartbeat_at),
    lease_expires_at: iso(session.lease_until),
    observed_at: iso(now),
  };
}

/** Metadata-only notices. Called inside the broker's existing single-writer tx. */
export class PresenceService {
  constructor(store) {
    this.store = store;
    this.cursor = '';
    store.tx(() => store.db.exec(`
      CREATE TABLE IF NOT EXISTS session_disconnects (
        session TEXT PRIMARY KEY, epoch INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS presence_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT UNIQUE NOT NULL, sender TEXT NOT NULL, recipient TEXT NOT NULL,
        epoch INTEGER NOT NULL, heartbeat INTEGER NOT NULL, created INTEGER NOT NULL, scopes TEXT NOT NULL,
        acknowledged INTEGER NOT NULL DEFAULT 0,
        UNIQUE(sender,recipient,epoch,heartbeat));
      CREATE INDEX IF NOT EXISTS presence_sender ON presence_events(sender,acknowledged,sequence);
      CREATE INDEX IF NOT EXISTS presence_pending ON messages(recipient,state,sender,expires);
    `));
  }

  sweep(batch = 100) {
    const { db, limits } = this.store;
    const now = this.store.clock();
    // A new verified registration/heartbeat ends the previous absence episode.
    // Keep acknowledged current-episode rows as dedupe tombstones, even if the
    // current messages finish: later sends in that same absence must not spam.
    db.prepare(`DELETE FROM presence_events WHERE sequence IN (
      SELECT e.sequence FROM presence_events e LEFT JOIN sessions r ON r.id=e.recipient
      WHERE r.id IS NULL OR r.closed=1 OR r.epoch!=e.epoch OR r.heartbeat_at!=e.heartbeat
      LIMIT ?
    )`).run(batch);
    let room = MAX_EVENTS - db.prepare('SELECT count(*) n FROM presence_events').get().n;
    if (room <= 0) return;
    let budget = Math.min(batch, room);
    const recipients = db.prepare('SELECT * FROM sessions WHERE id>? ORDER BY id LIMIT ?').all(this.cursor, batch);
    for (const recipient of recipients) {
      this.cursor = recipient.id;
      if (recipient.closed || recipient.lease_until > now || recipient.heartbeat_at > now - limits.offline_notice_seconds * 1000) continue;
      const senders = db.prepare(`SELECT DISTINCT m.sender FROM messages m
        JOIN sessions s ON s.id=m.sender
        WHERE m.recipient=? AND m.state IN ('queued','claimed') AND m.expires>?
          AND EXISTS (SELECT 1 FROM json_each(s.scopes) WHERE value=m.scope)
          AND NOT EXISTS (SELECT 1 FROM presence_events e WHERE e.sender=m.sender
            AND e.recipient=? AND e.epoch=? AND e.heartbeat=?)
        ORDER BY m.sender LIMIT ?`).all(recipient.id, now, recipient.id, recipient.epoch, recipient.heartbeat_at, budget);
      for (const { sender } of senders) {
        const scopes = db.prepare(`SELECT DISTINCT m.scope FROM messages m JOIN sessions s ON s.id=m.sender
          WHERE m.sender=? AND m.recipient=? AND m.state IN ('queued','claimed') AND m.expires>?
            AND EXISTS (SELECT 1 FROM json_each(s.scopes) WHERE value=m.scope) LIMIT 32`).all(sender, recipient.id, now).map(row => row.scope);
        db.prepare('INSERT INTO presence_events(id,sender,recipient,epoch,heartbeat,created,scopes) VALUES(?,?,?,?,?,?,?)')
          .run(randomUUID(), sender, recipient.id, recipient.epoch, recipient.heartbeat_at, now, JSON.stringify(scopes));
        budget--;
      }
      if (!budget) return;
    }
    if (recipients.length < batch) this.cursor = '';
  }

  page(auth, sender, query = {}) {
    const session = this.store.own(auth, sender);
    const scopes = auth.scopes.filter(scope => JSON.parse(session.scopes).includes(scope));
    if (Object.keys(query).some(key => !['limit', 'cursor'].includes(key))) throw new ApiError(400, 'invalid_request', 'query');
    const limit = query.limit === undefined ? 10 : Number(query.limit);
    const cursor = query.cursor === undefined ? 0 : Number(query.cursor);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new ApiError(400, 'invalid_request', 'query.limit');
    if (!Number.isSafeInteger(cursor) || cursor < 0 || (query.cursor !== undefined && !/^(0|[1-9]\d*)$/.test(String(query.cursor)))) throw new ApiError(400, 'invalid_request', 'query.cursor');
    return this.store.tx(() => {
      this.store.sweepInternal();
      const { db } = this.store, now = this.store.clock();
      // Bound examined rows as well as returned events. An empty page may have a
      // continuation when obsolete/unavailable events occupied the scan budget.
      const rows = db.prepare('SELECT * FROM presence_events WHERE sender=? AND acknowledged=0 AND sequence>? ORDER BY sequence LIMIT 101').all(sender, cursor);
      const events = [];
      let scanned = cursor, bytes = 512, more = rows.length > 100;
      for (const row of rows.slice(0, 100)) {
        const recipient = db.prepare('SELECT * FROM sessions WHERE id=?').get(row.recipient);
        const current = recipient && !recipient.closed && recipient.lease_until <= now
          && recipient.epoch === row.epoch && recipient.heartbeat_at === row.heartbeat
          && recipient.heartbeat_at <= now - this.store.limits.offline_notice_seconds * 1000;
        if (!current || !scopes.length) { scanned = row.sequence; continue; }
        const placeholders = scopes.map(() => '?').join(',');
        const pending = db.prepare(`SELECT id,state,uncertain,scope FROM messages WHERE sender=? AND recipient=?
          AND state IN ('queued','claimed') AND expires>? AND scope IN (${placeholders})
          ORDER BY sequence LIMIT ?`).all(sender, row.recipient, now, ...scopes, MESSAGE_SAMPLE + 1);
        if (!pending.length) { scanned = row.sequence; continue; }
        const event = {
          event_id: row.id, type: 'recipient_offline', recipient_id: row.recipient,
          last_heartbeat_at: iso(row.heartbeat), created_at: iso(row.created), observed_at: iso(now),
          presence_state: 'disconnected',
          messages: pending.slice(0, MESSAGE_SAMPLE).map(message => ({ message_id: message.id,
            delivery_state: message.state, delivery_uncertain: Boolean(message.uncertain) })),
          has_more_messages: pending.length > MESSAGE_SAMPLE,
        };
        const size = Buffer.byteLength(JSON.stringify(event));
        if (events.length >= limit || bytes + size > MAX_PAGE_BYTES) { more = true; break; }
        // Record which still-authorized scopes this sender has actually observed,
        // so ACK remains reconcilable if the pending messages complete meanwhile.
        const observedScopes = [...new Set([...JSON.parse(row.scopes), ...pending.map(message => message.scope)])]
          .filter(scope => JSON.parse(session.scopes).includes(scope));
        db.prepare('UPDATE presence_events SET scopes=? WHERE id=?').run(JSON.stringify(observedScopes), row.id);
        events.push(event); bytes += size; scanned = row.sequence;
      }
      return { events, next_cursor: more ? String(scanned) : null, server_time: iso(now),
        capacity_limited: db.prepare('SELECT count(*) n FROM presence_events').get().n >= MAX_EVENTS };
    });
  }

  acknowledge(auth, sender, eventId) {
    const session = this.store.own(auth, sender);
    eventId = validateUuid(eventId, 'path.event_id');
    return this.store.tx(() => {
      const event = this.store.db.prepare('SELECT * FROM presence_events WHERE id=? AND sender=?').get(eventId, sender);
      if (!event || !auth.scopes.some(scope => JSON.parse(event.scopes).includes(scope) && JSON.parse(session.scopes).includes(scope))) throw new ApiError(404, 'message_not_found');
      this.store.db.prepare('UPDATE presence_events SET acknowledged=1 WHERE id=?').run(eventId);
      return { event_id: eventId, acknowledged: true };
    });
  }
}
