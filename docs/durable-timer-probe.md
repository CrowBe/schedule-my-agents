> Superseded checkpoint: the user approved an external opaque Cloudflare alarm service on 5 October. See ARCHITECTURE.md and VERIFICATION.md for implementation and current evidence.

# Issue #3: durable timer capability checkpoint

Checked 5 October 2026 against Sites plugin 0.1.75 and the current connector surface. Issue #2 is complete on a **public** Site; the issue's older private-Site wording is superseded. Setup, calendar data and MCP still require owner identity and explicit calendar consent.

## Result

**Blocked on a supported application-controlled durable timer.** No such primitive is exposed by the reviewed Sites interface. This is a limitation of the available deployment contract, not proof that the underlying Cloudflare platform lacks timers. A hosted closed-browser timing/restart experiment cannot be performed without a provisioned primitive. Issue #3 remains open; no due-work acceptance criterion is claimed complete.

## Evidence

- Native `get_site` confirms owner access, `access_mode: public`, and no linked cloud-task automations. Saved version 6 identifies source `df181d02b4ab15ad998905b716bc6acef507bfcb`, which is the base of this checkpoint.
- Sites hosting permits only `project_id`, static configuration, logical D1/R2, verified connectors/plugins and supported capabilities in `.openai/hosting.json`. It supplies no Durable Object namespace, class migration, alarm or application timer declaration.
- Sites starter-capabilities and persistence references document D1/R2, authentication and a fetch Worker. They provide no timer provisioning procedure. The project's `vite.config.ts` declares D1 and a development-only connector service; `build/sites-worker.ts` exports `fetch`, with no scheduled/alarm handler.
- The available Sites connector tools handle source, deployment, secrets, database reads, audience and cloud-task `create_schedule`. They expose no application-controlled alarm/timer provisioning operation. A cloud-task schedule is not an occurrence alarm and is explicitly excluded by issue #3.
- Adding a local Durable Object binding would establish only local emulation. Sites owns production resource wiring; an unsupported manifest field or a local Wrangler configuration cannot establish hosted availability.

Reference paths are under the installed `sites/0.1.75/skills/`: `sites-hosting/SKILL.md` (Rules), `sites-building/references/starter-capabilities.md`, and `sites-building/references/persistence-and-storage.md`.

## Smallest conditional dispatcher proposal

First seek a supported Sites-native Durable Object namespace and alarm provisioning contract. If that is unavailable, the smallest external addition is one Cloudflare Worker with a Durable Object alarm dispatcher. This requires separate infrastructure authorization under `AGENTS.md`; nothing is provisioned here.

Keep Google credentials, calendar contents, grants and canonical occurrences in Site D1. The dispatcher holds only an opaque calendar dispatch key, schedule generation and earliest due timestamp. Site synchronization persists pending occurrence revisions and an alarm-registration intent atomically; the external dispatcher acknowledges durable registration. Interrupted registration remains visible as unscheduled work and is recovered explicitly rather than reported as scheduled.

Authenticate wake requests with a dedicated dispatcher credential, method/path/body binding, bounded timestamp and replay protection. The credential grants only a due-claim operation and supplies no visitor identity or calendar consent. Site D1 derives the stored owner and atomically rechecks connection, grant generation, occurrence revision, cancellation and due time before inserting a uniquely keyed outbox row. Duplicate wakes return the same logical result. A successful response returns the next alarm time; ambiguous responses can be retried under the same wake identity.

Use the existing provider-expanded occurrence ID within owner/calendar as stable identity. Persist a revision derived from canonical start, end and content; consent generation remains a separate authority check. Snapshot replacement invalidates changed or missing pending revisions in the same D1 transaction. Disable/disconnect invalidate pending claims before cleanup. `/api/status` must not prune due work.

Proposed MVP policy: seven-day synchronization horizon; target lateness at most 60 seconds. Starts more than 60 seconds late are retained as missed diagnostics rather than delivered automatically. Keep terminal metadata for seven days, purge content on revocation, and bound cleanup batches. Horizon advancement and watch renewal remain explicit resync/renewal until a separately verified lifecycle exists. These are proposed policies, not implemented behavior.

[Cloudflare's alarm documentation](https://developers.cloudflare.com/durable-objects/api/alarms/) describes durable alarms with at-least-once execution and retries. It does not establish Sites binding support or a 60-second lateness guarantee.

## Required E2E proof after the blocker is resolved

1. Provision the supported primitive and verify durable registration on the public Site before adding scheduler behavior.
2. Synchronize a disposable real timed Google occurrence, close all setup tabs and observe persisted due/outbox work; measure actual lateness.
3. Restart/redeploy between registration and start; repeat concurrent wakes and verify one logical outbox record per revision.
4. Move and cancel occurrences before claim, revoke grants during claim and verify stale work cannot dispatch. Verify status reads preserve already-due state.
5. Cover UTC offsets, an Australia/Sydney DST transition and distinct provider-expanded recurring instances against actual runtime storage. Keep all-day events excluded.
6. Demonstrate bounded retention, missed-start policy and the seven-day horizon. Signed callback delivery belongs to issues #4/#5.

## Current checks

22 automated tests pass, including the Workers/D1 E2E OAuth → discovery → explicit consent → watch → push create/edit/cancel → failure/recovery → revocation flow with a fake provider. These verify the predecessor behavior, not issue #3 timing. Hosted closed-browser due-work, restart and timing tests are blocked by the missing native primitive.

At 06:12:35 UTC, `scripts/check-ingress.mjs` passed against the public production Site: forged anonymous webhook reached application validation (403, ray `a45a4663fa37e8dc-SYD`); anonymous and forged-identity status/MCP calls returned 401. No valid calendar mutation was issued. Typecheck, lint and production build pass. The first sandboxed test run could not bind local sockets; the permitted rerun passed all 22 tests.
