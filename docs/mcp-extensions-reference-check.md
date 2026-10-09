# MCP server and plugin reference check

Checked 9 October 2026 against [OpenAI MCP Extensions](https://github.com/openai/mcp-extensions/tree/7e1be49daea03d7ec46ed2472f410099db2743d6), including its specification, TypeScript server helpers and Bits & Bolts example. Application baseline: `81a18ee93ef1fe44fe0f50162b215a697ba331d1`. The follow-up implements the calendar entrypoint and the concrete protocol defects found in that review. This work does not repeat the earlier Google event-start delivery experiment.

## Compatibility findings

| Area | Assessment |
| --- | --- |
| Site/plugin connection | `.openai/hosting.json` declares `mcp`; the existing Site serves stateless `POST /mcp`. Sites supplies authenticated identity and its existing plugin. A second plugin or local stdio registration is unnecessary. |
| Modern discovery | Server identity uses `_meta["io.modelcontextprotocol/serverInfo"]`, matching the reference. Legacy `initialize.serverInfo` is retained. This metadata is recommended for presentation, not an authorization boundary. |
| Tool permissions | `enabled_calendars` has a human-readable title and explicit read-only, non-destructive, idempotent, closed-world annotations. These hints describe its existing behavior; ownership remains enforced by the SQL query. |
| Tools and private data | Discovery contains schemas and static descriptions. `enabled_calendars` returns only the authenticated owner's explicitly enabled calendars. Calendar setup snapshots stay in component-only `_meta`; the model receives static text and the Site link. Calendar names remain untrusted data. Local regressions check owner isolation and absence of writes. |
| Events | The three authenticated event methods, webhook catalog/filter schemas, signed challenge, finite lifetime, rotation, idempotent unsubscribe and persisted delivery align with the separate [OpenAI MCP Events guide](https://developers.openai.com/plugins/build/mcp-events). Existing tests cover expiry, revocation, restart and retry. The extensions SDK does not implement an event-start scheduler. |
| Native plugin UI | Calendar settings advertises an optional thread entrypoint using a read-only tool accepting `{}`. Setup is visible to the model and app; permission actions are app-only. A Site resource link supplies a fallback where embedding is unavailable. Its static `text/html;profile=mcp-app` resource embeds the shared Site controls. An app-visible action tool reuses existing owner-scoped consent routes. Google OAuth opens the original Site through `ui/open-link`; no token or cookie enters the iframe. Structured plugin settings, composer mentions and onboarding skills remain optional and unadvertised. |
| SDK adoption | The embedded UI uses the pinned `@modelcontextprotocol/ext-apps` 1.7.5 SDK for initialization, tool calls, browser links and resizing. It bundles all assets locally and advertises empty network/resource/frame allowlists. The HTTP adapter remains explicit and tested; installing an extension package is not a conformance certificate or a scheduler. |

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

Keep the existing Sites-provisioned plugin and hosting boundary. Calendar setup is now an optional MCP App entrypoint, rather than only a website link. Opening it never enables a calendar, creates a watch or subscribes a chat. The model can discover the read-only setup tool, but does not discover the app-only permission action tool. Visibility remains a host presentation hint, not proof of a human click: the backend independently requires authenticated ownership and validates explicit action arguments, while watch/sync/commit retain persisted grant and generation checks.

No paid host or additional Cloudflare service is required by this reference. It supplies plugin integration APIs, not a timer or a guarantee about Sites callback egress. The previously recorded callback transport limitation remains separate from these compatibility findings; see [hosted transport evidence](callback-guarantee-hosted-evidence.md).

## Verification

The full regression suite covers persisted grants, app discovery/resource privacy, read-only opening, app argument validation, explicit enable/watch/disable/disconnect, owner isolation and late-push rejection. Protocol tests cover supported/unsupported versions, mirrored/encoded headers, optional client identity, required capabilities, result discriminants, origin, parse/envelope errors, legacy compatibility, unknown methods and unavailable HTTP methods. Existing Workers/D1, delivery restart/race and TLS tests are retained. The first 97-test run, typecheck, lint and production build passed. The two follow-up result/metadata tests and strengthened snapshot-privacy checks failed before their fixes. A provider-discovery failure regression also failed before connection status and disconnect recovery were preserved. The release suite contains 100 tests; final checks and hosted evidence are recorded below.

The local browser fixture uses the production embedded HTML and official `AppBridge` with the real handler, an in-memory database and a synthetic Google provider. It verified browser link handoff, post-connection refresh, disabled-by-default calendars, unavailable free/busy-only access, enable, watch, resync, disable and disconnect. The 420px view has equal body/client scroll width and usable controls. This is fake-provider browser evidence; it does not demonstrate a new live Google OAuth authorization. The portable dev preview encountered an existing raw TLS asset loader failure; the production build and isolated MCP App fixture work.


## Hosted UI check

On 9 October 2026 the existing public Site and plugin were updated and rescanned. Native discovery, resource reads and the setup tool returned HTTP 200. Bounded temporary probes confirmed non-error resource/setup results without logging owners, calendar names, URLs, tokens or payloads. The real Site remained connected with its existing enabled calendar and watch; no live permission changes were made.

The tested `chatgpt.com/mcp-app` browser route displayed **App unavailable** in both ChatGPT and Codex mode. Removing the optional base-URI CSP field, changing the resource cache key, using a module script, refreshing the tool catalog, and replacing React/the SDK with a 3,910-character protocol control did not establish a working native entrypoint. The tiny control completed initialization and received a tool result through the official local `AppBridge`. Hosted logs likewise confirmed its resource and setup call succeeded. No app frame was present in the settled browser error state. This narrows the failure to native integration, but does not expose its internal cause or prove every supported desktop host fails.

The pinned reference's [platform support table](https://github.com/openai/mcp-extensions/blob/7e1be49daea03d7ec46ed2472f410099db2743d6/docs/spec.md#platform-support) describes expected Work-browser support and explicitly excludes classic ChatGPT. Native embedding remains unverified in a supported Work/Desktop host. The released metadata keeps settings optional as a thread content tab, preserves the regular plugin chat entry, and returns a static original-Site link as fallback. Temporary probes and tool decorations are removed.

The live original Site loaded successfully in Codex's right-hand browser panel using its existing authenticated owner session. It showed the connected Google account, current grant, watch expiry and recovery controls. This is hosted read-only sidebar evidence; the full embedded permission lifecycle is synthetic-provider evidence. No new Google authorization, paid infrastructure, plugin, audience or callback-security guarantee is asserted.
