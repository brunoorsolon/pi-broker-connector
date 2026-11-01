import { openSync, closeSync, readSync, fstatSync, statSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { nativeMessage, NATIVE_FORMAT } from './message-format.mjs';
import { LocalError } from '../vendor/broker/reference/errors.mjs';

export const CUSTOM_TYPE = 'psst-agent-message';
const SCAN_LIMIT = 4 * 1024 * 1024;

// Inspect only a bounded append window after the pre-handoff offset. Never log
// transcript content. An in-memory entry alone is not evidence of persistence.
export function findPersistedReceipt(file, offset, expected) {
  let fd;
  try {
    fd = openSync(file, 'r');
    const size = fstatSync(fd).size;
    if (size < offset) return null;
    const bytes = Buffer.alloc(Math.min(size - offset, SCAN_LIMIT));
    const count = readSync(fd, bytes, 0, bytes.length, offset);
    const text = bytes.subarray(0, count).toString('utf8');
    for (const line of text.slice(0, text.lastIndexOf('\n') + 1).split('\n')) {
      let row; try { row = JSON.parse(line); } catch { continue; }
      if (row.type === 'custom_message' && row.customType === CUSTOM_TYPE && typeof row.id === 'string'
          && row.details?.message_id === expected.messageId && row.details?.injection_id === expected.injectionId
          && row.details?.client_id === expected.clientId && row.content === expected.content) return row.id;
    }
    return null;
  } catch { return null; }
  finally { if (fd !== undefined) closeSync(fd); }
}

export class NativeDelivery {
  constructor({ session, pi, ctx, diagnostic = () => {} }) {
    this.session = session; this.inbox = session.inbox; this.pi = pi; this.ctx = ctx;
    let lastDiagnostic;
    this.diagnostic = code => { if (code !== lastDiagnostic) { lastDiagnostic = code; diagnostic(code); } };
    this.timer = null; this.stopped = false;
    this.inbox.transaction(() => {
      this.inbox.db.exec(`CREATE TABLE IF NOT EXISTS pi_native_handoffs(
        message_id TEXT PRIMARY KEY REFERENCES inbox(message_id) ON DELETE CASCADE,
        injection_id TEXT NOT NULL, session_file TEXT NOT NULL, file_offset INTEGER NOT NULL, format_version TEXT);
        CREATE TABLE IF NOT EXISTS pi_delivery_settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);`);
      // NULL identifies pre-upgrade handoffs; never reinterpret their receipts.
      if (!this.inbox.db.prepare('PRAGMA table_info(pi_native_handoffs)').all().some(column => column.name === 'format_version')) {
        this.inbox.db.exec('ALTER TABLE pi_native_handoffs ADD COLUMN format_version TEXT');
      }
    });
  }
  get mode() { return this.inbox.db.prepare("SELECT value FROM pi_delivery_settings WHERE key='mode'").get()?.value || 'auto'; }
  get disconnected() { return this.inbox.db.prepare("SELECT value FROM pi_delivery_settings WHERE key='disconnected'").get()?.value === 'true'; }
  setting(key, value) { this.inbox.transaction(() => this.inbox.db.prepare('INSERT OR REPLACE INTO pi_delivery_settings(key,value) VALUES(?,?)').run(key,value)); }
  setMode(mode) { if (!['auto','manual'].includes(mode)) throw new LocalError('invalid_configuration'); this.setting('mode',mode); }
  start() { this.timer = setInterval(() => this.tick(), 500); this.timer.unref?.(); }
  stop() { this.stopped = true; clearInterval(this.timer); this.timer = null; }
  tick() {
    if (this.stopped || !this.session.isAlive()) return;
    try {
      this.inbox.assertUsable();
      const head = this.inbox.head();
      if (!head) return;
      const saved = this.inbox.db.prepare('SELECT * FROM pi_native_handoffs WHERE message_id=?').get(head.message_id);
      if (head.state !== 'pending') {
        if (saved && this.ctx.sessionManager.getSessionFile?.() === saved.session_file) {
          const receipt = findPersistedReceipt(saved.session_file, saved.file_offset, {
            messageId: head.message_id, injectionId: saved.injection_id, clientId: this.inbox.identity.client_id, content: nativeMessage(head.envelope, saved.format_version),
          });
          if (receipt) {
            this.inbox.recordNativeAcceptance(head.message_id, saved.injection_id, {accepted:true,receipt_id:`pi:${receipt}`});
            this.diagnostic('native_context_accepted'); return;
          }
        }
        this.diagnostic('native_handoff_unknown'); return;
      }
      if (this.mode !== 'auto' || this.disconnected) return;
      if (this.session.deliveryAllowed?.() !== true) { this.diagnostic('native_delivery_paused'); return; }
      if (head.envelope.sender.client_id === this.inbox.identity.client_id) { this.diagnostic('self_message_requires_manual'); return; }
      // Leave busy/compacting sessions alone. The synchronous check + native call
      // happen in one JS turn; native Pi owns its own run/continuation scheduling.
      if (typeof this.pi.sendMessage !== 'function' || this.ctx.isIdle?.() !== true || this.ctx.hasPendingMessages?.() !== false) return;
      const file = this.ctx.sessionManager.getSessionFile?.();
      if (typeof file !== 'string' || !file.startsWith('/')) { this.diagnostic('native_session_not_persistent'); return; }
      let offset = 0;
      try { offset = statSync(file).size; } catch (error) { if (error.code !== 'ENOENT') throw error; }
      const injectionId = randomUUID();
      this.inbox.transaction(() => {
        const current = this.inbox.head();
        if (current?.message_id !== head.message_id || current.state !== 'pending') throw new LocalError('unsafe_boundary');
        this.inbox.db.prepare("UPDATE inbox SET state='injecting',injection_id=? WHERE message_id=?").run(injectionId,head.message_id);
        this.inbox.db.prepare('INSERT INTO pi_native_handoffs(message_id,injection_id,session_file,file_offset,format_version) VALUES(?,?,?,?,?)').run(head.message_id,injectionId,file,offset,NATIVE_FORMAT);
      }, {growth:4096});
      // Return/throw is not a receipt; async failure or lost completion stays
      // uncertain and is never automatically resubmitted, including after reload.
      this.pi.sendMessage({customType:CUSTOM_TYPE,content:nativeMessage(head.envelope),display:true,
        details:{message_id:head.message_id,injection_id:injectionId,client_id:this.inbox.identity.client_id}},
      {triggerTurn:true,deliverAs:'followUp'});
      this.diagnostic('native_handoff_pending');
    } catch { this.diagnostic('native_handoff_unknown'); }
  }
}
