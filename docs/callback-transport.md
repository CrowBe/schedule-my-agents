# MCP callback transport capability checkpoint

Issue #4 implements the subscription lifecycle against D1 on current main after PR #9. The public Site, authenticated owner, Google consent generation, opaque dispatcher and unique due-work ledger are retained. No calendar content or callback secret is added to the alarm dispatcher.

## Implemented boundary

`Subscriptions` validates the single required `calendarId`, event name, webhook mode, canonical signing-key encoding, callback URL syntax, replay cursor and finite requested lifetime. Identity hashes owner, canonical HTTPS destination, event name and the fixed-schema arguments. A maximum one-day lifetime is granted; omitted/null TTL receives one day. No missed-event replay is promised.

Secrets are AES-GCM encrypted with owner and subscription ID as associated data. Five-minute verification caching requires the same owner, destination, current grant and secret; replacement keys always receive a fresh challenge. Previous encrypted keys are retained with a five-minute rotation deadline for the later delivery slice. Its signer must include both keys only during that window. Expired rows are ineligible, although ciphertext is retained until refresh/revoke/unsubscribe; automatic idle retention cleanup remains future work.

Fresh verification requests use Standard Webhooks HMAC-SHA256 over the exact ID, timestamp and serialized body. The challenge has ten seconds to return in a 2xx response, with constant-time comparison and a 4 KiB response limit. Callback errors are `-32015` with categorized reasons. Persisted attempt revisions and consent/connection guards make unsubscribe, disable, disconnect and overlapping requests invalidate stale commits. Revocation removes subscription secrets before provider cleanup. The later outbox must call the authorization guard again before each send, including queued retries.

`events/list` remains empty. There is **no production callback adapter** and production subscribe fails with `transport_unavailable` without outbound traffic. The injectable transport is exercised only by tests. This is implementation groundwork, not completion of issue #4 or live ChatGPT readiness.

## Missing capability and evidence

[OpenAI MCP Events](https://developers.openai.com/plugins/build/mcp-events) requires resolving and validating addresses at connection time and connecting to the validated address while preserving the original hostname for TLS verification. This applies to challenge verification and event delivery. URL syntax checks, DNS checks before ordinary fetch, and a hostname allowlist do not prove this boundary.

Reviewed Sites v0.1.75 exposes normal Worker fetch and D1/R2 bindings, but no supported address-pinned HTTPS transport binding. The [Cloudflare socket API](https://developers.cloudflare.com/workers/runtime-apis/tcp-sockets/) documents a destination hostname and TLS mode without an independently configurable verification hostname. The installed Workers types likewise lack that option. This establishes a gap in the reviewed surface, not that every underlying Cloudflare capability is impossible. We have not run a live rebinding or TLS proof and do not claim a safe transport.

## Smallest fallback for approval

If no Site-native transport can be proved, add an authenticated, narrowly scoped HTTPS egress service that receives the already signed verification/delivery bytes from the Site. It resolves every attempt, rejects every non-public A/AAAA address, pins a validated address for the connection, preserves SNI and certificate verification against the original hostname, rejects redirects, enforces port 443, ten-second timeout and bounded request/response sizes. Mixed public/private DNS responses fail closed; retries resolve again. It returns only bounded response bytes and status. Deployment tests must prove rebinding resistance, IPv4/IPv6 special ranges, TLS hostname mismatch, redirects, timeout and streaming limits.

This service necessarily handles callback destinations and signed payloads; future delivery includes private calendar content. Expanding the existing opaque alarm Worker to handle them would change its approved data boundary. Approval must cover that data exposure and deployment before provisioning or wiring either a separate service or expanded dispatcher. Reuse this one transport for verification and later delivery; do not enable readiness through an environment flag around raw fetch.

## Evidence still required

The local Workers lifecycle test uses a test-only echo receiver and independently verifies the HMAC. SQLite tests cover persistence, expiry, rotation, ownership, challenge failure and consent/unsubscribe races. Neither proves DNS/connection policy or real ChatGPT callback acceptance. Issue #4 stays open until a verified production transport and live lifecycle test exist. Issue #5 then wires durable delivery; #6 proves an actual chat response.
