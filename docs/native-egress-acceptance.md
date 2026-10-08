# Sites-native callback security acceptance

8 October 2026. The owner requested implementation and testing of a Sites-native alternative to the prepared relay. No new host or paid plan is used. The relay code and deployment mode have been removed from this change; the existing opaque timer remains separate.

Native callback requests still require exactly `https://connectors.api.openai.com`, default port 443, original-hostname TLS, fresh public DNS preflight, manual redirects, no URL credentials or fragments, and a bounded signed request/challenge response. Only the five protocol headers are permitted, with an 8 KiB header budget. One deadline now bounds DNS, fetch and response reads even when an adapter stalls. Both verification and delivery use this transport.

The build requests Cloudflare's [public-front-door routing flag](https://developers.cloudflare.com/workers/configuration/compatibility-flags/#global-fetch-strictly-public). Successful publication does not independently attest that Sites forwards this build flag or implements the full non-public address policy. Runtime-managed validated-address dialing could satisfy the [MCP contract](https://developers.openai.com/plugins/build/mcp-events#verify-the-callback); application-selected IPs are not necessary when the platform itself enforces that policy. See [primary-source research](callback-security-alternatives-research.md).

## Test design

The fixed authenticated endpoint requires same-origin POST with no query or request body. It sends ten empty HEAD requests: a public HTTPS control, IPv4 loopback/private/link-local/documentation literals, IPv6 loopback/private/mapped literals, a static hostname resolving to loopback, and a public redirect pointing to loopback. No response contents, credentials or calendar data enter the report. URLs and headers cannot be supplied by visitors.

Explicit destination/network prohibition errors are recorded separately from generic network failures and timeouts. A response status alone does not identify whether the platform synthesized the response. Static private-DNS fixtures do not change DNS between validation and connection, so `dnsRebindingTested` and `callbackContractVerified` remain false. The diagnostic cannot change readiness or subscriptions.

## Evidence

Site version **29**, source `f2b23cb89e6b0862d69f50b81d28f18ef1efc856`, deployed successfully at **09:10:17.844 UTC** on 8 October, environment revision 11. Deployment `appgdep_6ac75deb11d481919255e8e2b080c577` retained the existing audience, plugin and native callback configuration. The generated Worker configuration includes the requested public-front-door compatibility flag; publication is not a runtime policy attestation.

The authenticated browser completed the fixed probe set at **09:11:10.807 UTC**, request `ac97ec440f4b2a194bbafdcd0860792b`:

| Fixture | Observed HTTP status | Time |
| --- | --- | --- |
| Public HTTPS control | 200 | 5 ms |
| IPv4 loopback, private, link-local and documentation literals | 403 each | 1 ms each |
| IPv6 loopback | 403 | 1 ms |
| IPv6 private and mapped loopback | 403 each | 2 ms each |
| Static DNS hostname resolving to loopback | 403 | 1,111 ms |
| Public redirect to loopback | 302, not followed | 846 ms |

All response contents were discarded. The report correctly records the 403s as HTTP responses rather than explicit runtime policy errors. Their fast, consistent rejection is evidence of native destination filtering, but the test does not identify the actual socket address, change DNS between validation and connection, or attest the full non-public range/fallback policy. `dnsRebindingTested` and `callbackContractVerified` remain false.

The preserved **Load Calendar Tools** test task was resumed exactly once with acknowledgement-only instructions. One fresh signed challenge verified a subscription. A disposable real Google event starting at **09:16 UTC / 20:16 Sydney** produced one accepted delivery at **09:16:01.852 UTC**, event tag `sX2eAIWhbN3W`, subscription tag `UA_GGKBU9qAB`, HTTP 200, attempt 1. Live D1 confirmed `status=accepted`, `attempts=1`, `last_status=200`, with the body cleared and lease released. The original chat then acknowledged the synthetic title and 20:16 start before the separate cleanup message. This is actual Google-to-ChatGPT delivery evidence, not a fake callback receiver.

The synthetic event was removed and the chat verified its saved task was paused. A subsequent D1 read still found its subscription: the task service rejected removal of its event trigger, so pausing alone did not establish unsubscribe in this run. An authenticated, same-origin owner control now revokes a selected calendar's subscriptions, queued deliveries and pending verification attempts atomically without removing its calendar grant or watch. Automated Workers/D1 coverage verifies owner isolation, origin/authentication enforcement, idempotence and retained grants. Hosted cleanup with that control is recorded below after publication.

All **76 tests**, typecheck, lint and production build pass. Callback regressions cover stalled DNS/fetch/challenge reads and credential-bearing, injected or oversized headers. Keep issue #4's stricter connection-time/rebinding acceptance open until equivalent hosted platform enforcement is established; issues #1 and #6 retain that dependency. No paid relay is needed for the demonstrated functional path.
