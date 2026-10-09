# MCP server and plugin reference check

Checked 9 October 2026 against [OpenAI MCP Extensions](https://github.com/openai/mcp-extensions/tree/7e1be49daea03d7ec46ed2472f410099db2743d6), including its specification, TypeScript server helpers and Bits & Bolts example. Application baseline: `81a18ee93ef1fe44fe0f50162b215a697ba331d1`. The follow-up implements the calendar entrypoint and the concrete protocol defects found in that review. This work does not repeat the earlier Google event-start delivery experiment.

## Compatibility findings

| Area | Assessment |
| --- | --- |
| Site/plugin connection | `.openai/hosting.json` declares `mcp`; the existing Site serves stateless `POST /mcp`. Sites supplies authenticated identity and its existing plugin. A second plugin or local stdio registration is unnecessary. |
| Modern discovery | Server identity uses `_meta["io.modelcontextprotocol/serverInfo"]`, matching the reference. Legacy `initialize.serverInfo` is retained. This metadata is recommended for presentation, not an authorization boundary. |
| Tool permissions | `enabled_calendars` has a human-readable title and explicit read-only, non-destructive, idempotent, closed-world annotations. These hints describe its existing behavior; ownership remains enforced by the SQL query. |
| Tools and private data | Discovery contains schemas and static descriptions. Tool calls return only the authenticated owner's explicitly enabled calendars. Calendar names remain untrusted data. Local regressions check owner isolation and absence of writes. |
| Events | The three authenticated event methods, webhook catalog/filter schemas, signed challenge, finite lifetime, rotation, idempotent unsubscribe and persisted delivery align with the separate [OpenAI MCP Events guide](https://developers.openai.com/plugins/build/mcp-events). Existing tests cover expiry, revocation, restart and retry. The extensions SDK does not implement an event-start scheduler. |
| Native plugin UI | Calendar settings advertises global and thread entrypoints using a read-only tool accepting `{}`. Its static `text/html;profile=mcp-app` resource embeds the shared Site controls. An app-visible action tool reuses existing owner-scoped consent routes. Google OAuth opens the original Site through `ui/open-link`; no token or cookie enters the iframe. Structured plugin settings, composer mentions and onboarding skills remain optional and unadvertised. |
| SDK adoption | The embedded UI uses the pinned `@modelcontextprotocol/ext-apps` 1.7.5 SDK for initialization, tool calls, browser links and resizing. It bundles all assets locally and advertises empty network/resource/frame/base-URI allowlists. The HTTP adapter remains explicit and tested; installing an extension package is not a conformance certificate or a scheduler. |

The metadata fixes follow [the pinned extensions specification](https://github.com/openai/mcp-extensions/blob/7e1be49daea03d7ec46ed2472f410099db2743d6/docs/spec.md#structured-settings) and [the example's tool annotations](https://github.com/openai/mcp-extensions/blob/7e1be49daea03d7ec46ed2472f410099db2743d6/plugins/bits-and-bolts/src/server/register.ts).

## Protocol corrections

The original review reproduced the following defects with authenticated local discovery probes. The adapter now validates requests before dispatching any tool or event method:

| Request | Original result | Implemented result |
| --- | --- | --- |
| Explicit unsupported version `2099-01-01` in both header and request metadata | HTTP 200 discovery | HTTP 400 / `-32022`, with requested and supported versions. |
| A foreign `Origin` | HTTP 200 discovery | HTTP 403 before dispatch. Site origin, ChatGPT origin and clients without an Origin are supported. Authentication is still required independently. |
| Malformed JSON | Generic HTTP 503 | HTTP 400 / `-32700`, with a JSON-RPC envelope. |

Modern `2026-07-28` requests require protocol-version metadata/header agreement, `Mcp-Method`, and `Mcp-Name` for named methods. Canonical base64-encoded UTF-8 name headers are supported. Mismatches return HTTP 400 / `-32020`; object capabilities are required, and recommended client identity is validated when present. Invalid JSON-RPC shape, batches and unsupported notifications fail before dispatch. Legacy `initialize`, headerless calls and `notifications/initialized` remain supported. Unknown modern methods return HTTP 404 / `-32601`; authenticated GET/DELETE return HTTP 405. Declared empty tool arguments and the fixed calendar action schema are enforced. Modern successful results include the required `resultType: "complete"`, while legacy results retain their existing shape. See [MCP versioning](https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning), [Streamable HTTP validation](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http) and [current result/request schemas](https://modelcontextprotocol.io/specification/2026-07-28/schema#result). These checks cover our advertised stateless tools/resources/events methods, not every optional MCP capability.

## Scope decisions

Keep the existing Sites-provisioned plugin and hosting boundary. Calendar setup is now an optional MCP App entrypoint, rather than only a website link. Opening it never enables a calendar, creates a watch or subscribes a chat. The model does not discover the app-only permission tools. Visibility remains a host presentation hint, not proof of a human click: the backend independently requires authenticated ownership and validates explicit action arguments, while watch/sync/commit retain persisted grant and generation checks.

No paid host or additional Cloudflare service is required by this reference. It supplies plugin integration APIs, not a timer or a guarantee about Sites callback egress. The previously recorded callback transport limitation remains separate from these compatibility findings; see [hosted transport evidence](callback-guarantee-hosted-evidence.md).

## Verification

The full regression suite covers persisted grants, app discovery/resource privacy, read-only opening, app argument validation, explicit enable/watch/disable/disconnect, owner isolation and late-push rejection. Protocol tests cover supported/unsupported versions, mirrored/encoded headers, optional client identity, required capabilities, result discriminants, origin, parse/envelope errors, legacy compatibility, unknown methods and unavailable HTTP methods. Existing Workers/D1, delivery restart/race and TLS tests are retained. The first 97-test run, typecheck, lint and production build passed. The two follow-up result/metadata tests failed before their fixes; final checks and hosted evidence follow below.

The local browser fixture uses the production embedded HTML and official `AppBridge` with the real handler, an in-memory database and a synthetic Google provider. It verified browser link handoff, post-connection refresh, disabled-by-default calendars, unavailable free/busy-only access, enable, watch, resync, disable and disconnect. The 420px view has equal body/client scroll width and usable controls. This is fake-provider browser evidence; it does not demonstrate a new live Google OAuth authorization. The portable dev preview encountered an existing raw TLS asset loader failure; the production build and isolated MCP App fixture work.
