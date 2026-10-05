# Google ingress: issue #2

## Public-hosting resolution

On 5 October 2026 the user explicitly authorized public Site hosting while retaining ChatGPT sign-in, Google authorization and owner-scoped calendar grants. The audience changed from owner-private to public. Logged-out forged webhook requests now reach application validation (403); anonymous and forged-identity setup/MCP requests remain 401. No relay or new bypass credential is needed. Existing Google credentials and consent are preserved. Real watch/provider evidence is recorded in [VERIFICATION.md](../VERIFICATION.md).

The private-audience constraint below is historical and superseded by that authorization. The conditional relay contract is retained only as context if private hosting is required again.

## Historical private-hosting result

Direct Google ingress was blocked. On 5 October 2026 at 11:43 Australia/Sydney, a logged-out POST to the exact `/api/google/webhook` route returned 401/HTML before application validation. The Site remains owner-private. No runtime gate was enabled and no live watch was created.

The reviewed Sites v0.1.75 tools, authentication guidance and allowed manifest fields expose audience controls and service access, but no route-specific private-auth exemption. This is a finding about the available supported surface, not a claim about all possible future platform capabilities. Application routing cannot override a gate that runs before the Worker.

[Google's push API](https://developers.google.com/workspace/calendar/api/guides/push) supplies `X-Goog-*` channel headers; watch creation has no field for an arbitrary authorization header. Its channel token returns as `X-Goog-Channel-Token`, not Sites' service-access header. Putting a credential in a URL is not an approved substitute.

## Hosted evidence

Site: `appgprj_6ac22de0956c8191a45d5b1bb86fd5e4`, live version 3. The existing service credential returned by Sites was used only for these probes; none was created or rotated. No owner identity header, session cookie or event contents were included.

| Request | Status / content | Request ID |
| --- | --- | --- |
| Logged-out forged webhook POST | 401 / HTML | `a458646d4a050119-SYD` |
| Logged-out status GET | 401 / HTML | `a458646da9ee0b94-SYD` |
| Logged-out MCP POST | 401 / plain text | `a458646ddb120119-SYD` |
| Service-access forged webhook POST | 403 / application JSON, unauthorized channel | `a458646eac900b94-SYD` |
| Service-access status GET without owner | 401 / application JSON | `a458647f3f710119-SYD` |
| Service-access MCP POST without owner | 401 / plain text | `a458648d49fc0b94-SYD` |

The service-access check proves a forwarding path reaches webhook validation and does not manufacture an owner for setup APIs. MCP remains denied at its protection boundary. It does not prove anonymous provider ingress.

Live browser verification separately showed Google connected, Personal enabled, the other three discovered calendars disabled, and Start watch disabled. D1 readback showed one enabled grant, zero watches and zero event rows. No credentials, calendar IDs or event contents are recorded here.

Reproduce the anonymous checks with `npm run verify:ingress -- https://schedule-my-agents.bennycrow91.chatgpt.site`. Exit 1 means direct ingress is unproved; it is the expected current result. An existing service credential may be supplied through hidden stdin with `--service-token-stdin`; this never opens the runtime gate.

## Minimal conditional alternative

One public HTTPS ingress relay would forward notifications into this same private Site through the verified service-access path. The Site would retain OAuth, calendar authority, provider fetches, canonical data and MCP. No relay or external infrastructure is provisioned in this PR.

The proposed forwarding contract is:

1. A fixed relay endpoint accepts only bounded Google notification POSTs. It has no generic proxy, user impersonation, calendar read API or audience-changing capability.
2. During future watch provisioning, the Site registers the channel's token hash and expiry with an authenticated relay management operation before calling Google. The response binds the provider resource ID. Failed watch creation removes relay registration; disable/disconnect invalidates the Site grant first, then cleans up relay and provider state. Pending initial sync is forwarded for the Site's existing race handling.
3. The relay validates channel ID, token hash, expiry, allowed resource-state values and bounded message-number syntax. Known resource IDs must match. The Site repeats all validation against the current grant and consent generation; relay validation alone grants no calendar authority.
4. Forward only the allowlisted `X-Goog-Channel-Id`, `X-Goog-Channel-Token`, `X-Goog-Resource-Id`, `X-Goog-Resource-State` and `X-Goog-Message-Number` headers to the fixed Site `/api/google/webhook` destination. Strip cookies, owner headers, inbound authorization and arbitrary forwarding headers. Add the existing service credential server-side as `OAI-Sites-Authorization: Bearer …`. Follow no redirects.
5. Keep the Sites credential in relay secret storage and never in Google watch metadata, URLs or logs. Its dispatch scope is broader than this route, so the fixed destination and minimal relay code are essential. Rotation must preserve queued deliveries, and requires explicit authorization when creating or rotating the credential.
6. Acknowledge only after Site validation/sync succeeds, or after durable acceptance of bounded, expiring delivery metadata. A future durable queue requires authenticated encryption for the channel token, fixed retry limits and no event contents. Surface terminal failure; use the owner-authorized Resync now action for this demo's explicit recovery. Google retries cannot be assumed to deliver the final state.

Implementing and deploying this alternative needs authorization for that external component, verified channel provisioning/cleanup and a real provider test. Retain the private audience. Until then, keep `GOOGLE_WEBHOOK_VERIFIED` unset.

## Acceptance still outstanding

At the original private-hosting checkpoint, real Google initial and create/edit/cancel delivery, production watch persistence and live snapshot changes were unverified. Use the current VERIFICATION.md checkpoint for acceptance status. The local Workers E2E uses a fake provider. Issue #2 must remain open until these live criteria pass or its acceptance is explicitly revised.
