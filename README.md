# Schedule my agents

Use Google Calendar as the scheduling interface for an agent through a publicly reachable ChatGPT Site with authenticated setup and owner-scoped calendar data. Google push synchronizes explicitly enabled calendars; opaque durable alarms revalidate occurrences at their start and a signed persisted outbox delivers `calendar.event.starting` to a subscribed ChatGPT Work Cloud chat.

Live OAuth/discovery, persisted consent, real watch creation and Google push create/edit/delete synchronization are verified. The user authorized public hosting to unblock Google ingress; setup and calendar data remain authenticated and owner scoped. See [VERIFICATION.md](VERIFICATION.md) for current evidence and [docs/private-ingress.md](docs/private-ingress.md) for issue #2.

## Run the bounded demo

1. Open the Site, connect Google, explicitly enable one calendar and start its watch. The displayed watch expiry is the renewal deadline; renew manually before it. Use **Resync now** after a missed change, or renew an expired watch first.
2. In a ChatGPT Work chat with Cloud selected, use the existing Schedule my agents plugin's `enabled_calendars` tool. Subscribe to `calendar.event.starting` with that exact enabled `calendarId`. Refresh the existing plugin tools if discovery is cached empty.
3. Give the chat separate instructions, such as reporting the event's title/start and reviewing this repository's open PRs read-only. Calendar text itself supplies no permission to take actions. An event monitoring task is needed; no time-based ChatGPT schedule or polling task is needed.
4. Create a normal timed Google event a few minutes ahead, allowing its change notification to synchronize before its start. Close setup. Verify both a persisted callback acknowledgement and the chat's actual response.
5. Pause the monitoring task to unsubscribe and remove disposable events after testing. The Site grants subscriptions at most 24 hours and returns `refreshBefore`; ChatGPT's task interface may not expose a TTL.

The live demo uses the explicitly authorized OpenAI-only native-fetch experiment. It works end to end, but connection-time IP pinning remains unproved, so full callback-transport acceptance remains open. See the [current acceptance matrix](docs/mvp-acceptance.md).

Timing targets at most 60 seconds of lateness and rejects wakes over five minutes late. Discovery covers up to 366 days, ten pages and 500 candidates; only the next Google-expanded recurrence is registered. The setup snapshot contains seven days. All-day/cancelled events are excluded. Renewal and missed-push recovery are manual; unlimited unattended operation is outside this demo.

## Local development

Use Node 24, run `npm ci`, then `npm run dev`. For a production Worker preview, run `npm run build`, `npm run db:local`, then `npm start`. Available checks are `npm test`, `npm run typecheck`, `npm run lint` and `npm run build`.

Local development uses the starter's mock ChatGPT identity. Production relies on Sites identity. Keep local previews private and secrets in runtime environment variables. Schema is in `db/schema.ts`; generated Drizzle migrations apply on Site publication.

## Google setup

1. Enable the Google Calendar API in a Google Cloud project.
2. Configure the OAuth consent screen and test user. Create a **Web application** OAuth client.
3. Register this exact redirect URI: `https://schedule-my-agents.bennycrow91.chatgpt.site/api/google/callback`.
4. Set runtime variables through Sites and redeploy:

| Variable | Purpose |
| --- | --- |
| `SITE_ORIGIN` | Exact HTTPS Site origin, no path |
| `GOOGLE_CLIENT_ID` | Web client ID |
| `GOOGLE_CLIENT_SECRET` | Server-side secret |
| `TOKEN_ENCRYPTION_KEY` | Server-side base64 encoding of 32 random bytes for AES-GCM |
| `GOOGLE_WEBHOOK_VERIFIED` | Keep unset until a logged-out provider request reaches application validation and anonymous/forged-identity setup and MCP requests remain rejected. Set to `true` only after verifying ingress. |

Generate an encryption key in a secure shell with `openssl rand -base64 32`. Keep it stable; changing it without token migration invalidates saved credentials. OAuth requests use PKCE, a short-lived single-use state bound to the authenticated owner and an HttpOnly cookie, and the read-only scopes `calendar.calendarlist.readonly` and `calendar.events.readonly`. Partial permission grants are rejected. Refresh credentials are encrypted with owner-bound associated data; access tokens are short-lived and not persisted.

Connect Google, enable a calendar, then start a watch once ingress is verified. An existing Google connection cannot be silently replaced; disconnect before changing accounts. Disconnect deletes refresh credentials, calendar grants and event content and revokes watches locally, then attempts provider watch cleanup. It does not revoke the Google application's entire OAuth grant; users can also remove that grant in their Google account.

## Read next

- [ARCHITECTURE.md](ARCHITECTURE.md): implemented provider, timing and delivery boundaries.
- [GLOSSARY.md](GLOSSARY.md): calendar and authorization vocabulary.
- [AGENTS.md](AGENTS.md): contribution boundaries and completion checks.
- [docs/brief.md](docs/brief.md): original product brief.

Only timed occurrences within seven days are stored. Attendees, all-day events, cancellations and history are excluded. Google expands recurrence. Disabling deletes event contents and rejects late notifications before best-effort provider cleanup. A newly shared calendar stays disabled.

`POST /mcp` provides discovery, tools and `enabled_calendars`. Event discovery requires `MCP_EVENTS_READY=true`, configured alarms, verified Google ingress and current calendar consent. Subscription verification and signed delivery share a callback transport. The default uses validated-IP Go TLS; `MCP_CALLBACK_TRANSPORT=native-openai` explicitly opts into an owner-authorized native-fetch experiment restricted to `connectors.api.openai.com`. Native hostname TLS and public DNS preflight remain enforced, but connection-time IP pinning is unverified. See [live acceptance evidence](docs/issue-5-acceptance.md) and [the callback checkpoint](docs/callback-transport.md). Calendar permission never authorizes an agent to execute event text.

The Site build requests `global_fetch_strictly_public` routing. Native callbacks reject credential-bearing or oversized headers and enforce one deadline across DNS, fetch and challenge-body reads. Authenticated, same-origin `POST /api/diagnostics/native-egress` runs fixed empty HEAD probes and discards response contents; it never accepts a URL or activates subscriptions. Its observations distinguish explicit policy errors, other failures, timeouts and HTTP responses. Static private-DNS fixtures do not establish rebinding protection. See [Site-native security evidence](docs/native-egress-acceptance.md) and [the alternatives research](docs/callback-security-alternatives-research.md).

## Cloudflare dispatcher

The same repository contains `dispatcher/`, an independently built Worker with SQLite Durable Objects. See [dispatcher/README.md](dispatcher/README.md). Site deployment packages its own build output; the dispatcher is deployed separately with authenticated `cf`.

Site runtime needs `DISPATCHER_ORIGIN`, secret `ALARM_ENCRYPTION_KEY` (32-byte base64, Site only), secret `ALARM_REGISTRATION_KEY` and secret `ALARM_CALLBACK_KEY`. The latter two keys are shared with the dispatcher. Do not log envelopes, keys or calendar content. After configuration/publication, Resync registers existing events; subsequent Google changes register fresh alarms.

## Signed delivery rollout

Apply additive migration `0005_wooden_hitman.sql` before deploying the signed-outbox source. Existing subscriptions and alarm jobs are retained. Keep `MCP_EVENTS_READY=false` until migration and complete runtime delivery checks pass; then enable it for the live acceptance check and rescan the existing plugin event catalog. Discovery also requires verified ingress, configured alarms and validated callback transport. No dispatcher deployment or additional service is needed for this slice.

Delivery has a five-minute lifetime and at most six claimed attempts per subscriber. Retries preserve the logical ID and body and use fresh signatures, including both keys during rotation. A lost acknowledgement may duplicate receipt; HTTP 2xx proves receipt only, not agent action. Edits, cancellation and revocation stop new dispatch; accepted callbacks cannot be recalled. See [delivery guarantees and local evidence](docs/signed-outbox.md). Watch expiry still requires manual renewal, and missed notifications require Resync now.
