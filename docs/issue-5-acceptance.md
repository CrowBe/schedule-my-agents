# Issue #5 acceptance checkpoint — 7 October 2026

Status: owner-authorized native-fetch live acceptance test in progress, not complete.

The owner explicitly authorized proceeding to real MCP Events on their own Site/plugin rather than blocking that experiment on a platform DNS guarantee. `MCP_CALLBACK_TRANSPORT=native-openai` opts into native HTTPS only for `connectors.api.openai.com`. Both challenge and delivery use this transport, retain public DNS preflight, hostname TLS, manual redirects, signing, resource bounds and current owner/calendar authority. Native fetch's connection-time public-IP validation remains unverified; successful delivery will establish functional acceptance, not that broader guarantee. The general pinned transport remains the default.

The following 10:28 UTC evidence is the checkpoint before that instruction; live test results will be recorded below.

Reviewed the complete [Issue #5](https://github.com/CrowBe/schedule-my-agents/issues/5), current implementation, tests and live Site at 10:28 UTC. No runtime code, catalog readiness, audience, calendar data or infrastructure was changed during this continuation. The original issue-5 checkout remains separate from this diagnostic branch.

## Acceptance evidence

| Issue requirement | Available evidence | Remaining acceptance |
| --- | --- | --- |
| Real synced occurrence reaches signed callback and records acknowledgement | Durable due-work and signed delivery implemented; fake-provider Workers/D1 + real Durable Object alarm integration passes | No real hosted subscribed callback receipt |
| Exact-body independent signatures, headers, identity and payload bound | Independent receiver tests, UTF-8 256 KiB rejection, rotation and logical/provider ID separation pass | Real subscriber acceptance requires the callback connection boundary |
| One logical event under concurrency and retries with fresh signing | Persisted immutable bodies/IDs, unique audience rows, leases and bounded backoff tested | Hosted complete-path receipt is outstanding |
| Crash recovery, pending/accepted/exhausted/terminal handling | SQLite/runtime restart, lost acknowledgement, terminal 3xx/410/413 and bounded attempts covered | No claim of exactly-once agent execution |
| Current authority and occurrence revision checked on each attempt | Edit/cancel/disable/disconnect/unsubscribe/expiry and queued Workers race tests pass | Existing network-effect race remains documented |
| Redacted audit linkage | Provider notification, occurrence and delivery audits implemented with opaque tags | Real hosted provider-to-delivery audit chain is outstanding |
| Production catalog activated only when complete path is ready | Gate stays false; actual-runtime integration covers fake-provider delivery, retry, restart and revocation | Catalog intentionally not activated; safe transport and real acceptance outstanding |

Validation in this conversation: all 62 tests passed, including Workers/D1/Durable Object coverage; typecheck, lint and production build passed. The final diagnostic-page change also passed its two relevant tests and all build checks. No additional runtime changes were made in this continuation, so those checks were not repeated for documentation edits.

## Live state

- Site: `appgprj_6ac22de0956c8191a45d5b1bb86fd5e4`; published version 22.
- URL: https://schedule-my-agents.bennycrow91.chatgpt.site
- Environment revision 10: `MCP_EVENTS_READY=false`; `MCP_CALLBACK_PROBE` absent.
- D1 read-only inspection: `subscriptions`, `subscription_attempts`, `deliveries` and `occurrence_outbox` each empty, with no further pages.
- Site automations: zero.
- Native fetch: valid HTTPS 200; invalid hostname/self-signed TLS 526; manual redirect 302; abort at 1000 ms; oversized body rejected by application limit. [Exact hosted evidence](native-fetch-checkpoint.md).
- Real callback verification-only probe previously returned 200 and the exact challenge; it deliberately prevented subscription activation. [Probe record](sites-callback-support-repro.md).

## Why the transport is still blocked

[MCP Events callback verification](https://developers.openai.com/plugins/build/mcp-events#verify-the-callback) requires public-address validation at connection time and connection to the validated address with the original hostname retained for TLS. The requirement applies to challenge verification and delivery.

Raw sockets are denied for the real callback. Native fetch reaches it and the certificate fixtures fail as expected, but the public fixtures do not test changing DNS answers or prove public-IP checks at connection time. The application cannot install a custom pinned-IP connection through ordinary Worker fetch.

A new primary-source lead is worth retaining: Cloudflare's [MCP gatekeeper configuration](https://github.com/cloudflare/cloudflare-os/blob/main/packages/gatekeeper-mcp/cloudflare.config.ts) claims `global_fetch_strictly_public` rejects reserved address ranges after DNS resolution in production. Its [README](https://github.com/cloudflare/cloudflare-os/blob/main/packages/gatekeeper-mcp/README.md) makes the same claim. However, the [runtime flag documentation](https://developers.cloudflare.com/workers/configuration/compatibility-flags/#global-fetch-strictly-public) describes public-front-door routing for the Worker's own zone; [workerd source](https://github.com/cloudflare/workerd/blob/main/src/workerd/io/compatibility-date.capnp) explicitly separates Cloudflare production routing from the standalone workerd public-only default. This discrepancy does not establish which lower-level public-address checks Sites enforces. The Site build currently declares only `nodejs_compat`. No unverified flag-based security claim or transport fallback was introduced.

## What permits further progress

The next empirical test needs an owner-controlled DNS/HTTPS fixture, a valid certificate, deliberate answer changes and receiver/DNS connection logs. The current project has no such fixture or DNS control available. A fixed private-address failure alone could instead be a certificate or routing failure, so it would not establish rebinding protection. Do not probe shared Site internals or cloud metadata to manufacture this evidence.

An authoritative Sites transport guarantee for connection-time public-address validation, or an available supported pinned-HTTPS capability, can resolve the capability question directly. A scoped controlled fixture permits the missing experiment; its results still need to be assessed against the required boundary. An external safe egress component remains a separate architecture decision requiring explicit authorization under the existing project constraints.

After the transport boundary is resolved: wire the same approved transport into verification and delivery, complete a real Work Cloud subscription, schedule a disposable Google event, observe due delivery and persist the subscriber acknowledgement, verify recovery and audit linkage, then activate the production catalog and close #5 only after all acceptance evidence is present. An actual ChatGPT response belongs to the later demonstration check as well.
