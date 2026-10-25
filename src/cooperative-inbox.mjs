import { randomUUID } from 'node:crypto';
import { LocalError } from '../vendor/broker/reference/errors.mjs';
import { provenance } from '../vendor/broker/reference/runtime.mjs';
import { validateUuid } from '../vendor/broker/src/protocol.mjs';

/** Application-level explicit read ACK. Never a native injection receipt or action success. */
export function createCooperativeInbox({ inbox, isActive = () => true }) {
  if (!inbox?.db || typeof isActive !== 'function') throw new LocalError('invalid_configuration');
  inbox.transaction(() => inbox.db.exec(`CREATE TABLE IF NOT EXISTS cooperative_receipts(
    message_id TEXT PRIMARY KEY REFERENCES inbox(message_id) ON DELETE CASCADE,
    receipt_token TEXT NOT NULL, exposed_at INTEGER NOT NULL, acknowledged_at INTEGER)`));
  const active = () => { if (isActive() !== true) throw new LocalError('session_mismatch'); inbox.assertUsable(); };
  return {
    async broker_receive(args = {}) {
      if (!args || Array.isArray(args) || typeof args !== 'object' || Object.keys(args).length) throw new LocalError('invalid_configuration');
      active();
      return inbox.transaction(() => {
        const head = inbox.head();
        if (!head) return { message: null, local_mode: 'cooperative_pull' };
        if (head.state !== 'pending') throw new LocalError('injection_uncertain', { effect: 'unknown' });
        let receipt = inbox.db.prepare('SELECT receipt_token FROM cooperative_receipts WHERE message_id=?').get(head.message_id);
        if (!receipt) {
          receipt = { receipt_token: randomUUID() };
          inbox.db.prepare('INSERT INTO cooperative_receipts(message_id,receipt_token,exposed_at) VALUES(?,?,?)').run(head.message_id, receipt.receipt_token, inbox.now());
        }
        return { message_id: head.message_id, message: provenance(head.envelope), receipt_token: receipt.receipt_token,
          local_state: 'pending', local_mode: 'cooperative_pull', native_acceptance_recorded: false,
          acknowledgment_required: true };
      }, { growth: 4096 });
    },
    async broker_acknowledge(args) {
      if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).sort().join(',') !== 'message_id,receipt_token') throw new LocalError('invalid_configuration');
      try { validateUuid(args.message_id); validateUuid(args.receipt_token); } catch { throw new LocalError('invalid_configuration'); }
      active();
      return inbox.transaction(() => {
        const receipt = inbox.db.prepare('SELECT receipt_token,acknowledged_at FROM cooperative_receipts WHERE message_id=?').get(args.message_id);
        if (!receipt || receipt.receipt_token !== args.receipt_token) throw new LocalError('receipt_required');
        if (receipt.acknowledged_at == null) {
          const head = inbox.head();
          if (!head || head.message_id !== args.message_id || head.state !== 'pending') throw new LocalError('unsafe_boundary');
          inbox.db.prepare('UPDATE cooperative_receipts SET acknowledged_at=? WHERE message_id=?').run(inbox.now(), args.message_id);
          // consumed is local queue bookkeeping. Deliberately do NOT populate native_receipt.
          inbox.db.prepare("UPDATE inbox SET state='consumed',consumed_at=? WHERE message_id=?").run(inbox.now(), args.message_id);
        }
        return { message_id: args.message_id, acknowledged: true, acknowledgment_kind: 'explicit_model_read',
          native_acceptance_recorded: false, action_success: 'unknown' };
      });
    },
  };
}
