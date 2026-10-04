# Platform and slice verification

Checked 4 October 2026 (Australia/Sydney). Status terms deliberately separate documented capabilities, local proof and live hosted evidence.

## Capability checks

| Capability | Evidence | Result / remaining check |
| --- | --- | --- |
| Arbitrary HTTPS routes | Sites bundled Worker entrypoint wraps the framework fetch handler. App handles `/api/*` and `/mcp` there. Production build succeeds. | Route code supported. An unauthenticated provider request through the private Site authentication gate is **not verified**. Watch creation is blocked by default. |
| Google OAuth initiation/callback | Worker routes, server secret bindings, PKCE/state/cookie implementation; integration test exchanges fake Google tokens and proves owner binding/replay rejection. | Locally verified. Real Google client and redirect/session test pending. The callback is `/api/google/callback`, avoiding Sites' reserved `/callback`. |
| Persistent storage | Sites persistence guidance specifies D1 logical binding and generated Drizzle migrations. `DB` manifest binding and migrations included. SQLite tests cover owner-scoped persisted grants and snapshots. | Locally verified. Hosted migrations and persistence must be confirmed at publication. |
| Secrets | Sites `update_environment_variables` supports `is_secret`; application reads Worker env only. OAuth credentials are encrypted before D1 persistence. | Documented and source-checked. No Google credentials supplied/configured for this run. |
| Background execution | Allowed hosting manifest fields and current Sites tool surface expose D1/R2 and cloud-task automations, but no app-controlled durable per-occurrence timer or Worker alarm binding. | **Unverified / unavailable through reviewed surface**, not a claim that underlying Workers lacks alarms. No JS timers, cron, polling or ChatGPT scheduled-task workaround added. |
| Outbound HTTPS | Worker runtime supports `fetch`; Google adapter uses bounded requests to fixed Google origins, denies redirects. | Fake-HTTP tested. Live Google round-trip pending credentials. General fetch alone does not establish a safe MCP callback transport. |
| MCP Events | [Current OpenAI documentation](https://developers.openai.com/plugins/build/mcp-events) requires MCP 2.0 version `2026-07-28`, durable subscriptions, challenge verification, Standard Webhooks signatures and public-address validation at connection time. | Protocol researched. Discovery implements the current version; empty event catalog and fail-closed subscriptions. Callback transport, persisted subscriptions and live ChatGPT subscription intentionally deferred to the next slice. |
| Timing | [Google push guide](https://developers.google.com/workspace/calendar/api/guides/push) describes collection changes. [Reminders guide](https://developers.google.com/workspace/calendar/api/concepts/reminders) distinguishes reminders from server push. | A resource change is not an event-start trigger. Reliable starts need a durable Site-native timer after syncing the occurrence. |
| Watch lifecycle | Google push guide describes expiring channels, renewal using new IDs, overlapping channels, and initial sync racing the watch response. | Manual renewal, persisted expiry, initial-sync race and revocation tested. No automatic renewal without a verified background primitive. |

## Automated evidence

13 integration tests pass with the real route/service code, generated migrations, Node SQLite, and a fake Google provider. They cover setup-to-webhook flow, default-disabled discovery, newly shared calendars, cross-owner access, forged/resource-mismatched/expired/replayed notifications, manual renewal, initial sync race, consent revocation during watch creation and sync, OAuth encryption/PKCE/state replay, CSRF, disconnect with invalid credentials, and Google pagination/recurrence normalization.

TypeScript checking, ESLint and the production Worker build pass. These checks **do not prove** live Google OAuth, provider webhook ingress, ChatGPT connection, event callbacks or timely wake-up.

## Hosted checkpoint

Site identity: `appgprj_6ac22de0956c8191a45d5b1bb86fd5e4`.

Pre-publication checkpoint: local mock sign-in redirects, setup UI configuration-pending state, `/api/status`, and generated migrations were verified against the running Worker/D1 preview. The production publication and database checks are reported with delivery. OAuth credentials are still required. Do not set `GOOGLE_WEBHOOK_VERIFIED=true` from a local or authenticated route check.

## Smallest next step and conditional fallback

1. Configure Google OAuth secrets and test the real redirect flow, discovery and persisted consent.
2. Verify a public, unauthenticated route **without changing the Site audience**. Google webhooks cannot send a ChatGPT session cookie or arbitrary bearer header. The reviewed Sites bypass-token facility requires explicit user request; no token was requested or manufactured here.
3. If Sites cannot exempt a single provider route, the smallest possible external addition is a narrow HTTPS ingress relay validating Google channel credentials and forwarding through an approved Site service-access path. That path must be verified first; do not broaden Site access or invent user identity.
4. Confirm a Site-native durable timer, watch-renewal facility and callback-safe outbound transport. If unavailable, the smallest extra component would be one durable occurrence/watch dispatcher with an outbox; its authentication and data minimization need an explicit contract. No fallback is provisioned in this commit.
5. Only then implement/persist MCP subscriptions and emit `calendar.event.starting`, and demonstrate a timed occurrence waking a Work Cloud chat. Until then the hypothesis remains unvalidated.

Source of Sites runtime, persistence, identity and hosting constraints: installed Sites plugin v0.1.75 `sites-building`, `sites-hosting`, `sites-mcp` skills and bundled starter. [Public Sites overview](https://learn.chatgpt.com/workflows/sites) provides user-facing context; no unsupported manifest fields or inferred timer bindings have been added.
