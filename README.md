# Schedule my agents

Use Google Calendar as the scheduling interface for an agent through a publicly reachable ChatGPT Site with authenticated setup and owner-scoped calendar data. This prototype currently provides Google OAuth, calendar discovery, explicit consent, watch/sync code and an owner-scoped MCP calendar-list tool. Event-start delivery is planned.

Live OAuth, discovery and Personal consent have reached the hosted checkpoint. The user authorized public hosting to unblock Google push ingress. Local fake-provider tests do not prove live delivery. See [VERIFICATION.md](VERIFICATION.md) for current evidence and [docs/private-ingress.md](docs/private-ingress.md) for issue #2.

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

- [ARCHITECTURE.md](ARCHITECTURE.md): implemented seams and planned delivery.
- [GLOSSARY.md](GLOSSARY.md): calendar and authorization vocabulary.
- [AGENTS.md](AGENTS.md): contribution boundaries and completion checks.
- [docs/brief.md](docs/brief.md): original product brief.

Only timed occurrences within seven days are stored. Attendees, all-day events, cancellations and history are excluded. Google expands recurrence. Disabling deletes event contents and rejects late notifications before best-effort provider cleanup. A newly shared calendar stays disabled.

`POST /mcp` provides discovery, tools and `enabled_calendars`. The event catalog is empty and subscriptions fail explicitly until durable delivery exists. Calendar permission never authorizes an agent to execute event text.
