# Calendar hardening — 16 October 2026

This slice builds on the saved provider/connection and occurrence-identity commits from 13 October. It is prepared on `calendar-hardening`; the original `calendar-reliability` worktree and its uncommitted status-note edit are preserved.

## Verified behavior

- Both Google and opaque test adapters complete independently HMAC-verified subscription challenges and signed occurrence delivery through the public service/alarm interfaces with real SQLite persistence. A lost acknowledgement retries identical bytes and logical identity with a fresh signature timestamp; replay after acceptance sends nothing more.
- Moving an instance earlier or later retains its recurrence slot, creates a new alarm, suppresses the old wake and advances only the valid instance. Cancellation suppresses work; restoration is revalidated under the current grant. These tests do not cover all series-edit, DST and pending-delivery races in the checklist.
- Delaying notification 2's cursor write reproduced cursor rollback from 4 to 2 for both adapters before the fix. Cursor ordering and persistence now run under the synchronization lock, with persistence after successful snapshot/alarm handling. A second delayed initial-read case verifies that notification 5 cannot resynchronize or overwrite completed notification 6. Busy synchronization returns retryable 503; failed synchronization preserves the prior cursor and visible manual recovery warning.
- Subscriber backoff uses injectable equal jitter, persisted in `next_at`, with no attempt before that time. Valid Retry-After seconds or exact HTTP-date hints set a minimum delay. Invalid/oversized hints are ignored. A delay at/beyond the existing five-minute expiry exhausts the delivery and clears its body; the six-attempt limit and remaining lease/network budgets remain enforced.
- Native OpenAI status-only responses retain only bounded Retry-After metadata and discard bodies immediately. The pinned Go status-only transport still exposes status without retry hints. The opaque dispatcher retains its existing wake schedule, so delivery may occur later than the persisted minimum.

## Required checks

All 133 tests pass, including local Workers/D1 restart, Durable Object and TLS tests. Typecheck, lint, production build and `git diff --check` pass. Listener permission was required by the local runtime tests. No temporary debug probes remain.

Red/green records for this run are in `/tmp/hardening-cursor-red.log`, `/tmp/hardening-cursor-green.log`, `/tmp/hardening-retry-red.log`, `/tmp/hardening-focused.log`, `/tmp/hardening-tests-final.log`, and `/tmp/hardening-build-final.log`; these are local evidence files, not repository artifacts.

## Evidence boundary and next work

This is deterministic fake-provider/local runtime evidence. No new Google event, ChatGPT receiver, cross-task message, hosted migration or deployment was performed. Fresh calendar-to-task acceptance and post-limit continuation remain separate, coordinator-owned checks. Connection-level hosted callback policy remains unverified; issues #1/#4/#6 stay open.

Unchecked recurrence and pending-delivery races, bounded watch renewal/convergence, and the fresh live demonstration remain in the reliability checklist. Manual watch renewal and resync remain the current recovery behavior. This PR makes no exactly-once execution guarantee and introduces no new infrastructure.
