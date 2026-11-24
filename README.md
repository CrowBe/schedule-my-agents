# Schedule my agents

`schedule-my-agents` is a single-user, self-hosted calendar bridge that turns calendar invitations and timed occurrences into verified, webhook-driven MCP Events deliveries across any MCP Events-compatible agent host.

Read [STRATEGY.md](STRATEGY.md) for the approved project vision and accept/resist criteria.

## Current state vs. vision

Implemented foundation:
- Provider-neutral calendar adapter boundary (`lib/calendar/providers.ts`) with a Google Calendar adapter (`lib/calendar/google.ts`, `lib/calendar/google-connection.ts`).
- Explicit calendar authorization: connecting discovers calendars without enabling them; watches, sync cursors, alarms, receipts, and subscriptions bind to owner, connection identity, calendar grant, and consent generation.
- Opaque Cloudflare Durable Object alarm dispatcher (`dispatcher/`) for durable timed wakes with a five-minute late window and provider revalidation at wake time.
- Host-agnostic MCP Events endpoint (`POST /mcp`) supporting `server/discover`, `initialize`, `tools/list`, `tools/call` (`enabled_calendars`), `events/list`, `events/subscribe`, and `events/unsubscribe` with persisted subscriptions, signed challenges, and a signed retry outbox over validated-IP direct TLS (`tls-client/`).

Not yet built toward [STRATEGY.md](STRATEGY.md):
- Adding one or more agents via native guest email aliases and routing independent deliveries per agent.
- Two-phase MCP Events lifecycle (immediate invitation event for agent-side task onboarding plus timed start or lead-time occurrence triggers).
- Owner-configured allowlist blocking unallowlisted external invite organizers at the integration layer.
- Structured event provenance in canonical payloads and extensible owner-authorized write-back (RSVP and brief run-status notes).
- Unattended background watch renewal and missed-push convergence.
- Self-hosted authentication boundary replacing the reverse-proxy `x-authenticated-owner` header.

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

Register `<SITE_ORIGIN>/api/google/callback` as the Google OAuth redirect URI. Keep `TOKEN_ENCRYPTION_KEY` and `ALARM_ENCRYPTION_KEY` stable; rotating them without migrating encrypted records invalidates stored credentials or pending alarms.

## Further reading

- [STRATEGY.md](STRATEGY.md): approved vision and scope boundaries.
- [ARCHITECTURE.md](ARCHITECTURE.md): implemented provider, timing, and delivery boundaries.
- [GLOSSARY.md](GLOSSARY.md): calendar and authorization vocabulary.
- [docs/calendar-provider-contract.md](docs/calendar-provider-contract.md): provider adapter contract.
- [dispatcher/README.md](dispatcher/README.md): opaque alarm dispatcher setup.
- [tls-client/README.md](tls-client/README.md): validated-IP direct TLS callback client.
