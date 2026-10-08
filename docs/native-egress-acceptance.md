# Sites-native callback security acceptance

8 October 2026. The owner requested implementation and testing of a Sites-native alternative to the prepared relay. No new host or paid plan is used. The relay code and deployment mode have been removed from this change; the existing opaque timer remains separate.

Native callback requests still require exactly `https://connectors.api.openai.com`, default port 443, original-hostname TLS, fresh public DNS preflight, manual redirects, no URL credentials or fragments, and a bounded signed request/challenge response. Only the five protocol headers are permitted, with an 8 KiB header budget. One deadline now bounds DNS, fetch and response reads even when an adapter stalls. Both verification and delivery use this transport.

The build requests Cloudflare's [public-front-door routing flag](https://developers.cloudflare.com/workers/configuration/compatibility-flags/#global-fetch-strictly-public). Successful publication does not independently attest that Sites forwards this build flag or implements the full non-public address policy. Runtime-managed validated-address dialing could satisfy the [MCP contract](https://developers.openai.com/plugins/build/mcp-events#verify-the-callback); application-selected IPs are not necessary when the platform itself enforces that policy. See [primary-source research](callback-security-alternatives-research.md).

## Test design

The fixed authenticated endpoint requires same-origin POST with no query or request body. It sends ten empty HEAD requests: a public HTTPS control, IPv4 loopback/private/link-local/documentation literals, IPv6 loopback/private/mapped literals, a static hostname resolving to loopback, and a public redirect pointing to loopback. No response contents, credentials or calendar data enter the report. URLs and headers cannot be supplied by visitors.

Explicit destination/network prohibition errors are recorded separately from generic network failures and timeouts. A response status alone does not identify whether the platform synthesized the response. Static private-DNS fixtures do not change DNS between validation and connection, so `dnsRebindingTested` and `callbackContractVerified` remain false. The diagnostic cannot change readiness or subscriptions.

## Evidence

Pending hosted execution. Keep issue #4's stricter connection-time/rebinding acceptance open until equivalent platform enforcement is established. Record deployment/source, observed results, real callback receipt and remaining uncertainty here after testing.
