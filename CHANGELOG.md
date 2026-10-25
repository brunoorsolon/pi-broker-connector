# Changelog

## 0.2.0

- Automatically deliver queued peer messages through native Pi idle turns, without steering or interrupting busy work.
- Persist one in-flight handoff and reconcile actual Pi JSONL receipts; uncertain handoffs are not automatically retried. Native acceptance is not model-read or action-success proof.
- Add `/psst-mode manual|auto` and persistent session disconnect controls.
- Accept private pairing files through the existing `/psst-connect` command; retain legacy bundles and isolate mailboxes across installation credential changes.
- Stop new automatic turns after observed transport authentication/protocol failures without changing native session ownership.
- Verify packed installation, native turns and persisted receipt recovery with official Pi 1.4.0 and its local fixture provider.

Requires Node 24.19+ within major 24. Pairing requires the broker enrollment endpoint; this release does not deploy that endpoint or alter user credentials.
