# Schedule my agents

Hypothesis: an existing calendar can become the native scheduling interface for an AI agent through MCP Events, without a second task scheduler UI.

**First vertical slice: Google OAuth → discover → explicit calendar consent → watch → validated notification → upcoming canonical events in D1.** The real Google adapter and HTTP routes are implemented. Automated integration tests exercise this chain against SQLite and a fake provider. Live Google authorization and watch delivery are pending credentials and hosted ingress verification. This is not yet the event-start/ChatGPT wake-up demo.

## Architecture

One ChatGPT Site contains the setup UI, server routes, MCP endpoint and D1 persistence. It uses the bundled Sites Vinext/Workers runtime; there is no separately provisioned Cloudflare account, Vercel deployment or external database.

```
User → Site setup → Google OAuth → calendar discovery
                           ↓ explicit consent only
Google Calendar → watch → POST /api/google/webhook
                           ↓ validate channel + resource + consent
                    Google adapter → upcoming canonical events → D1

ChatGPT → POST /mcp → enabled_calendars (read only)

Future, currently blocked:
D1 occurrence → durable Site timer → signed MCP callback → ChatGPT
```

Google sends resource-change notifications, not notifications when an event starts. The implementation never treats a change webhook as `calendar.event.starting`.

## Run and verify

Node 24 is recommended (the integration tests use Node's SQLite and TypeScript transform support).

```sh
npm ci
npm test
npm run typecheck
npm run lint
npm run build
npm run dev
```

Production builds use the Sites starter. D1 schema lives in `db/schema.ts`; checked-in Drizzle migrations apply at Site publication. For local persistence, apply migrations to the local database configured by the build:

```sh
npm run db:local
```

The starter uses a mock ChatGPT identity in development only. Direct local API requests can supply the mock user header for testing; never expose the local dev server as a production backend. In production only the trusted Sites authentication boundary supplies identity. Secrets belong in Site runtime environment variables, never browser code or the hosting manifest.

## Google setup

1. Enable the Google Calendar API in a Google Cloud project.
2. Configure the OAuth consent screen and test user. Create a **Web application** OAuth client.
3. Register this exact redirect URI: `https://schedule-my-agents.red-wasp-7440.chatgpt.site/api/google/callback`.
4. Set runtime variables through Sites and redeploy:

| Variable | Purpose |
| --- | --- |
| `SITE_ORIGIN` | Exact HTTPS Site origin, no path |
| `GOOGLE_CLIENT_ID` | Web client ID |
| `GOOGLE_CLIENT_SECRET` | Server-side secret |
| `TOKEN_ENCRYPTION_KEY` | Server-side base64 encoding of 32 random bytes for AES-GCM |
| `GOOGLE_WEBHOOK_VERIFIED` | Keep unset until a real unauthenticated Google POST reaches the private Site. Set to `true` only after verifying ingress. |

Generate an encryption key in a secure shell with `openssl rand -base64 32`. Keep it stable; changing it without token migration invalidates saved credentials. OAuth requests use PKCE, a short-lived single-use state bound to the authenticated owner and an HttpOnly cookie, and the read-only scopes `calendar.calendarlist.readonly` and `calendar.events.readonly`. Partial permission grants are rejected. Refresh credentials are encrypted with owner-bound associated data; access tokens are short-lived and not persisted.

Connect Google, enable a calendar, then start a watch once ingress is verified. An existing Google connection cannot be silently replaced; disconnect before changing accounts. Disconnect deletes refresh credentials, calendar grants and event content and revokes watches locally, then attempts provider watch cleanup. It does not revoke the Google application's entire OAuth grant; users can also remove that grant in their Google account.

## Authorization and data boundaries

Discovery does not create calendar grants or watches. New/shared calendars default disabled. Enable rechecks Google access. Every watch and sync verifies owner, calendar and consent generation. Disabling deletes event content and revokes delivery locally before contacting Google. Webhooks require the unguessable channel token, channel ID, provider resource ID, unexpired watch and current explicit grant; content never provides authority.

Only timed occurrences in a seven-day window are normalized. Google expands recurrence; there is no custom recurrence engine. All-day events, cancelled occurrences, attendees and calendar history are excluded. Snapshot replacement handles edits and cancellation. This bounded window is a **setup/sync proof**, not a complete occurrence scheduler: it will not advance without a notification or manual renewal. Storage contains only refresh credentials, consent, short-lived OAuth state, watch metadata and the bounded upcoming snapshot. There is no event-content read tool yet. Tokens are never returned to the UI.

## MCP contract in this commit

`POST /mcp` implements MCP 2.0 `server/discover` (`2026-07-28`), `tools/list`, `tools/call`, and an authenticated, owner-scoped `enabled_calendars` tool. Legacy initialization is included for tool clients.

`events/list` returns an empty catalog; `events/subscribe` rejects calendars the caller has not enabled and fails explicitly for enabled calendars because event-start delivery is unavailable. No callback secrets or subscriptions are accepted/stored. This avoids promising a subscription that cannot deliver.

The next slice must implement the current [OpenAI MCP Events contract](https://developers.openai.com/plugins/build/mcp-events): deterministic subscription identity, persistent owner/filter/expiry/secret state, callback challenge verification, Standard Webhooks signing and secret rotation, public-address validation at connection time, no redirects, bounded retries with stable event IDs, expiry and revocation checks. Planned event: `calendar.event.starting`; required filter: `calendarId`; payload: `{ calendarId, eventId, title?, description?, start, end? }`. Calendar content remains untrusted data; the user's separate ChatGPT subscription instructions decide the response.

## Limitations and next checkpoint

See [VERIFICATION.md](VERIFICATION.md) for evidence and unresolved platform capabilities. Automatic watch renewal, durable event-start timers, safe callback transport, MCP subscriptions and ChatGPT wake-up are not implemented. Manual watch renewal is available after ingress is verified. Overlapping syncs are rejected using a bounded D1 lease; a failed notification may require manual watch renewal because Google does not guarantee retries. No external infrastructure has been added. The smallest potential fallback is described in the verification notes, contingent on confirming the missing Site capability.
