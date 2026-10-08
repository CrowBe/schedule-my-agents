# Callback security without an additional relay

Research checked 8 October 2026. Read-only investigation; no deployment, billing, secrets or account changes.

The best no-new-infrastructure candidate is a **public-only outbound network policy enforced by Sites' own fetch transport**. That can prevent the same private-network access as application IP pinning: the transport resolves the destination, filters the actual addresses, and connects only to an allowed address. Cloudflare/workerd has this design, but the sources below do not establish that the Sites production deployment exposes or guarantees it. Exact OpenAI-host allowlisting is already useful protection; it is a different guarantee.

## Three distinct outcomes

| Option | Security result | Works with the current Site? | Evidence still needed |
| --- | --- | --- | --- |
| Platform public-only egress after DNS resolution | Equivalent protection against connections to private/local/non-public addresses, including a changed DNS answer | Plausible native option; hosted Sites policy unconfirmed | Sites contract or platform confirmation of policy, range coverage, all retries/fallbacks and absence of private-origin bypass |
| Exact `https://connectors.api.openai.com` origin, normal hostname TLS, no redirects | Strong compensating control: subscribers cannot choose their own hostname/DNS authority, and application data requires the expected TLS identity | Already implemented in [native transport](../lib/calendar/native-callback-transport.ts) | Does not prove that no TCP/TLS connection can be attempted to a private address |
| Public DNS preflight, challenge/signatures, consent and request limits | Rejects known bad answers, authenticates webhook lifecycle and limits abuse | Already implemented | Does not bind a later DNS answer or socket to the preflight result |

OpenAI's current [MCP Events guidance](https://developers.openai.com/plugins/build/mcp-events#verify-the-callback) requires connection-time destination validation, use of the validated address, original-hostname TLS, no non-public destinations and no redirects for both verification and delivery. It does not document an exemption for a fixed OpenAI hostname, nor require application-selected IPs: the runtime may perform the resolve/validate/connect sequence itself. Only allowlisting the URL is not evidence that all requirements hold.

## What the platform sources actually establish

**workerd contains the desired network enforcement mechanism.** Its [configuration schema](https://github.com/cloudflare/workerd/blob/main/src/workerd/server/workerd.capnp) gives `Network.allow` the default `["public"]`, filters DNS lookup results through its allow/deny rules, and backs global fetch with a configurable `globalOutbound` service. Operators can replace that service or permit private networks. The [compatibility source](https://github.com/cloudflare/workerd/blob/main/src/workerd/io/compatibility-date.capnp) separately describes private-address rejection in default workerd, and explicitly says the Cloudflare compatibility flag has no effect in self-hosted workerd. This is runtime capability evidence, not the managed Sites configuration.

Cloudflare's first-party [binding security explanation](https://blog.cloudflare.com/workers-environment-live-object-bindings/) says this applies to Workers without an origin server behind them, or whose origin does not depend on Cloudflare for security:

> "global `fetch()` is SSRF-safe today."

The same article explains the historical exception: same-zone global fetch can bypass the public front door to reach an origin. Its [workerd introduction](https://blog.cloudflare.com/workerd-open-source-workers-runtime/) also describes public-only global fetch and an operator-configurable outbound binding. These are good reasons to investigate native platform enforcement before provisioning another component.

### Actual connection filtering and range coverage

The upstream [KJ Unix dial implementation](https://github.com/capnproto/capnproto/blob/master/c%2B%2B/src/kj/async-io-unix.c%2B%2B#L1657) checks each resolved socket address with `allowedBy(filter)` immediately before constructing the socket/starting its connection. Fallback recursively repeats the same check for the next address. Inference: a correctly wired runtime filter meets the connection-time security outcome without the application choosing an IP. Sites' production runtime version, outbound binding and filter remain unconfirmed.

The current upstream [KJ network-filter implementation](https://github.com/capnproto/capnproto/blob/master/c%2B%2B/src/kj/async-io.c%2B%2B#L2964) distinguishes these sets:

| Set | IPv4 | IPv6 |
| --- | --- | --- |
| Local/unspecified | `127.0.0.0/8`, `0.0.0.0/32` | `::1/128`, `::/128` |
| Private, CGNAT, link-local | `10.0.0.0/8`, `100.64.0.0/10`, `169.254.0.0/16`, `172.16.0.0/12`, `192.168.0.0/16` | `fc00::/7`, `fe80::/10` |
| Base reserved/multicast deny set | `192.0.0.0/24`, `224.0.0.0/4`, `240.0.0.0/4`, `255.255.255.255/32` | `2001::/23`, `ff00::/8` |

Its `public` rule excludes local/private addresses, and the base filter denies its reserved set. **This is not automatically every IANA non-public range.** For example, the code defines documentation-address ranges separately but does not subtract them in `allowPublic`; benchmarking ranges and some other special-purpose ranges are absent from these deny sets. The application policy is stricter. An equivalent hosted guarantee therefore needs its actual policy/range coverage established, not inference from a variable named `public`. These upstream files were read directly; they are not proof of the version or routing deployed by Sites.

### Supported Sites network administration

[Sites Network access](https://learn.chatgpt.com/docs/enterprise/sites#configure-network-access), where available for the account/admin role, supports exact-hostname or wildcard allowlists rather than IP/CIDR/port rules. Restricted policies block raw TCP; `*` means all HTTP destinations. Per-Site exceptions add to inherited policy and cannot restrict destinations an unrestricted inherited policy already allows. This could independently enforce the app's trusted destinations at the platform layer, but the documentation does not specify DNS-answer filtering or rebinding behavior. A workspace-wide change could affect other Sites and was not made. Native HTTP/HTTPS is the documented application path; raw TCP should not be treated as an out-of-the-box callback alternative.

**`global_fetch_strictly_public` closes a specific routing exception.** The [current flag documentation](https://developers.cloudflare.com/workers/configuration/compatibility-flags/#global-fetch-strictly-public) describes routing same-zone requests through Cloudflare's public front door rather than directly to the private origin. It does not promise that fetch connects to the address returned by our separate DNS preflight. Neither the flag's name nor a local Miniflare result proves the Sites production egress policy. Its availability in the Site publishing contract must also be checked.

**`cf.resolveOverride` is not an OpenAI callback pinning API.** The [Request documentation](https://developers.cloudflare.com/workers/runtime-apis/request/#requestinitcfproperties) specifies an alternate hostname, not a validated literal IP, and ignores it when either host is outside the Worker's zone. It cannot override DNS for the external callback host while preserving that hostname's URL/TLS identity.

**Node wrappers do not add the missing dial control.** Workers [Node HTTP documentation](https://developers.cloudflare.com/workers/runtime-apis/nodejs/http/#request) describes a fetch wrapper and lists `lookup` and `createConnection` as unsupported. Changing HTTP client libraries without a different supported transport therefore does not establish pinning.

**The raw socket restriction is separate.** [Workers TCP documentation](https://developers.cloudflare.com/workers/runtime-apis/tcp-sockets/#considerations) blocks Cloudflare IP ranges and describes private/local socket destinations as disallowed. That documents raw `connect()` policy, not managed Sites fetch policy. The application's prior [hosted callback evidence](sites-callback-support-repro.md) records raw-socket denial before TLS and successful native HTTPS challenge delivery.

## Value and limits of fixed-host controls

[OWASP's fixed-trusted-destination guidance](https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html) recommends explicit allowlisting, careful parsing, no redirects and network-layer restrictions. It now explicitly distinguishes domain allowlisting from DNS-rebinding protection: a separately checked DNS answer is insufficient when the client performs another unchecked lookup. Current code permits exactly the OpenAI hostname, HTTPS, the default port, no URL credentials/fragment, and passes the parsed URL to fetch without following redirects. This removes the ordinary attacker-controlled-host/DNS-rebinding route; OpenAI DNS or infrastructure compromise remains a separate assumption.

[TLS service identity rules](https://www.rfc-editor.org/rfc/rfc9525.html#section-6) authenticate the expected hostname, rather than substituting a DNS alias as the identity. Inference: an unrelated internal HTTPS server normally cannot receive our application payload because it lacks a valid identity for `connectors.api.openai.com`. That does not prevent the preceding network connection attempt and is not a public-address policy.

Preflight DNS, DNS monitoring, shorter DNS cache lifetime, signed challenge echo and webhook HMAC do not themselves restrict the address used by native fetch. Challenge/signature controls cover receiver legitimacy, forgery and replay; bounded time/body limits cover resource consumption. Certificate/SPKI pinning would further restrict server identity, not guarantee that the socket only connects to a public address, and requires certificate/key lifecycle support rather than being a Sites configuration switch.

## Recommended next step

Keep the working exact-host native path and leave the existing free opaque timer separate. Resolve one narrow platform question before adding a relay: **does hosted Sites global fetch enforce a public-address-only destination policy after DNS resolution, on every connection/retry, preserving hostname TLS and excluding any private-origin bypass?** Check the supported Sites deployment contract and seek explicit platform evidence. If confirmed, document the native transport's enforcement and validate the hosted failure paths; application-controlled IP pinning need not be a separate infrastructure component. If unconfirmed, describe the fixed-host controls as a strong compensating control and leave the stricter acceptance claim unproved. No paid relay is justified merely by inability to set a Node `lookup` callback.
