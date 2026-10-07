# MVP acceptance — 8 October 2026

The functional Google → durable alarm → signed callback → useful ChatGPT response works on the existing Site/plugin. Full MVP acceptance remains open for one platform transport boundary: native fetch does not prove connection-time validated-IP pinning. This distinction is retained in issues #1, #4 and #6.

## Scope and configuration

The user authorized reuse of the existing **Load Calendar Tools** Work Cloud chat, disposable calendar events without guests/reminders, and a separate read-only review of this repository's open PRs. One existing monitoring task was re-enabled; no time-based schedule or polling was configured. The task interface has no TTL control. The persisted Site subscription has a finite 24-hour expiry.

Site version 25 deployed merged source `dce5290cb7c4936b9e619c6af4eedf436edeef20`, environment revision 11, with `MCP_CALLBACK_TRANSPORT=native-openai` and `MCP_EVENTS_READY=true`. Existing public audience, authenticated setup, owner/grant boundaries, Google connection, D1 and the previously authorized opaque Cloudflare dispatcher were retained. No service, replacement plugin or bypass credential was added.

## Real provider and ChatGPT evidence

Times below are UTC on 7 October (8 October in Sydney, UTC+11). Provider notifications, occurrence registrations, wake results and delivery records were read from hosted logs/D1. Private calendar identifiers, owner IDs, callback URLs, secrets and ordinary event contents are omitted.

| Check | Hosted result |
| --- | --- |
| Subscription | Existing task reused; exactly one enabled monitoring record and one verified, finite Site subscription |
| Actual Google push | 22:15:41.540, request `656c6c1d38e141eaad9ab3a84e2caf7d`, channel tag `3kn4YD7LVnZQ`, message `232222212`, synchronized; happy alarm tag `BwXkidhuXIU-` registered for 22:18 |
| Manual watch renewal | Renew watch succeeded; new watch expires 15 October at 09:15:52 Sydney. Initial notification acknowledged and snapshot synchronized. Same occurrence alarm identities were retained |
| Closed-setup timing | Setup closed before 22:18. Happy wake at 22:18:02.699, **2,699 ms late**, request `322f6730626eabee6667d8344906945d` |
| Signed receipt | Same request/tag: 22:18:03.716, HTTP 200, attempt 1, accepted. D1 acknowledgement had `attempts=1`, `last_status=200`, cleared body and lease |
| Useful ChatGPT action | [Load Calendar Tools](https://chatgpt.com/c/6ac5c069-cdb0-83ec-9629-8d07ce6db39b) reported the synthetic title and 09:18 Sydney start, then checked repository PRs and reported none open. No calendar/GitHub writes |
| Moved start | Google push message `40441` registered replacement tag `qb2JZGbfwHl3` for 22:20. Old tag `qKADvXTSP310` was stale at 22:18:01.274. New wake at 22:20:01.774, **1,774 ms late**, accepted once at 22:20:02.818, request `21a95e34e12529101ec4c678f3eb860c` |
| Cancellation | Cancelled alarm tag `jU45ISLntwVC` returned `stale_or_cancelled` at 22:18:01.355; no delivery |
| Disabled calendar | A disposable Family event created with `self_attendance: omit` stayed outside the enabled Personal snapshot and delivery ledger. The first attempt used the connector's default self-invitation, creating an authorized Personal copy; it was cancelled before its start and excluded from this negative-test claim |

Google push and renewal both registered identical logical alarm IDs. Two valid occurrences produced two accepted deliveries; obsolete starts produced none. HTTP 2xx alone was supplemented with the actual useful chat response. At-least-once receipt is the guarantee: a remote acceptance followed by a local crash can repeat the same logical event.

## Final reviewed deployment

Site version 26 published source `6db4adb4d25634d12675b46cdd48e2ec3ff3f353` and environment revision 11 at 22:26:54.899. It was redeployed successfully at 22:29:14.007 with real alarms already pending. Manual Resync now then registered the same pending IDs again; setup was closed before their starts. The UI showed the bounded horizon, manual renewal/recovery instructions and the renewed watch expiry. Anonymous/forged-identity setup and MCP probes returned 401; a forged logged-out Google notification reached application validation and returned 403.

Google push message `709145`, channel tag `wMuokB8RfAFw`, request `d3dc7a09b7135e2dc810deaab707a44a`, registered reviewed-deployment tag `jw4k9pGGIy3t` for 22:31. After redeployment it produced due work at **22:31:01.048**, **1,048 ms late**, and one accepted HTTP 200 callback at **22:31:02.231**, request `aba27fb344bde65460086645338831f7`. D1 recorded attempt 1 and cleared body/lease. The original chat then reported the 09:31 Sydney event and actually reviewed PR #12, finding no blocking issues and making no writes. This response preceded the separate cleanup message.

The original 22:33 unsubscribe probe was accepted at 22:33:02.489 before task pausing finished. A cleanup request is not itself persisted revocation, and already accepted callbacks cannot be recalled. Its start was moved to 22:36 for a valid post-revocation check; only that later start can establish suppression after unsubscribe.

The chat verified the preserved task was paused (`is_enabled: false`, saved at 09:33:17 Sydney). The Site accepted `events/unsubscribe` at **22:33:21.074**, request `9ef5e10e0e5382bb9246b3707ffcdbe0`; D1 subscriptions and deliveries were empty. Subsequent real Google push message `1047553` registered new probe tag `akRfgPGR68l3` for 22:36. It woke at **22:36:02.057**, request `860c7e218413e5238ef0d8565e656cf6`, and produced due work with **no callback, zero delivery rows and no new chat response**. This proves suppression after persisted revocation, independently of the earlier pre-revocation receipt.

All seven disposable events were removed through recoverable Google Calendar deletion (including the cancelled first disabled-calendar attempt). The real Google connection, explicit Personal grant and renewed watch were retained. The monitoring task remains paused as a test record. Standards and spec review cleared the corrected code, and both PR CI checks passed before this evidence-only update.

## Automated runtime evidence

All **70 tests** pass. Actual Workers/D1/SQLite Durable Object integration covers fake-Google OAuth/consent/push create/edit/cancel, authority and newly shared/default-disabled calendars, signed subscription persistence/restart, due-time revalidation, concurrent deduplication, independent exact-body Standard Webhooks verification, 503 retry and restart with stable body/ID and fresh signing, and queued disable/disconnect/unsubscribe/expiry/edit/cancel races. Real local Go TLS/WASM tests verify certificate/hostname enforcement, terminal statuses and response bounds. This is actual local runtime/storage evidence with a fake provider; it does not claim destructive disconnect tests against the user's live Google grant.

Acceptance review also found that both transports read successful callback bodies before persisting status. Delivery now explicitly requests status-only responses and closes after headers. Verification retains its bounded challenge echo. Native persisted-delivery regressions cover oversized/stalled 200 bodies. Independent reviewers reproduced Go's deferred body-close drain with a persistent response; status-only paths now close the underlying stream directly. Real TLS tests require oversized, stalled keep-alive and stalled chunked responses to return in under one second, before the five-second body/socket timeout, using the rebuilt pinned Go 1.27.1 WASM. Existing failure-body and lease-deadline regressions remain green.

## Issue reconciliation and remaining capability

| Issue | Acceptance status |
| --- | --- |
| #2 Google ingress/sync | Previously closed; real push reverified |
| #3 Durable timing | Complete: hosted timing plus actual persisted-runtime restart/race/retention/recurrence coverage |
| #5 Signed outbox | Functional acceptance complete in the explicitly authorized native experiment; connection-time pinning tracked in #4 |
| #4 Subscriptions | Persistence, challenge, expiry, rotation and revocation complete; supported hosted connection-time public-address pinning remains unproved |
| #6 Demo | Useful response demonstrated; remains open for its full-predecessor/platform acceptance gate |
| #1 MVP tracker | Remains open for the same transport capability |

The [current MCP Events contract](https://developers.openai.com/plugins/build/mcp-events#verify-the-callback), checked during this run, requires resolving/validating addresses at connection time and connecting to the validated address with original-hostname TLS. Our default Go TLS transport implements that contract locally, but the hosted socket path denied all validated OpenAI callback destinations before TLS ([reproduction](sites-callback-support-repro.md)). Current [Cloudflare socket documentation](https://developers.cloudflare.com/workers/runtime-apis/tcp-sockets/#troubleshooting), rechecked on 8 October, still describes disallowed destinations and blocked Cloudflare IP ranges; the live error establishes denial, while exact IP-range membership remains an inference because addresses were not logged. The authorized native experiment preserves hostname TLS, public DNS preflight, signatures, no redirects and bounds; it cannot prove caller-controlled connection-time pinning.

The missing supported capability is address-pinned HTTPS egress from the Site to the real callback. The smallest alternatives are a Sites-native transport exposing that guarantee, an OpenAI callback destination allowed by raw sockets, or an explicitly approved minimal address-pinned egress runtime. No external component was provisioned to bypass this boundary.

Manual watch renewal and Resync now are supported and visible. Snapshot retention is seven days; discovery is bounded to 366 days/ten pages/500 candidates; delivery expires five minutes after start and makes at most six claimed attempts. All-day events and unlimited unattended operation remain excluded. Automatic renewal is optional outside this bounded MVP.
