# Schedule my agents

`schedule-my-agents` is a single-user, self-hosted calendar bridge that turns calendar invitations and timed occurrences into verified, webhook-driven MCP Events deliveries across any MCP Events-compatible agent host.

Read [STRATEGY.md](STRATEGY.md) for the approved project vision and accept/resist criteria.

## Implemented E2E MVP

- **Provider-neutral calendar adapter boundary** (`lib/calendar/providers.ts`) with a Google Calendar adapter (`lib/calendar/google.ts`, `lib/calendar/google-connection.ts`) and an opaque second test adapter.
- **Explicit calendar authorization**: connecting discovers calendars without enabling any of them; watches, sync cursors, alarms, invitations, receipts, and subscriptions bind to owner, connection identity, calendar grant, and consent generation.
- **Multi-agent guest email aliases & two-phase MCP Events**: register dedicated agent email aliases (`/api/agents/add`, `agent_aliases` tool) and add one or more agents as native calendar guests; each agent receives independent signed deliveries for onboarding (`calendar.event.invited`) and timed execution (`calendar.event.starting`) at start time or a declared `leadTimeMinutes` offset (0–1440).
- **External invite allowlist & owner approval gate**: only the owner and allowlisted organizers (`/api/allowlist/add`) may invite an agent alias; unallowlisted organizers are blocked at the integration layer, and allowlisted external invites require explicit owner approval (`/api/invitations/approve`) before `calendar.event.starting` or write-back executes.
- **Structured event provenance & opt-in narrow write-back**: canonical event payloads carry raw title/description alongside structured organizer/approval provenance; per-calendar opt-in write-back (`POST /api/calendars/write-back`, default off) exposes narrowly scoped `calendar_rsvp` and `calendar_run_note` MCP tools.
- **Opaque durable alarm dispatcher & unattended maintenance**: `dispatcher/` persists encrypted timed wakes with a five-minute late window and live provider revalidation at wake time; `CalendarMaintenance` (`lib/calendar/maintenance.ts`) runs on a `*/15 * * * *` cron trigger (and `POST /api/maintenance/run`) to renew owner-started watches within 24 hours of expiry, converge missed pushes every 15 minutes, and prune expired state.
- **Fail-closed single-user self-hosted auth** (`lib/calendar/auth.ts`): signed 24-hour `sma_session` cookie or `ADMIN_SECRET` bearer for `/api/*`, and a strictly separate `MCP_AUTH_TOKEN` bearer for `POST /mcp`.
- **Host-agnostic MCP Events endpoint** (`POST /mcp`): `server/discover`, `initialize`, `tools/list`, `tools/call` (`enabled_calendars`, `agent_aliases`, `calendar_rsvp`, `calendar_run_note`), `events/list`, `events/subscribe`, and `events/unsubscribe` with persisted subscriptions, signed challenges, and a signed retry outbox over validated-IP direct TLS (`tls-client/`).

Live hosted verification against production Cloudflare Workers, Google Calendar, and an external MCP Events host remains separate from local/fake-provider automated checks.

## Local development

Use Node 24:

```bash
npm ci
npm run dev
```

For a local Worker preview with D1:

```bash
npm run build
npm run db:local
npm start
```

Verification checks:

```bash
npm test
npm run typecheck
npm run lint
npm run build
```

For the opaque alarm dispatcher (`dispatcher/`):

```bash
cd dispatcher
npm ci
npm run typecheck
npm run build
```

## Configuration

Copy `.env.example` and configure runtime secrets on your self-hosted deployment:

| Variable | Purpose |
| --- | --- |
| `SITE_ORIGIN` | Exact HTTPS origin of the bridge (no trailing path) |
| `GOOGLE_CLIENT_ID` | Google Web OAuth client ID |
| `GOOGLE_CLIENT_SECRET` | Server-side OAuth client secret |
| `TOKEN_ENCRYPTION_KEY` | Base64-encoded 32 random bytes (`openssl rand -base64 32`) for AES-GCM |
| `GOOGLE_WEBHOOK_VERIFIED` | Set to `true` only after verifying unauthenticated provider webhook ingress |
| `DISPATCHER_ORIGIN` | Exact HTTPS origin of the deployed `dispatcher/` Worker |
| `ALARM_ENCRYPTION_KEY` | 32-byte base64 key kept on the bridge only (never shared with the dispatcher) |
| `ALARM_REGISTRATION_KEY` | Shared HMAC key for alarm registration |
| `ALARM_CALLBACK_KEY` | Shared HMAC key for alarm wake callbacks |
| `MCP_EVENTS_READY` | Set to `true` after migrations and transport checks pass to advertise `events/list` |
| `OWNER_ID` | Stable owner identity for this single-user bridge (default `owner`) |
| `ADMIN_SECRET` | Setup sign-in secret, also accepted as `Authorization: Bearer` on `/api/*` for scripts (`openssl rand -base64 32`) |
| `MCP_AUTH_TOKEN` | Bearer token your MCP Events agent host sends to `POST /mcp`; must differ from `ADMIN_SECRET` and never authorizes `/api/*` |
| `SESSION_SECRET` | Optional session-cookie signing material; defaults to `TOKEN_ENCRYPTION_KEY`, then `ADMIN_SECRET` |
| `TRUST_PROXY_AUTH_HEADER` | Set to `true` only behind a reverse proxy that strips and sets `x-authenticated-owner`; used when the matching secret above is unset |
| `GOOGLE_WRITE_SCOPE_ENABLED` | Set to `true` to request the Google write scope for opt-in RSVP and run-status write-back |

Without `ADMIN_SECRET` (or `TRUST_PROXY_AUTH_HEADER=true`) every setup route returns 401, and without `MCP_AUTH_TOKEN` (or proxy trust) `POST /mcp` returns 401. Sign in at `/` with `ADMIN_SECRET`; the session cookie lasts 24 hours. Configure your agent host to send `Authorization: Bearer <MCP_AUTH_TOKEN>`.

The Worker declares a `*/15 * * * *` cron trigger for unattended maintenance: it removes expired OAuth states, subscription attempts, and subscriptions, renews watches you started within 24 hours of expiry, and resyncs watched calendars whose last sync failed or is older than 15 minutes. It never starts a watch you did not start.

Register `<SITE_ORIGIN>/api/google/callback` as the Google OAuth redirect URI. Real Google OAuth and provider webhooks require an HTTPS `SITE_ORIGIN`; loopback `http://127.0.0.1` / `http://localhost` origins are accepted for local preview and verification only. Keep `TOKEN_ENCRYPTION_KEY` and `ALARM_ENCRYPTION_KEY` stable; rotating them without migrating encrypted records invalidates stored credentials or pending alarms.

Security notes:
- `ADMIN_SECRET` and `MCP_AUTH_TOKEN` must be distinct (and `MCP_AUTH_TOKEN` must not match `SESSION_SECRET` / `TOKEN_ENCRYPTION_KEY`); conflicting credentials fail closed across all routes.
- `MCP_AUTH_TOKEN` is a single host-level bearer token for this single-user bridge; it authorizes MCP discovery, subscriptions, and opt-in write-back tools, never setup routes (`/api/*`).
- Setting `GOOGLE_WRITE_SCOPE_ENABLED=true` requests Google's account-wide `calendar.events` write scope; keep it `false` unless you want opt-in RSVP and run-status write-back, and enable write-back only on specific calendars.
- Calendar-wide `calendar.event.starting` subscriptions (without `agentEmail`) only receive owner-organized events; agent subscriptions should always filter by a registered `agentEmail`.

## Further reading

- [STRATEGY.md](STRATEGY.md): approved vision and scope boundaries.
- [ARCHITECTURE.md](ARCHITECTURE.md): implemented provider, timing, and delivery boundaries.
- [GLOSSARY.md](GLOSSARY.md): calendar and authorization vocabulary.
- [docs/calendar-provider-contract.md](docs/calendar-provider-contract.md): provider adapter contract.
- [dispatcher/README.md](dispatcher/README.md): opaque alarm dispatcher setup.
- [tls-client/README.md](tls-client/README.md): validated-IP direct TLS callback client.
