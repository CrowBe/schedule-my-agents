# Architecture

`schedule-my-agents` is a single-user, self-hosted calendar bridge that turns calendar events into verified, webhook-driven MCP Events deliveries for any MCP Events-compatible agent host. The primary Worker owns calendar authorization, provider sync, D1 persistence, setup UI, and `POST /mcp`. A separately deployed Cloudflare Worker (`dispatcher/`) stores opaque immutable alarms. Both deployments share this repository.

## Authority and scheduling

Provider registration (`lib/calendar/providers.ts`) owns credential refresh, authorization routes, change decoding, and cursor ordering. Notification ordering is rechecked under the sync lock; cursor commits happen before releasing the lock, after snapshot and alarm registration succeed. Snapshot/cursor writes and lock cleanup are fenced to the acquired lease so an expired sync cannot overwrite or unlock its successor. Shared occurrences use provider-neutral series and recurrence IDs, and persistence binds watches, snapshots, alarms, and receipts to a saved provider and connection identity. One active connection per owner is retained; replacing a connection requires disconnect and fresh consent. See [docs/calendar-provider-contract.md](docs/calendar-provider-contract.md).

`CalendarService` orchestrates consent, sync, and MCP requests; `GoogleCalendar` (`lib/calendar/google.ts`) owns Google HTTP and recurrence expansion; `Store` (`lib/calendar/store.ts`) guards D1 commits. Provider push is authenticated using the persisted watch channel and current consent generation, independently of caller identity headers. Authenticated owner requests currently read `x-authenticated-owner`, which must only be trusted when a reverse proxy or auth boundary strips caller-supplied headers.

After a successful sync, the bridge registers future standalone events and the next instance of each recurring series. Each alarm carries a random-IV AES-GCM envelope, opaque HMAC identity, UTC due time, and five-minute expiry. Only the bridge holds `ALARM_ENCRYPTION_KEY`. Owner, calendar, grant generation, and occurrence identifiers stay encrypted; event text never enters the envelope. Registration and wake callbacks use separate timestamped HMAC keys.

At wake time, the bridge decrypts the envelope, rechecks current connection and consent, and fetches the live occurrence from the provider. Cancelled, moved, revoked, or overdue occurrences are acknowledged without creating due work. A valid recurring occurrence registers only its next provider-expanded instance, then atomically claims a unique due-work row in `occurrence_outbox`. A stale alarm never advances a series.

## Bounds and recovery

Discovery is bounded to 366 days, ten pages, and 500 candidate events or series; overflow fails explicitly. Callbacks within five minutes of start are accepted; the durable dispatcher persists retries with exponential delay up to 60 seconds and discards expired work after retaining a one-day tombstone and attempting cleanup. Logs contain opaque tags, outcomes, and timing, never event content, secrets, or envelopes.

## Subscriber delivery

Owner-scoped MCP subscriptions (`lib/calendar/subscriptions.ts`) persist encrypted signing secrets, finite expiry, key rotation, and idempotent unsubscribe in D1. Subscription verification and signed delivery share a validated-IP callback transport (`lib/calendar/callback-transport.ts`) backed by Go standard TLS/X.509 compiled to WASM (`tls-client/`) over raw TCP sockets to validated public IP addresses with original-hostname TLS verification.

Signed delivery (`lib/calendar/delivery.ts`) consumes due work through a persisted per-subscription ledger (`deliveries`) driven by the opaque alarm retries. Immutable serialized payloads and logical `evt_` IDs survive restarts; bounded leases, exponential backoff with injectable equal jitter, supported `Retry-After` hints, and a six-attempt limit bound retries within the five-minute lifetime. Every wake revalidates the provider occurrence, and each attempt rechecks current connection, calendar grant, and subscription authority before sending. Accepted HTTP 2xx receipts prove webhook delivery only, not agent execution. Event discovery (`events/list`) stays closed unless `MCP_EVENTS_READY=true`, alarms are configured, provider ingress is verified, and an enabled calendar grant exists.
