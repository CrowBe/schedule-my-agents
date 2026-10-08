# Existing-infrastructure callback security investigation

Verified 9 October 2026 Sydney (8 October UTC). The existing Site and plugin work, including the previously verified signed Google event → ChatGPT delivery. Creating or using the owner's Site/plugin is authorized. This investigation addresses the remaining connection-time public-destination criterion in #4; it is not a deployment approval or paid-host requirement.

## Hosted observations

Diagnostic source: `50a74e75f854344bd981f1a72e2b05d27c391ea8`, Site version 34, environment revision 11, deployment `appgdep_6ac804e445808191afc975154afeeecb`, succeeded at `2026-10-08T21:02:43.611968Z`. The same Site origin and audience are retained. The existing opaque timer Worker was updated to version `3b0a7d87-2380-4caa-bd01-2a9ed5309479`. No host, account, plan, DNS zone, tunnel, audience or calendar consent was added.

| Experiment | Actual result | Conclusion and limit |
| --- | --- | --- |
| Native public HTTPS/HTTP hostname controls | Both HTTP 204 | Managed hostname egress works. |
| Eighteen additional non-public literal fixtures | Every request returned HTTP 403 | Rejection observed across unspecified, private, CGNAT, protocol-reserved, documentation, benchmarking, multicast, reserved, IPv6 link-local and transition examples. Literals alone do not establish DNS-change policy. |
| Wrong-host and expired-certificate hostname fixtures | Both HTTP 526 | Managed HTTPS rejected the invalid TLS fixtures. |
| Freshly validated public HTTPS literal, with original Host, no Host and wrong Host | All HTTP 403 while the hostname control returned 204 | Literal-IP plus Host is not a usable transport here. Forbidden/documentation literal plus original Host also returned 403. |
| Node TLS with selected-address lookup and custom identity hook | Throws at `tls_connect`, before lookup; sanitized unsupported-option category | Workers rejects `checkServerIdentity` hooks. This alone does not rule out Node TLS. |
| Node TLS with selected-address lookup, original servername and default library verification | Public positive, wrong-identity negative and actual callback each invoked lookup once, then failed before secure connection | Supported form tested; no usable callback connection. Zero HTTP/application bytes sent; no TLS validation disabled. Generic failure does not prove a particular policy rejection. |
| Changing DNS fixture | Public-only control HTTP 204. Unique `1u.ms` hostname observed `52.21.224.34` before and `127.0.0.1` after; intervening native HEAD returned 403 | Real public → loopback answer change and rejection observed. Corroborates rebinding protection for this experiment without observing the actual dial address or all retries/ranges. |
| Existing timer Worker literal TCP | Eight freshly validated public control addresses opened; all four callback IPv4/IPv6 addresses failed | A raw-socket/WebSocket bridge on this Worker cannot establish the real callback path. Separate from Site runtime behavior. |

The successful DNS-change audit is `calendar_native_rebinding_diagnostics` at `2026-10-08T20:55:34.831Z`, tested on version 33. Version 34 retains that DNS experiment. Earlier version 32 recorded two public answers and was inconclusive. The corrected diagnostic uses Google's documented DNS-neutral `random_padding` parameter, `cache: no-store` and `Cache-Control: no-cache` to avoid replaying the first HTTP response; client-subnet disclosure is disabled. [Google DoH API](https://developers.google.com/speed/public-dns/docs/doh/json) and [fixture behavior](https://github.com/neex/1u.ms) document these inputs. Final Node/literal checks were logged at `2026-10-08T21:03:06.444Z` on version 34.

The second `rebind.network` fixture returned no usable initial answer and was marked unavailable, not passed. A separate `rbndr.us` preflight returned SERVFAIL. These are fixture availability limits. No user/calendar identifiers were sent to these services.

## Diagnostic boundaries and verification

- Site APIs require authenticated, same-origin, empty POST; callers cannot supply destinations, headers, ports or bodies. The timer endpoint also verifies the existing path-bound HMAC registration signature.
- Native target probes use empty HEAD, manual redirects, omitted credentials and five-second deadlines. Contents are discarded; fixture DNS JSON reads are bounded to 4 KiB. Probe adapters and late/stalled responses are bounded and their returned streams cancelled.
- TLS probes send zero application bytes. The timer sends zero TCP application bytes and closes sockets; DNS and dial work share six seconds. The Site's fixed signed timer request and 16 KiB result read share ten seconds. The timer receives no event plaintext, identity, OAuth credentials or Site decryption keys.
- All 84 tests pass, including authentication/body rejection, unsafe mixed DNS answers, DNS changes versus unavailable/contaminated fixtures, late response cancellation, existing alarm/Workers/D1 restart recovery, and the Site's empty signed timer request. Typecheck, lint, production Site build, dispatcher typecheck/build and live publication passed.

## Alternatives within the current supported interfaces

[Primary-source runtime research](callback-guarantee-runtime-research.md) records application/operator distinctions. The custom-hook restriction is explicit in [upstream TLS source](https://github.com/cloudflare/workerd/blob/cb61e82b35bf4cac7fc69821743337b8ca498bd5/src/node/internal/internal_tls_wrap.ts#L700-L715); default verification was subsequently tested rather than discarded by assumption.

The existing Worker has working raw TCP but callback addresses fail. WebSocket framing or another TLS library cannot repair that failed dial. Node HTTPS Agents/Undici over the same fetch/socket primitives do not add an independent route. `cf.resolveOverride` needs an eligible same-zone target; the current Cloudflare identity has zero DNS zones. Fixed ExternalServer/certificate-host and network-CIDR filtering exist as workerd operator controls, but are not exposed as supported Sites application configuration. VPC/tunnel bindings require additional provisioned resources. A plaintext native-fetch relay would change the opaque timer's privacy boundary while inheriting an unresolved managed-fetch policy; it is not an equivalent solution.

Native platform filtering remains the leading existing-infrastructure solution. The application need not choose the earlier DNS IP if the platform validates every actual selected address immediately before every dial/retry, retains hostname TLS and enforces the full deny policy. Publication of a compatibility flag, finite negative tests, requested-IP strings, `socket.authorized` or input-derived `remoteAddress` does not independently establish that contract.

No supported, successfully tested application alternative established the complete hosted guarantee. This does not prove paid infrastructure is necessary or every conceivable platform implementation is impossible. The unresolved dependency is authoritative hosted policy evidence or an exposed enforceable dial/network binding, including retry/fallback behavior and all required non-public ranges. #4 remains open for this criterion; #1 and #6 depend on it. The working restricted OpenAI callback transport and existing plugin remain available; these probes do not change readiness or subscriptions.
