# Issue #5 live acceptance — 7 October 2026

Functional delivery acceptance is verified on the owner's real Site/plugin using the explicitly authorized OpenAI-only native-fetch mode. Code review remains pending. The broader connection-time IP-pinning guarantee is unverified and is not claimed by this experiment.

## Configuration and scope

Site version 23 published source `6cfafaae5149c03963768d8a8985efe1408a0ce8` with environment revision 11: `MCP_CALLBACK_TRANSPORT=native-openai`, `MCP_EVENTS_READY=true`, and no `MCP_CALLBACK_PROBE`. The existing Site, plugin, public audience, Google connection, explicit Personal calendar consent, D1 and opaque durable dispatcher were reused. No new infrastructure or bypass credential was introduced.

The owner explicitly asked to proceed to real MCP Events on their own Site/plugin instead of blocking that test on a platform DNS guarantee. Native HTTPS supports only the exact observed host `connectors.api.openai.com`, with public DNS preflight, native hostname TLS, manual redirects, signatures and request/response/time bounds. Both verification and delivery use the same transport. The general validated-IP Go TLS transport remains the default when this opt-in is absent.

## Real acceptance timeline

All times are UTC on 7 October 2026. The disposable event had no guests, description or reminders.

| Stage | Observed evidence |
| --- | --- |
| Plugin discovery | Refreshed existing plugin tools after the first discovery returned a cached empty catalog |
| Signed verification and persistence | 10:49:38.446: `events/subscribe` accepted; request `edb1edd7add06eb0fd1a4452ba368da3`; one verified finite subscription in D1; ChatGPT saved one enabled monitoring task |
| Google occurrence sync | The synthetic event was saved for 21:54–21:59 Sydney (+11:00). Manual Resync first seeded it at 10:51:57.604; Google's delayed push then synchronized and registered the identical alarm at 10:52:23.088 |
| Provider audit linkage | Google `exists` notification message `191190561`, channel tag `3kn4YD7LVnZQ`; request `100c895cea4d4b460076c4ffcc2dc668`; occurrence tag `ZJW5YUsD0Eo-`, alarm/outbox tag `PbvzW4NYZwu0`, due `10:54:00` |
| Durable wake and provider revalidation | 10:54:04.273: `due_work`, 4,273 ms lateness; request `7e279742e2836e83a0fbc1572d434266` |
| Signed callback acknowledgement | 10:54:06.776: `calendar_delivery`, same event tag, subscription tag `tPm_619sTbhI`, attempt 1, HTTP 200, outcome `accepted` |
| Persisted acknowledgement | D1 contained one accepted delivery, `attempts=1`, `last_status=200`, serialized body cleared; the linked receipt contained the synthetic occurrence |
| Actual ChatGPT response | The existing [Load Calendar Tools chat](https://chatgpt.com/c/6ac5c069-cdb0-83ec-9629-8d07ce6db39b) reported the test title and 7 October at 9:54 pm Sydney time, with no calendar writes or other external actions |
| Cleanup | ChatGPT task paused and preserved as a test record; D1 subscriptions and deliveries both empty after unsubscribe; synthetic Google event deleted through recoverable Calendar trash |

The original and Google-push registrations used the same alarm identity; one delivery was recorded. This is live evidence of idempotent registration and successful real callback acceptance, not proof of exactly-once agent execution.

## Automated acceptance

All 65 tests pass, including actual Workers/D1/Durable Object integration and an independent Standard Webhooks receiver. Typecheck, lint and production build pass. Coverage includes exact-body signatures and required headers; distinct protocol/provider IDs; UTF-8 256 KiB payload rejection; immutable body/ID retries with fresh signing; concurrency and leases; transient failure/retry and runtime restart; crash/lost-ack exhaustion; 3xx/410/413 terminal handling; consent, owner, generation, subscription expiry and occurrence revision checks; and queued edit/cancel/disable/disconnect/unsubscribe races. Native adapter tests reject arbitrary hosts, URL tricks, non-public DNS answers and oversized bodies, retain manual redirects, cancel oversized responses and propagate timeouts.

## Remaining transport limitation

[MCP Events callback verification](https://developers.openai.com/plugins/build/mcp-events#verify-the-callback) describes connection-time public-address validation and connection to the validated IP with original-hostname TLS verification. Native fetch does not expose app-controlled pinning, and these tests do not prove a Sites platform DNS-rebinding guarantee. This known limitation remains distinct from the now-observed functional delivery and ChatGPT response. General arbitrary-host native callbacks are deliberately unsupported. [Prior transport diagnostics](native-fetch-checkpoint.md) and [raw-socket failure evidence](sites-callback-support-repro.md) remain available.

Delivery uses bounded at-least-once attempts. A crash after remote acceptance but before local acknowledgement can repeat the same logical event; an accepted event cannot be recalled. Automatic Google watch renewal and missed-push convergence are separate remaining work.
