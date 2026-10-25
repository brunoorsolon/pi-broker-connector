# Changelog

## 0.3.1

- Fix the masked pairing field ignoring Enter, Escape and Ctrl+C when the terminal negotiates Kitty keyboard sequences. Use the public Pi TUI key decoder, ignore key releases, and preserve legacy input.
- Keep bracketed paste masked and atomic, permit cancellation, and show a non-secret validation hint instead of silently waiting on an invalid value.
- Add real POSIX PTY regression tests with official Pi 1.4.0 terminal negotiation, including split raw paste frames, encoded and legacy Enter/Escape/Ctrl+C. No pairing or credential policy changes.


## 0.3.0

- Add `/psst-setup` inside Pi: HTTPS URL, explicit consent and a masked native field for the one-time operator-approved secret. No secret in chat/command arguments and no bundle/ticket-file transfer for this route.
- Persist each installation credential under the native `PI_CODING_AGENT_DIR` scope. New sessions reconnect automatically with independent client IDs and inboxes; setup is not repeated for every session.
- Atomically save URL and connection selection only after successful current-session attachment, using cross-process compare-and-swap. Failed or concurrent setups do not overwrite another selected installation.
- Preserve existing private-file connections, explicit state overrides and legacy inboxes. New credentials persist separately even when a legacy inbox root exists. Old pending inboxes are **not migrated** or made durable retroactively; retain them for coordinated recovery.
- Never automatically mint replacement credentials on authentication failure or expiry. Broker 0.3.0 pairing must be explicitly enabled and an operator grant approved once per installation/type/scope.
- Verify 30 independent sessions and 30 concurrent selection writers; exercise official Pi 1.4.0 masked UI against a real disposable HTTPS broker, then recreate HOME with only the agent directory retained: one credential, two sessions, automatic reconnection.

After release publication and npm workflow success:
`pi install npm:@matuto-ai/pi-broker-connector@0.3.0`, then `/reload` and first-time `/psst-setup` inside Pi. Existing configured sessions reconnect without first-time setup. Different project/profile agent-directory mounts are separate installations. This release does not deploy the broker, approve live grants, or certify a logged-in user's model exchange.

## 0.2.0

- Automatically deliver queued peer messages through native Pi idle turns, without steering or interrupting busy work.
- Persist one in-flight handoff and reconcile actual Pi JSONL receipts; uncertain handoffs are not automatically retried. Native acceptance is not model-read or action-success proof.
- Add `/psst-mode manual|auto` and persistent session disconnect controls.
- Accept private pairing files through the existing `/psst-connect` command; retain legacy bundles and isolate mailboxes across installation credential changes.
- Stop new automatic turns after observed transport authentication/protocol failures without changing native session ownership.
- Verify packed installation, native turns and persisted receipt recovery with official Pi 1.4.0 and its local fixture provider.

Requires Node 24.19+ within major 24. Pairing requires the broker enrollment endpoint; this release does not deploy that endpoint or alter user credentials.
