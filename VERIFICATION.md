# Platform and slice verification

Checked 5 October 2026 (Australia/Sydney). Status terms deliberately separate documented capabilities, local proof and live hosted evidence.

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
