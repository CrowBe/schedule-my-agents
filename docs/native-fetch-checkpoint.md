# Native Site fetch: hosted checkpoint

Tested 2026-10-07T10:18:20.940Z (2026-10-07 21:18 AEDT).

Native fetch completed the seven fixed public fixtures below on the published Site. This confirms ordinary HTTPS reachability, failure of the two invalid TLS fixtures, manual redirect handling, abort cancellation and application response-size rejection for these requests. DNS rebinding and connection-time destination pinning remain untested. Issue #5 remains open and MCP_EVENTS_READY remains false.

## Evidence

- Diagnostic page: https://schedule-my-agents.bennycrow91.chatgpt.site/diagnostics/native-fetch
- API: authenticated GET /api/diagnostics/native-fetch; query parameters and other methods are rejected.
- Site: appgprj_6ac22de0956c8191a45d5b1bb86fd5e4
- Published version: 22 (appgprj_6ac22de0956c8191a45d5b1bb86fd5e4~appgver_e7523e9e85cc8191bfd32fa2b24711d4)
- Deployment: appgdep_6ac61c39a6348191b01092b74869db0b; succeeded, environment revision 10.
- Source: 13314b8b5adfea34af1888fc667618b9130ad36b; isolated branch native-fetch-diagnostic.
- Worker request: 33fa8032491b455ce3c38fb802af0101; API HTTP 200, Worker outcome ok.
- Worker message: calendar_native_fetch_diagnostics.
- Screenshot: /tmp/site-native-fetch-results.png (local, ephemeral).

| Fixture | Outcome | HTTP | Bytes observed | Elapsed ms |
| --- | --- | --- | --- | --- |
| public_https | response | 200 | — | 837 |
| tls_valid_control | response | 200 | — | 1144 |
| tls_wrong_hostname | response | 526 | — | 3956 |
| tls_untrusted_certificate | response | 526 | — | 696 |
| redirect_manual | response | 302 | — | 882 |
| timeout | timeout | — | — | 1000 |
| response_limit | response_limit | 200 | 7789 | 1789 |

The size fixture serves 8192 bytes. The diagnostic stops after the first chunk takes its running total over 4096 bytes, cancels the reader, and reports response_limit; it does not claim that the runtime itself enforces the application limit. Bytes observed vary with chunking.

Both invalid TLS fixtures returned HTTP 526 rather than a thrown fetch exception. Cloudflare documents 526 as inability to validate the origin certificate and documents strict TLS for external Workers subrequests. With a valid badssl.com control returning 200 in the same invocation, this is evidence of certificate and hostname validation for these fixtures. It is not a blanket assurance about DNS rebinding.

Primary sources: [Cloudflare error 526](https://developers.cloudflare.com/support/troubleshooting/http-status-codes/cloudflare-5xx-errors/error-526/), [badssl fixtures](https://github.com/chromium/badssl.com), [MCP Events callback requirements](https://developers.openai.com/plugins/build/mcp-events#verify-the-callback).

## Boundaries and next step

This diagnostic sends no credentials, calendar payloads or caller-selected URLs, follows no redirects, writes no calendar or subscription state, and cannot activate delivery. All destinations are fixed public HTTPS fixtures. The real OpenAI callback verification reachability checkpoint is separate; no signed due-event delivery was attempted here.

The next security experiment needs a controlled DNS/HTTPS fixture and server-side connection logs so that a DNS answer change between validation and connection can be observed safely. Test private-address rejection only with an explicitly scoped isolated fixture, not by probing shared Site internals or metadata services. Passing finite fixtures does not establish undocumented platform behavior for all destinations.

After resolving connection-time destination validation, native fetch can be wired into the signed outbox and verified with a real due callback acknowledgment, retries, revocation races and deduplication. Keep Issue #5 and delivery discovery gated until those acceptance checks pass.

## Local validation and deployment note

All 62 tests, typecheck, lint and the production build passed for the diagnostic API. After the final HTML page change, the two relevant diagnostic tests, typecheck, lint and production build passed again. The page is served directly by the Worker and uses the existing Site colors and typography.

An intermediate app-router diagnostic page returned HTTP 200 locally but version 21 failed to deploy with the generic message AppGen deployment failed (deployment appgdep_6ac61b240c3c819186c06556cc425a7a). The supported tools exposed no detailed cause. The simplified Worker page in version 22 deployed successfully; the cause of the intermediate failure remains unknown.
