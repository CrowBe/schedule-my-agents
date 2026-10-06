# Signed outbox slice checkpoint — 6 October 2026

Reviewed current open issues against `origin/main` at `de353e3` (merged PR #10).

| Issue | Main evidence | Remaining work |
| --- | --- | --- |
| #1 MVP tracker | OAuth, ingress, durable due work and subscription implementation shipped | Signed delivery and actual Work chat response; reconcile tracker only with acceptance evidence |
| #3 Durable timing | PR #9; hosted closed-browser wake after dispatcher redeploy, 4,412 ms claim lateness; automated race/recovery tests | Open acceptance includes bounded cleanup/horizon and real-runtime coverage; implementation is present, not a new scheduler task |
| #4 Subscriptions | PR #10; encrypted persistence, challenge, refresh/rotation, unsubscribe; hosted synthetic direct TLS | Real ChatGPT subscription and callback acceptance remain unproven |
| #5 Signed delivery | Due-work ledger and shared callback transport available | Next implementation slice |
| #6 Demonstration | Required predecessors partially proven | Wait for delivery integration and real subscription; 2xx alone is insufficient |

## Implemented delivery

The unique due-work receipt freezes the subscriber audience atomically in D1. Each subscriber gets an immutable serialized body and the same logical `evt_` identity across retries. Delivery rows persist attempts, next-at, lease, accepted/terminal/exhausted outcomes and redacted HTTP status. An attempt holds a 15-second lease and has a ten-second network budget. One subscriber attempt is processed per alarm callback to keep the existing dispatcher callback budget bounded.

The original durable alarm remains unacknowledged while work is pending. Its existing exponential retries drive recovery; D1 prevents attempts before their own backoff (2, 4, 8, 16, 32 seconds; cap 60) and bounds each delivery to six claimed attempts and the original five-minute occurrence lifetime. Crashes consume a claimed attempt. No new timer, service or infrastructure binding is needed. Large subscriber fanout can exhaust the bounded lifetime; this MVP is intended for one subscribed chat.

Every wake revalidates the actual Google occurrence. The immutable payload must still match the freshly fetched minimal payload; moved, cancelled or edited occurrences stop queued delivery. Current connection, calendar generation, subscriber filter, finite expiry, verification and subscription revision are checked before network dispatch. Disable/disconnect/unsubscribe delete queued content. Already accepted callbacks cannot be recalled. Google edits and local revocation cannot atomically cancel a network effect already underway.

The protocol body is limited to 256 KiB UTF-8 and is never truncated. The validated-IP TLS adapter now exposes HTTP status to delivery so redirects, 410 and 413 stop retries. Verification still requires a successful challenge. Non-success response bodies are discarded. The adapter allows a separate bounded 8 KiB HTTP-header overhead; TLS chain, hostname, address, timeout and response bounds remain enforced. The checked-in WASM was rebuilt using the pinned Go 1.27.1 toolchain.

Discovery requires `MCP_EVENTS_READY=true`, configured alarms, validated callback transport, verified Google ingress and a connected owner with an enabled calendar. The flag defaults false; set it only after applying migration 0005 and verifying hosted delivery. Explicit test subscriptions remain possible while the catalog is closed.

## Evidence and remaining live acceptance

Protocol checked against https://developers.openai.com/plugins/build/mcp-events on 6 October 2026. The automated Workers/D1 integration subscribes through MCP, completes a signed challenge, syncs a fake Google event, receives a real Durable Object alarm, verifies callback signatures independently, returns 503, restarts both runtimes and receives an accepted retry with identical body/ID and fresh signing time. Local SQLite regressions cover concurrent leases, lost acknowledgement/exhaustion, edit, expiry, unsubscribe, disable, disconnect, terminal responses and key rotation. Real local Go TLS tests cover status propagation as well as certificate, hostname, redirect and resource bounds.

Hosted migration/deployment, real Google-to-subscriber callback acknowledgement and actual ChatGPT response are still outstanding. Do not mark #5 or #6 complete from local tests. Delivery is bounded at-least-once attempt behavior: a crash after receiver acceptance but before D1 acknowledgement can duplicate receipt with the same logical identity. No exactly-once agent execution or protocol replay is promised.

Terminal deliveries clear serialized bodies. Existing receipts are removed by expired alarm cleanup or bounded seven-day pruning on later claims; cleanup also removes delivery rows. A Site outage can delay cleanup. Audit logs retain opaque event/alarm tags, outcome, attempt number, HTTP status and timing without event descriptions, owner IDs, callback URLs or secrets.
