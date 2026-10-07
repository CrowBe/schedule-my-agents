# Sites MCP Events callback transport question

Prepared 2026-10-07; not submitted to support.

## Confirmed live result

Site: https://schedule-my-agents.bennycrow91.chatgpt.site

Deployed v19 implements a verification-only diagnostic transport. A real Work Cloud subscription attempt supplied a callback on `connectors.api.openai.com`. The Site sent its signed `{type: "verification", challenge}` using native fetch, preserving the hostname URL, with redirects disabled. The receiver returned HTTP 200 and the exact challenge. The diagnostic then intentionally threw so no subscription could activate.

Worker evidence: 2026-10-07 08:46:28.070 UTC; request ID `071b3533f19f04697926afbf5a86e192`; `calendar_native_callback_probe {status:200, echo:true, activation:"disabled"}`. Live D1 subscriptions and ChatGPT saved automations were both empty afterward. No calendar writes or event payload delivery occurred.

Earlier direct TCP attempts against every validated address (two IPv4, two IPv6) returned `proxy request failed, cannot connect to the specified address` before TLS started. Native HTTPS therefore works for the actual callback while the raw-socket route is disallowed. This is no longer an unresolved HTTP-reachability question.

## Question for Sites/OpenAI

What supported Sites transport meets the [MCP Events callback requirement](https://developers.openai.com/plugins/build/mcp-events) to resolve and validate destination addresses at connection time, connect to the validated address, retain hostname TLS verification and reject all non-public destinations?

Does Sites global fetch already enforce those guarantees inside its outbound transport, including DNS-rebinding protection? If so, identify the supported guarantee and required compatibility flags. If not, is a safe outbound HTTP binding available?

## Why the standard Node examples cannot be copied directly

- [Workers TCP sockets](https://developers.cloudflare.com/workers/runtime-apis/tcp-sockets/) disallow certain destinations, including Cloudflare IP ranges. Our live callback socket attempts hit the documented disallowed-destination error; exact address network membership was not logged.
- [Workers Node HTTP](https://developers.cloudflare.com/workers/runtime-apis/nodejs/http/) wraps fetch and does not support `lookup` or `createConnection`.
- [Request resolveOverride](https://developers.cloudflare.com/workers/runtime-apis/request/) is ignored if the URL hostname or override is outside the Worker's zone.
- [global_fetch_strictly_public](https://developers.cloudflare.com/workers/configuration/compatibility-flags/) documents public-front-door routing for the Worker's own zone. It does not explicitly promise pinning to the application's preceding DNS validation.
- [workerd compatibility source](https://github.com/cloudflare/workerd/blob/main/src/workerd/io/compatibility-date.capnp) describes SSRF-safe public-only default global outbound for self-hosted workerd, while explicitly distinguishing Cloudflare production behavior. It is useful evidence, not sufficient proof of the Sites production guarantee.

## Minimal diagnostic outline

```ts
// Within authenticated events/subscribe, after authorization and validation.
// No calendar content is included, and this diagnostic never accepts creation.
const response = await fetch(delivery.url, {
  method: 'POST',
  redirect: 'manual',
  signal: AbortSignal.timeout(8000),
  headers: standardWebhookHeaders,
  body: JSON.stringify({ type: 'verification', challenge }),
});
// Read at most 4 KiB; record only status and challenge equality.
throw new Error('Diagnostic cannot activate subscriptions');
```

Never include callback paths, signing secrets, full headers, calendar data or owner identifiers in a support packet. Production readiness is closed and the diagnostic environment flag is removed after the experiment.
