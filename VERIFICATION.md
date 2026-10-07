# Issue #5 remaining acceptance checkpoint — 6 October 2026

Added correlated redacted audit records and an actual Workers/D1 queued-delivery race test. The test first persists a failed delivery, pauses the next Google lookup, and disables/disconnects/unsubscribes/expires/edits/cancels while it is in flight. No second callback is sent. Registration logs join channel/message, opaque occurrence and alarm/outbox tags; attempt logs add subscription tag, attempt and result without private content. All 52 tests, typecheck, lint and production build pass.

Site version 12 published successfully from source `a430d921e6b7db5a0a66932b373de2825ee894f6` with environment revision 6. Live schema inspection confirms `deliveries` and retained calendar/subscription tables. The existing MCP capability and public audience are preserved. `MCP_EVENTS_READY=true` enables discovery after the complete application path passed local runtime checks and the hosted migration succeeded. The authenticated browser retains Google connection, the enabled Personal calendar and its active watch, and shows event delivery available. Its status and calendar requests returned HTTP 200 (requests `e370231ec110d839fa23cd5f62a3d820` and `ba12bf836762e2b6fe93df08864f908e`).

Live D1 inspection still found zero subscriptions. No actual ChatGPT challenge or Google-to-subscriber callback acknowledgement is claimed. The new synthetic TLS diagnostic navigation was blocked by the browser before an observable diagnostic invocation; prior hosted TLS evidence remains historical. The remaining #5 gate is a supported Work Cloud chat subscribing through the existing plugin, followed by a disposable real Google event and measured signed callback acknowledgement. An actual chat response belongs to #6. No replacement plugin, callback receiver infrastructure, bypass credential or calendar write was created.

# Signed outbox implementation — 6 October 2026

The local delivery path now connects actual Workers/D1 and SQLite Durable Object alarms to a test receiver through MCP subscription verification. The receiver independently verifies signatures, returns a transient 503, and accepts a retry after both runtimes restart. ID and body remain identical; signing time changes. Real Go TLS tests verify terminal HTTP status propagation. All 50 tests, typecheck, lint and production build pass. These are local runtime/fake-provider results. Hosted migration, real subscriber acceptance and a ChatGPT response remain unverified; readiness defaults closed. See [delivery checkpoint](docs/signed-outbox.md).

# Site-local TLS implementation — 6 October 2026

The Site Worker now wires Go 1.27.1 standard TLS/X.509 compiled to WASM over raw TCP to a validated literal public IP. Existing timer infrastructure is unchanged. A local Workers public-network probe successfully posted synthetic data directly to httpbin.org with real DNS and the fixed CA bundle. Real local TLS tests reject wrong-host and untrusted/expired certificates, corrupted records, redirects, oversized bodies and stalled peers. Worker execution and Site production bundling succeed. Site version 10 (`6e5a32d43433c29edfbd55bf4f5cb3131d5f9cea`, environment revision 5) deployed successfully with MCP retained. At 11:25 Australia/Sydney, the authenticated fixed diagnostic completed HTTP 200 in the production Worker: request `f0cc58d76864abf694e3e05182e8641c`, ray `a4608768e93bd8d7`, wall time 998 ms, CPU time 154 ms. Its code reaches that result only after direct TLS, a 2xx upstream response and bounded JSON parsing. Chrome blocked display of the JSON document, so the echo boolean was not independently read; the Worker invocation supplies hosted transport evidence. Existing setup was then verified to retain the Google connection, enabled calendar, watch and one due receipt, with no browser console errors. No real ChatGPT callback/subscription proof is claimed; event discovery remains closed. All 41 tests, typecheck, lint and production build pass. See [implementation](tls-client/README.md) and [transport checkpoint](docs/callback-transport.md).

# Issue #4 subscription checkpoint

Subscription persistence, encrypted key rotation, signed challenges, expiry, refresh and unsubscribe are implemented. All 37 tests pass, including a Workers/D1 lifecycle and runtime restart with a test-only callback receiver; typecheck, lint and production build pass. This historical checkpoint preceded the Site-local TLS implementation above. No live subscription or ChatGPT callback was created. Issue #4 remains open; see [capability evidence and Site-only deployment decision](docs/callback-transport.md).

# Public-hosting verification

## Issue #3 opaque alarm implementation

The user approved the external encrypted-alarm dispatcher on 5 October. Cloudflare CLI deployed `calendar-opaque-alarms`, version `762a4d03-08e2-4c97-b1f9-a538c37ec9b1`: 7.20 KiB upload, 2.50 KiB gzip, 1 ms startup. The initial Site-native capability probe below is historical; this approved service resolves that timer boundary.

Automated coverage includes actual SQLite Durable Object alarms surviving runtime restart, bounded callback retries, redirect rejection, idempotent registration, a complete Workers → dispatcher → signed Site callback → Google lookup → D1 flow, recurring-series movement, cancellation, consent races, encryption and deduplication. All 28 tests pass; root typecheck, lint and production build, plus dispatcher typecheck/build, pass. Subscriber callbacks and agent wake-up remain later issues.

### Live timer proof

Public Site version 7 deployed `a2dd53f757b08c61befcb38afc807b9e7646a744` with runtime revision 5 and the additive `occurrence_outbox` migration. A disposable Google event, without guests or reminders, was scheduled for 5 October 2026 at 21:00–21:05 Australia/Sydney. Resync succeeded at 20:55:13; real Google push subsequently succeeded at 20:55:31 and 20:55:52. The setup tab was closed before the start; the Calendar tab was navigated away too.

While the alarm was pending, the dispatcher was redeployed to version `86564cfd-bae4-4287-bc6a-acd7d89662e9`. At 21:00 the persisted alarm called the Site. Live D1 readback showed exactly one pending receipt: `due_at=1791194400000`, `created_at=1791194404412`, measured claim lateness **4,412 ms**. The callback returned 204 at 21:00:04.792, request `d4dd4644fabd52704c4d858d697f485e`, ray `a45b93a84d735ab8`, logged outcome `due_work`. Reopening setup showed one due occurrence and preserved the receipt. The disposable Google event was then deleted through Calendar.

Dispatcher health returned 200; an unsigned public wake POST returned 403; anonymous status returned 401. The live check proves alarm-to-due-work, not MCP subscriber delivery or an agent response. Recurring edits, cancellation before start, DST, transient provider failure and consent races are automated evidence, not additional live provider demonstrations.

The user authorized public hosting on 5 October 2026. The anonymous webhook validator is now reachable; anonymous and forged-identity setup/MCP calls remain unauthorized. Existing Google connection and explicit calendar consent are preserved. The public rollout and real provider test build on PR #8; the earlier private-hosting blocker below is historical.

## Historical public ingress deployment and boundaries

Public version 5 deploys source `e27ef7d1420b4aa1de42102b0c6877162b60b711` with runtime environment revision 4. The Google connection and existing calendar grants were retained: Personal enabled, three other calendars disabled. No agent or event-start subscription was configured.

Logged-out ingress proof on 5 October at 16:31 Australia/Sydney reached the application validator (forged webhook 403, ray `a45a0ad79ebbe7d4-SYD`). Anonymous status/MCP and forged identity headers remained 401. Only after this proof was `GOOGLE_WEBHOOK_VERIFIED=true` enabled. The dispatch-owned ChatGPT sign-in route returns 302 for a logged-out request.

Real watch creation first exposed an active-initial-notification race: the initial notification and watch bootstrap competed for the sync lease. A deterministic regression reproduced the live 503. Authenticated initial notifications now acknowledge without fetching; bootstrap owns the initial snapshot. Invalid resources and revoked grants still fail closed.

On version 5, real Google initial notification returned 204 at 16:43:52 (ray `a45a1c749882112b`, message 1, `active-initial`). Watch creation completed and D1 persisted an active channel, token hash, resource ID, expiry and successful initial snapshot. The first failed channel remains inactive for diagnosis; its provider channel was stopped.

A disposable event with no guests/reminder was saved through the user's Google Calendar browser. Google's create notification returned 204 at 16:45:50 (ray `a45a1f4e58dc8114`, message 26883). D1 changed from 3 to 4 canonical occurrences and contained the test title and 6 October 18:00–18:05 +11:00 times. No manual resync was used.

The real edit notification returned 204 at 16:47:46 (ray `a45a222989657651`, message 163163). D1 retained the same occurrence and reflected both its edited title and 18:10 end time. Google Calendar confirmed Event deleted after removing the disposable event. The delete notification returned 204 at 16:49:42 (ray `a45a24f9cd8f863e`, message 285094). D1 returned to 3 occurrences with the test row absent. All three changes used provider push, without manual resync.

22 automated tests pass, including four Workers tests and the live-discovered race regression. Typecheck, lint, production build and both GitHub verification checks pass. Fake-provider coverage verifies failure/recovery, replay/order, expiry, disabled/newly shared calendars, owner isolation and revocation; destructive live revocation was not performed on the user's existing connection.

## Remaining scope

Unattended convergence, automatic watch renewal, MCP event callbacks and ChatGPT wake-up remain future slices. Recovery is explicit through Resync now; it does not activate an agent.

# Historical private-hosting PR checkpoint

Verified 5 October 2026 (Australia/Sydney), issue #2 PR source. The changed recovery UI/schema are local and awaiting PR review; hosted evidence refers to live version 3.

| Boundary | Evidence | Result |
| --- | --- | --- |
| Local browser → API → D1 → UI | Isolated app at port 3102, migrated local D1; `/api/status` returned disconnected/configuration-pending with no watches; rendered Connect Google disabled and empty calendars; browser console had no errors | Pass for unconfigured setup |
| Hosted browser → Google discovery → persisted consent → UI | Google connected; Personal enabled; three other calendars disabled; Start watch disabled; no browser errors; D1 readback one enabled grant, zero watches/events | Pass for existing setup checkpoint; no fresh OAuth authorization performed |
| Workers → real Google adapter → fake provider → D1 | E2E OAuth/cookie/PKCE, default-disabled discovery, explicit enable, hashed watch token/resource/expiry, initial sync, create/edit snapshots, cancellation, failure/resync, duplicate/out-of-order messages, disable and disconnect | Pass with fake provider; no external networking |
| SQLite service races and authorization | Initial notification before watch response, consent revocation, missing/cross-owner identity, CSRF, expired watches, failed fetch retaining snapshot/cursor, concurrent notification preserving recovery warning | Pass |
| Anonymous Google ingress → hosting → application | Hosted forged POST returned 401/HTML | Blocked before Worker |
| Existing service access → application validation | Hosted forged POST returned application 403; ownerless status and MCP remained 401 | Forwarding path verified; direct Google delivery still blocked |

See [docs/private-ingress.md](docs/private-ingress.md) for redacted request IDs and the conditional relay contract. No audience, credential or runtime gate changes were made. No live watch or calendar event was created, edited or cancelled.

## Explicit recovery

`POST /api/calendars/resync` requires the signed-in owner, matching origin, current grant and an active unexpired watch. It fetches current provider state without creating a new watch. Failed sync preserves the prior snapshot/message cursor and marks the watch for recovery. A notification rejected during an in-flight sync leaves a recovery warning even if that fetch succeeds. The UI offers Resync now and surfaces that warning; a successful uncontended recovery clears it. Disable/disconnect prevent in-flight work from restoring event contents. Watch expiry requires Start/Renew watch instead.

This is bounded manual recovery, not guaranteed unattended convergence or automatic renewal. The snapshot window does not advance without sync. Event-start scheduling, MCP subscriptions/callback delivery and ChatGPT wake-up remain unimplemented.

## Checks

21 tests pass, including four Workers tests. Typechecking, lint and production build pass. The generated additive migration applied successfully to isolated local D1. The hosted ingress probe deliberately exits 1 because direct ingress is blocked. GitHub CI results are attached to the PR.

# Historical first-publication notes

These earlier notes are retained for provenance. The current public-hosting checkpoint supersedes these earlier findings.

## Capability checks

| Capability | Evidence | Result / remaining check |
| --- | --- | --- |
| Arbitrary HTTPS routes | Sites bundled Worker entrypoint wraps the framework fetch handler. App handles `/api/*` and `/mcp` there. Production build succeeds. | Route code supported. Hosted unauthenticated `POST /api/google/webhook` returned **HTTP 401** with an HTML response on the final production URL. Provider ingress is blocked at the hosting boundary. Watch creation remains blocked. |
| Google OAuth initiation/callback | Worker routes, server secret bindings, PKCE/state/cookie implementation; tests exchange fake Google tokens and prove owner binding/replay rejection. Workers runtime regression covers callback, encrypted persistence, refresh and discovery. | The user completed a fresh real Google authorization after the runtime fix and enabled Personal. Live D1 inspection independently confirmed the connection and grant. The callback is `/api/google/callback`, avoiding Sites' reserved `/callback`. |
| Persistent storage | Sites persistence guidance specifies D1 logical binding and generated Drizzle migrations. `DB` manifest binding and migrations included. SQLite tests cover owner-scoped persisted grants and snapshots. | Live `DB` contains all five migrated tables, one Google connection and one enabled calendar. Live watch/event persistence is not yet proven: both tables were empty at this checkpoint. Reopening setup across sessions remains a separate recovery check. |
| Secrets | Sites `update_environment_variables` supports `is_secret`; application reads Worker env only. OAuth credentials are encrypted before D1 persistence. | Live runtime revision 3 contains the Google client ID, secret client credential and secret token-encryption key. Private redeployment applied this revision. |
| Background execution | Allowed hosting manifest fields and current Sites tool surface expose D1/R2 and cloud-task automations, but no app-controlled durable per-occurrence timer or Worker alarm binding. | **Unverified / unavailable through reviewed surface**, not a claim that underlying Workers lacks alarms. No JS timers, cron, polling or ChatGPT scheduled-task workaround added. |
| Outbound HTTPS | Worker runtime supports `fetch`; Google adapter uses bounded requests to fixed Google origins and rejects redirect responses using manual redirect handling. | Workers tests cover successful token exchange/discovery and rejected redirects from both Google endpoints. Real Google OAuth, discovery and consent now work through the user-run flow. General fetch alone does not establish a safe MCP callback transport. |
| MCP Events | [Current OpenAI documentation](https://developers.openai.com/plugins/build/mcp-events) requires MCP 2.0 version `2026-07-28`, durable subscriptions, challenge verification, Standard Webhooks signatures and public-address validation at connection time. | Protocol researched. Discovery implements the current version; empty event catalog and fail-closed subscriptions. Callback transport, persisted subscriptions and live ChatGPT subscription intentionally deferred to the next slice. |
| Timing | [Google push guide](https://developers.google.com/workspace/calendar/api/guides/push) describes collection changes. [Reminders guide](https://developers.google.com/workspace/calendar/api/concepts/reminders) distinguishes reminders from server push. | A resource change is not an event-start trigger. Reliable starts need a durable Site-native timer after syncing the occurrence. |
| Watch lifecycle | Google push guide describes expiring channels, renewal using new IDs, overlapping channels, and initial sync racing the watch response. | Manual renewal, persisted expiry, initial-sync race and revocation tested. No automatic renewal without a verified background primitive. |

## Automated evidence

16 integration tests pass: 13 with the real route/service code, generated migrations, Node SQLite, and a fake Google provider, plus 3 in the Workers runtime with D1 and mocked outbound HTTPS. They cover setup-to-webhook flow, default-disabled discovery, newly shared calendars, cross-owner access, forged/resource-mismatched/expired/replayed notifications, manual renewal, initial sync race, consent revocation during watch creation and sync, OAuth encryption/PKCE/state replay, CSRF, disconnect with invalid credentials, Google pagination/recurrence normalization, and the complete OAuth-to-discovery flow with redirect rejection. External networking is disabled in the Workers tests.

TypeScript checking, ESLint and the production Worker build pass. Automated checks alone do not prove hosted behavior. Live Google setup evidence is recorded below; provider webhook ingress, ChatGPT connection, event callbacks and timely wake-up remain unverified or blocked.

## Hosted checkpoint

Site identity: `appgprj_6ac22de0956c8191a45d5b1bb86fd5e4`.

Local mock sign-in redirects, setup UI configuration-pending state, `/api/status`, and generated migrations were verified against the running Worker/D1 preview.

Private publication succeeded. Final production URL: `https://schedule-my-agents.bennycrow91.chatgpt.site`. Sites reported `has_mcp: true`. Live `DB` overview returned `calendars`, `connections`, `events`, `oauth_states`, and `watches`, confirming production migration application. An unauthenticated webhook POST returned HTTP 401 and HTML rather than the application's JSON notification validation response. This confirms the ingress blocker for the current private deployment.

The provisional origin returned at registration differed from the final URL. `SITE_ORIGIN` and Google redirect instructions were updated to use the actual production origin. OAuth credentials are configured. Do not set `GOOGLE_WEBHOOK_VERIFIED=true` from a local or authenticated route check.

On 5 October at 08:41:39 Australia/Sydney, the real Google callback returned 503 with `TypeError` (request `8dea49054130521c34f6a82c7f9b459a`). A Workers regression reproduced the exact generic error. Local instrumentation identified unsupported `redirect: 'error'` in the token exchange; using `manual` restores the callback while still rejecting redirect responses. The next calendar-list request then exposed native `fetch` being invoked with the adapter as its receiver; a function wrapper fixes that invocation. The runtime regression now passes through callback, encrypted token storage, refresh and default-disabled discovery. Temporary instrumentation was removed. OAuth state is single-use, so recovery requires starting Connect Google again rather than refreshing the failed callback.

After deployment of source commit `840e25ad17ec9ea4cce9559d5ecb19397b62aed5`, the user confirmed that the account connected and Personal was enabled. A separate read-only Sites database inspection returned one `connections` row and one enabled `calendars` row, with zero `watches` and zero `events`. This verifies the hosted OAuth/discovery/explicit-consent checkpoint; it does not prove notification ingress, timed dispatch or a ChatGPT response. No credential values or private calendar identifiers were copied into this record.

## Smallest next step and conditional fallback

1. Resolve the observed HTTP 401 at the private Site boundary and verify a provider-accessible notification route **without changing the Site audience**. Google webhooks cannot send a ChatGPT session cookie or arbitrary bearer header. The reviewed Sites bypass-token facility requires explicit user request; no token was requested or manufactured here.
2. If Sites cannot exempt a single provider route, the smallest possible external addition is a narrow HTTPS ingress relay validating Google channel credentials and forwarding through an approved Site service-access path. That path must be verified first; do not broaden Site access or invent user identity.
3. Confirm a Site-native durable timer and callback-safe outbound transport. If unavailable, the smallest extra component would be one durable occurrence/watch dispatcher with an outbox; its authentication and data minimization need an explicit contract. No fallback has been provisioned. Manual watch renewal remains acceptable for the first bounded demo.
4. Implement persisted, authorized MCP subscriptions and signed delivery from due occurrences, then demonstrate a timed occurrence waking a Work Cloud chat. Until then the hypothesis remains unvalidated. [The MVP roadmap](docs/mvp.md) links the implementation issues and their live acceptance checks.

Source of Sites runtime, persistence, identity and hosting constraints: installed Sites plugin v0.1.75 `sites-building`, `sites-hosting`, `sites-mcp` skills and bundled starter. [Public Sites overview](https://learn.chatgpt.com/workflows/sites) provides user-facing context; no unsupported manifest fields or inferred timer bindings have been added.

## Work Cloud subscription failure, 7 October 2026

The installed plugin successfully listed the enabled calendar and exposed the event schema. In the Work chat `Load Calendar Tools`, task creation returned an unexpected task-service error twice. Production requests at 04:02:32 and 04:02:48 UTC each reached `events/subscribe`, then `events/unsubscribe` roughly 250 ms later. Both HTTP responses were 200; these logs do not distinguish a JSON-RPC rejection from a successful subscription followed by task rollback. No active subscription or real callback acceptance is established.

Added bounded `calendar_subscription` audit outcomes at the MCP boundary: accepted, or rejected with the numeric protocol code and fixed categorized reason. Logs exclude request parameters, owners, calendar IDs, callback URLs, signing secrets and challenge bodies. A fresh Work Cloud attempt is required to classify the failure. All 52 tests, typecheck, lint and production build pass after the logging change.

The retry at 04:19:57 UTC returned `-32015` / `challenge_failed` from our MCP endpoint (request `0b7b1ac89c5a1a0cd0e11a7e40390b9f`), followed by accepted unsubscribe. This confirms callback verification failed before subscription persistence; the task-service message obscures that underlying protocol rejection. Further bounded audits distinguish transport stages and fixed error categories, HTTP status rejection, response-body failure and invalid challenge echo, without raw runtime messages or callback contents. Regression coverage asserts diagnostic redaction and failure-stage distinctions. All 53 tests and build checks pass.

A directly coordinated Work Cloud attempt at 05:25:14 UTC reproduced the failure (request `d6ea6b8a09e8bd3aadc055cad3b9a95f`). The transport audit identified `address_policy` / `unsafe_destination`; verification failed at `transport`, before any HTTPS callback or persisted subscription. This narrows the failure to empty, excessive, or non-public DNS results; the existing log did not establish which. Site version 15 adds only address-result and non-public-result counts on this rejection, preserving address validation and omitting hostnames/IPs. All 53 tests, typecheck, lint and production build pass. A second directly coordinated attempt was rejected by automatic approval review as exceeding the authorized single retry, so it was not sent. A further authorized attempt remains necessary to classify the DNS results.

At 05:41:26 UTC, the authorized additional attempt returned six DNS results, two rejected as non-public (request `1c6d8dee08d7ad0f9dfc3681452d0bce`). Cloudflare workerd's `resolve4` and `resolve6` implementations map every DNS answer's `data` without filtering record type, so CNAME names are exposed as addresses. A deterministic Workers regression with one CNAME and one address per query reproduced exactly that malformed address array. This establishes the runtime bug independently; the actual live rejected values were deliberately not logged, so whether both were aliases remains an inference until live success.

The callback transport now reads bounded typed DNS JSON through the same Cloudflare DoH endpoint. It excludes CNAME metadata from socket destinations while retaining every A/AAAA result for the unchanged public-address policy. It rejects query/parse failures, unexpected records, empty/oversized sets, mixed private/public addresses and redirects. Original hostname TLS verification and literal-IP connection remain unchanged. The alias regression turns green; mixed/private/empty/malformed/excessive-answer Workers regressions also pass. All 55 tests, typecheck, lint and production build pass. A fresh live subscription after publication is still required.

Primary resolver source: https://github.com/cloudflare/workerd/blob/main/src/node/internal/internal_dns.ts (`resolve4` and `resolve6`); https://github.com/cloudflare/workerd/blob/main/src/node/internal/internal_dns_client.ts (DoH endpoint). Source inspected on 7 October 2026; this is a current-source assessment, not a guarantee of every deployed runtime version.

## Retest after typed DNS fix, 7 October 2026

The explicitly authorized Work Cloud retest at 07:54:08 UTC reached callback transport `socket_connect` and failed with the fixed `connection` category (request `969c051046bc577079d17f106a8b87be`). The prior `address_policy` rejection no longer occurred. TLS initialization passed, but the TCP socket did not open; the Go TLS/HTTP function is invoked only after socket.opened, so no TLS handshake or callback application request ran. MCP returned `-32015` / `challenge_failed`, followed by accepted unsubscribe. The Work chat reported the same task-service error and zero saved automations. No calendar writes were made.

The exact low-level socket error is intentionally omitted from audit logs. Cloudflare documents refusal of socket connections to Cloudflare IP ranges; this is a plausible platform limitation, not yet a confirmed destination-specific cause. Live callback verification, signed due-event delivery and issue #5 completion remain unproved. Do not substitute unchecked fetch or weaken DNS/TLS controls to make this retest pass.
