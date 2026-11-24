# Schedule my agents

`schedule-my-agents` is a single-user, self-hosted calendar bridge that turns calendar invitations and timed occurrences into verified, webhook-driven MCP Events deliveries across any MCP Events-compatible agent host.

Read [STRATEGY.md](STRATEGY.md) for the approved project vision and accept/resist criteria.

## Current state vs. vision

Implemented foundation:
- Provider-neutral calendar adapter boundary (`lib/calendar/providers.ts`) with a Google Calendar adapter (`lib/calendar/google.ts`, `lib/calendar/google-connection.ts`).
- Explicit calendar authorization: connecting discovers calendars without enabling them; watches, sync cursors, alarms, receipts, and subscriptions bind to owner, connection identity, calendar grant, and consent generation.
- Opaque Cloudflare Durable Object alarm dispatcher (`dispatcher/`) for durable timed wakes with a five-minute late window and provider revalidation at wake time.
- Fail-closed single-user authentication (`lib/calendar/auth.ts`): a signed admin session or admin bearer secret for `/api/*`, and a separate MCP bearer token for `POST /mcp`.
- Host-agnostic MCP Events endpoint (`POST /mcp`) supporting `server/discover`, `initialize`, `tools/list`, `tools/call` (`enabled_calendars`), `events/list`, `events/subscribe`, and `events/unsubscribe` with persisted subscriptions, signed challenges, and a signed retry outbox over validated-IP direct TLS (`tls-client/`).

Not yet built toward [STRATEGY.md](STRATEGY.md):
- Adding one or more agents via native guest email aliases and routing independent deliveries per agent.
- Two-phase MCP Events lifecycle (immediate invitation event for agent-side task onboarding plus timed start or lead-time occurrence triggers).
- Owner-configured allowlist blocking unallowlisted external invite organizers at the integration layer.
- Structured event provenance in canonical payloads and extensible owner-authorized write-back (RSVP and brief run-status notes).
- Wiring `CalendarMaintenance` (`lib/calendar/maintenance.ts`) into `CalendarService.runMaintenance` so the 15-minute cron trigger performs unattended watch renewal and missed-push convergence.

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

Register `<SITE_ORIGIN>/api/google/callback` as the Google OAuth redirect URI. Keep `TOKEN_ENCRYPTION_KEY` and `ALARM_ENCRYPTION_KEY` stable; rotating them without migrating encrypted records invalidates stored credentials or pending alarms.

## Further reading

- [STRATEGY.md](STRATEGY.md): approved vision and scope boundaries.
- [ARCHITECTURE.md](ARCHITECTURE.md): implemented provider, timing, and delivery boundaries.
- [GLOSSARY.md](GLOSSARY.md): calendar and authorization vocabulary.
- [docs/calendar-provider-contract.md](docs/calendar-provider-contract.md): provider adapter contract.
- [dispatcher/README.md](dispatcher/README.md): opaque alarm dispatcher setup.
- [tls-client/README.md](tls-client/README.md): validated-IP direct TLS callback client.
