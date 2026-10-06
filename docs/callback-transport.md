# MCP callback transport capability checkpoint

Issue #4 implements the subscription lifecycle against D1 on current main after PR #9. The public Site, authenticated owner, Google consent generation, opaque dispatcher and unique due-work ledger are retained. No calendar content or callback secret is added to the alarm dispatcher.

## Implemented boundary

`Subscriptions` validates the single required `calendarId`, event name, webhook mode, canonical signing-key encoding, callback URL syntax, replay cursor and finite requested lifetime. Identity hashes owner, canonical HTTPS destination, event name and the fixed-schema arguments. A maximum one-day lifetime is granted; omitted/null TTL receives one day. No missed-event replay is promised.

Secrets are AES-GCM encrypted with owner and subscription ID as associated data. Five-minute verification caching requires the same owner, destination, current grant and secret; replacement keys always receive a fresh challenge. Previous encrypted keys are retained with a five-minute rotation deadline for the later delivery slice. Its signer must include both keys only during that window. Expired rows are ineligible, although ciphertext is retained until refresh/revoke/unsubscribe; automatic idle retention cleanup remains future work.

Fresh verification requests use Standard Webhooks HMAC-SHA256 over the exact ID, timestamp and serialized body. The challenge has ten seconds to return in a 2xx response, with constant-time comparison and a 4 KiB response limit. Callback errors are `-32015` with categorized reasons. Persisted attempt revisions and consent/connection guards make unsubscribe, disable, disconnect and overlapping requests invalidate stale commits. Revocation removes subscription secrets before provider cleanup. The later outbox must call the authorization guard again before each send, including queued retries.

`events/list` remains empty. The Site Worker now wires a direct Go-standard-library TLS adapter. It resolves A/AAAA on every attempt, rejects mixed or non-public answers and connects to the chosen literal IP using raw TCP. Go WASM verifies the certificate chain, hostname and validity before sending data. See [TLS implementation and upkeep](../tls-client/README.md). Discovery remains closed until delivery is wired. The production Site completed the fixed synthetic TLS diagnostic with HTTP 200; see VERIFICATION.md. Real ChatGPT callback acceptance remains outstanding.

## Missing capability and evidence

[OpenAI MCP Events](https://developers.openai.com/plugins/build/mcp-events) requires resolving and validating addresses at connection time and connecting to the validated address while preserving the original hostname for TLS verification. This applies to challenge verification and event delivery. URL syntax checks, DNS checks before ordinary fetch, and a hostname allowlist do not prove this boundary.

Reviewed Sites v0.1.75 exposes normal Worker fetch and D1/R2 bindings, but no supported address-pinned HTTPS transport binding. A deeper check on 5 October 2026 corrected the initial assessment: the installed Workers types **do** expose `Socket.startTls({ expectedServerHostname })` through `TlsOptions`. Type availability does not establish production support.

The reviewed native paths are:

| Path | Evidence | Result |
| --- | --- | --- |
| Ordinary Worker fetch | No caller-controlled resolved-address connection with separate TLS hostname | DNS checking before fetch leaves the rebinding gap |
| Node HTTP/HTTPS adapter | [Cloudflare HTTP docs](https://developers.cloudflare.com/workers/runtime-apis/nodejs/http/) say `lookup` and `createConnection` are unsupported; requests wrap fetch | Cannot install a pinned-address agent through these adapters |
| `cf.resolveOverride` | [Cloudflare Request docs](https://developers.cloudflare.com/workers/runtime-apis/request/) limit it to URL and override hosts within the Worker's zone | Cannot pin arbitrary ChatGPT callback hosts outside the Site's zone |
| TCP plus `startTls` | [Current workerd source](https://github.com/cloudflare/workerd/blob/main/src/workerd/api/sockets.c%2B%2B) explicitly calls `expectedServerHostname` unsupported and can reject it through an autogate. [Open issue #6903](https://github.com/cloudflare/workerd/issues/6903) reports successful local tests but missing SNI and failed TLS on the production edge | A local success would not prove a safe hosted transport |

The source was read directly on 5 October 2026. No live Site socket test was performed, so the deployed Site's exact behavior remains unmeasured. These are concrete limitations of the reviewed supported APIs, not a claim that every possible user-space TLS implementation is impossible. The new adapter uses Go standard TLS compiled to WASM rather than these native TLS paths; certificate checks remain enabled.

## Deployment decision

The user clarified that callback egress should remain within the existing Site deployment infrastructure and asked to avoid new infrastructure. No separate egress service is authorized or provisioned. The earlier fallback proposal is withdrawn from the implementation plan.

The native-TLS assessment below is historical: a custom WASM implementation now provides the missing TLS behavior directly inside the Site. No external service was added. The investigated native API would have needed a supported runtime capability that atomically validates the destination and connects to its approved public address while retaining callback-hostname TLS verification, or a documented Sites-managed safe egress binding with that guarantee. Reuse that one transport for verification and later delivery. Do not replace the boundary with an environment flag around raw fetch. The subscription implementation remains useful groundwork while this platform prerequisite is unresolved.

## Evidence still required

The local Workers lifecycle test uses a test-only echo receiver and independently verifies the HMAC. SQLite tests cover persistence, expiry, rotation, ownership, challenge failure and consent/unsubscribe races. The direct adapter additionally passes real TLS hostname/untrusted-root/corruption/expiry/redirect/oversized/stall checks, actual Workers WASM execution, IP policy tests and a public-network synthetic HTTPS POST. A hosted Site synthetic transport check subsequently completed HTTP 200. This does not prove real ChatGPT callback acceptance. Issue #4 stays open until a verified production transport and live lifecycle test exist. Issue #5 then wires durable delivery; #6 proves an actual chat response.
