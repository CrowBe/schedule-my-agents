# Public-hosting verification

## Issue #3 opaque alarm implementation

The user approved the external encrypted-alarm dispatcher on 5 October. Cloudflare CLI deployed `calendar-opaque-alarms`, version `762a4d03-08e2-4c97-b1f9-a538c37ec9b1`: 7.20 KiB upload, 2.50 KiB gzip, 1 ms startup. The initial Site-native capability probe below is historical; this approved service resolves that timer boundary.

Automated coverage includes actual SQLite Durable Object alarms surviving runtime restart, bounded callback retries, redirect rejection, idempotent registration, a complete Workers → dispatcher → signed Site callback → Google lookup → D1 flow, recurring-series movement, cancellation, consent races, encryption and deduplication. Hosted closed-browser timing remains pending until recorded here. Subscriber callbacks and agent wake-up remain later issues.

The user authorized public hosting on 5 October 2026. The anonymous webhook validator is now reachable; anonymous and forged-identity setup/MCP calls remain unauthorized. Existing Google connection and explicit calendar consent are preserved. The public rollout and real provider test build on PR #8; the earlier private-hosting blocker below is historical.

## Current deployment and boundaries

Public version 5 deploys source `e27ef7d1420b4aa1de42102b0c6877162b60b711` with runtime environment revision 4. The Google connection and existing calendar grants were retained: Personal enabled, three other calendars disabled. No agent or event-start subscription was configured.

Logged-out ingress proof on 5 October at 16:31 Australia/Sydney reached the application validator (forged webhook 403, ray `a45a0ad79ebbe7d4-SYD`). Anonymous status/MCP and forged identity headers remained 401. Only after this proof was `GOOGLE_WEBHOOK_VERIFIED=true` enabled. The dispatch-owned ChatGPT sign-in route returns 302 for a logged-out request.

Real watch creation first exposed an active-initial-notification race: the initial notification and watch bootstrap competed for the sync lease. A deterministic regression reproduced the live 503. Authenticated initial notifications now acknowledge without fetching; bootstrap owns the initial snapshot. Invalid resources and revoked grants still fail closed.

On version 5, real Google initial notification returned 204 at 16:43:52 (ray `a45a1c749882112b`, message 1, `active-initial`). Watch creation completed and D1 persisted an active channel, token hash, resource ID, expiry and successful initial snapshot. The first failed channel remains inactive for diagnosis; its provider channel was stopped.

A disposable event with no guests/reminder was saved through the user's Google Calendar browser. Google's create notification returned 204 at 16:45:50 (ray `a45a1f4e58dc8114`, message 26883). D1 changed from 3 to 4 canonical occurrences and contained the test title and 6 October 18:00–18:05 +11:00 times. No manual resync was used.

The real edit notification returned 204 at 16:47:46 (ray `a45a222989657651`, message 163163). D1 retained the same occurrence and reflected both its edited title and 18:10 end time. Google Calendar confirmed Event deleted after removing the disposable event. The delete notification returned 204 at 16:49:42 (ray `a45a24f9cd8f863e`, message 285094). D1 returned to 3 occurrences with the test row absent. All three changes used provider push, without manual resync.

22 automated tests pass, including four Workers tests and the live-discovered race regression. Typecheck, lint, production build and both GitHub verification checks pass. Fake-provider coverage verifies failure/recovery, replay/order, expiry, disabled/newly shared calendars, owner isolation and revocation; destructive live revocation was not performed on the user's existing connection.

## Remaining scope

Unattended convergence, automatic watch renewal, event-start scheduling, MCP event callbacks and ChatGPT wake-up remain future slices. Recovery is explicit through Resync now; it does not activate an agent.

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
| Google OAuth initiation/callback | Worker routes, server secret bindings, PKCE/state/cookie implementation; tests exchange fake Google tokens and prove owner binding/replay rejection. Workers runtime regression covers callback, encrypted persistence, refresh and discovery. | Live initiation and Google permission screen verified. The first real callback returned 503; the runtime faults below are fixed and locally verified. A fresh real callback/discovery retry remains pending. The callback is `/api/google/callback`, avoiding Sites' reserved `/callback`. |
| Persistent storage | Sites persistence guidance specifies D1 logical binding and generated Drizzle migrations. `DB` manifest binding and migrations included. SQLite tests cover owner-scoped persisted grants and snapshots. | Locally verified; live D1 overview after publication confirms all five migrated tables on `DB`. Cross-session real Google data remains pending. |
| Secrets | Sites `update_environment_variables` supports `is_secret`; application reads Worker env only. OAuth credentials are encrypted before D1 persistence. | Live runtime revision 3 contains the Google client ID, secret client credential and secret token-encryption key. Private redeployment applied this revision. |
| Background execution | Allowed hosting manifest fields and current Sites tool surface expose D1/R2 and cloud-task automations, but no app-controlled durable per-occurrence timer or Worker alarm binding. | **Unverified / unavailable through reviewed surface**, not a claim that underlying Workers lacks alarms. No JS timers, cron, polling or ChatGPT scheduled-task workaround added. |
| Outbound HTTPS | Worker runtime supports `fetch`; Google adapter uses bounded requests to fixed Google origins and rejects redirect responses using manual redirect handling. | Workers tests cover successful token exchange/discovery and rejected redirects from both Google endpoints. Live Google round-trip retry remains pending. General fetch alone does not establish a safe MCP callback transport. |
| MCP Events | [Current OpenAI documentation](https://developers.openai.com/plugins/build/mcp-events) requires MCP 2.0 version `2026-07-28`, durable subscriptions, challenge verification, Standard Webhooks signatures and public-address validation at connection time. | Protocol researched. Discovery implements the current version; empty event catalog and fail-closed subscriptions. Callback transport, persisted subscriptions and live ChatGPT subscription intentionally deferred to the next slice. |
| Timing | [Google push guide](https://developers.google.com/workspace/calendar/api/guides/push) describes collection changes. [Reminders guide](https://developers.google.com/workspace/calendar/api/concepts/reminders) distinguishes reminders from server push. | A resource change is not an event-start trigger. Reliable starts need a durable Site-native timer after syncing the occurrence. |
| Watch lifecycle | Google push guide describes expiring channels, renewal using new IDs, overlapping channels, and initial sync racing the watch response. | Manual renewal, persisted expiry, initial-sync race and revocation tested. No automatic renewal without a verified background primitive. |

## Automated evidence

16 integration tests pass: 13 with the real route/service code, generated migrations, Node SQLite, and a fake Google provider, plus 3 in the Workers runtime with D1 and mocked outbound HTTPS. They cover setup-to-webhook flow, default-disabled discovery, newly shared calendars, cross-owner access, forged/resource-mismatched/expired/replayed notifications, manual renewal, initial sync race, consent revocation during watch creation and sync, OAuth encryption/PKCE/state replay, CSRF, disconnect with invalid credentials, Google pagination/recurrence normalization, and the complete OAuth-to-discovery flow with redirect rejection. External networking is disabled in the Workers tests.

TypeScript checking, ESLint and the production Worker build pass. These checks **do not prove** live Google OAuth, provider webhook ingress, ChatGPT connection, event callbacks or timely wake-up.

## Hosted checkpoint

Site identity: `appgprj_6ac22de0956c8191a45d5b1bb86fd5e4`.

Local mock sign-in redirects, setup UI configuration-pending state, `/api/status`, and generated migrations were verified against the running Worker/D1 preview.

Private publication succeeded. Final production URL: `https://schedule-my-agents.bennycrow91.chatgpt.site`. Sites reported `has_mcp: true`. Live `DB` overview returned `calendars`, `connections`, `events`, `oauth_states`, and `watches`, confirming production migration application. An unauthenticated webhook POST returned HTTP 401 and HTML rather than the application's JSON notification validation response. This confirms the ingress blocker for the current private deployment.

The provisional origin returned at registration differed from the final URL. `SITE_ORIGIN` and Google redirect instructions were updated to use the actual production origin. OAuth credentials are configured. Do not set `GOOGLE_WEBHOOK_VERIFIED=true` from a local or authenticated route check.

On 5 October at 08:41:39 Australia/Sydney, the real Google callback returned 503 with `TypeError` (request `8dea49054130521c34f6a82c7f9b459a`). A Workers regression reproduced the exact generic error. Local instrumentation identified unsupported `redirect: 'error'` in the token exchange; using `manual` restores the callback while still rejecting redirect responses. The next calendar-list request then exposed native `fetch` being invoked with the adapter as its receiver; a function wrapper fixes that invocation. The runtime regression now passes through callback, encrypted token storage, refresh and default-disabled discovery. Temporary instrumentation was removed. OAuth state is single-use, so recovery requires starting Connect Google again rather than refreshing the failed callback.

## Smallest next step and conditional fallback

1. Retry Connect Google and verify the real callback, discovery and persisted consent with the configured secrets.
2. Resolve the observed HTTP 401 at the private Site boundary and verify a public, unauthenticated route **without changing the Site audience**. Google webhooks cannot send a ChatGPT session cookie or arbitrary bearer header. The reviewed Sites bypass-token facility requires explicit user request; no token was requested or manufactured here.
3. If Sites cannot exempt a single provider route, the smallest possible external addition is a narrow HTTPS ingress relay validating Google channel credentials and forwarding through an approved Site service-access path. That path must be verified first; do not broaden Site access or invent user identity.
4. Confirm a Site-native durable timer, watch-renewal facility and callback-safe outbound transport. If unavailable, the smallest extra component would be one durable occurrence/watch dispatcher with an outbox; its authentication and data minimization need an explicit contract. No fallback is provisioned in this commit.
5. Only then implement/persist MCP subscriptions and emit `calendar.event.starting`, and demonstrate a timed occurrence waking a Work Cloud chat. Until then the hypothesis remains unvalidated.

Source of Sites runtime, persistence, identity and hosting constraints: installed Sites plugin v0.1.75 `sites-building`, `sites-hosting`, `sites-mcp` skills and bundled starter. [Public Sites overview](https://learn.chatgpt.com/workflows/sites) provides user-facing context; no unsupported manifest fields or inferred timer bindings have been added.
