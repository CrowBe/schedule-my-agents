# Architecture

The calendar is the scheduling interface. The public ChatGPT Site owns authentication, Google OAuth, calendar consent, MCP and D1. A separately deployed Cloudflare Worker stores opaque immutable alarms. Both deployments share this repository.

## Authority and scheduling

`CalendarService` orchestrates consent and sync; `GoogleCalendar` owns Google HTTP and recurrence expansion; `Store` guards D1 commits. Provider push is authenticated using the persisted channel and current consent generation, independently of visitor identity headers.

After a successful sync, the Site registers future standalone events and the next instance of each recurring series. Each alarm contains a random-IV AES-GCM envelope, opaque HMAC identity, UTC due time and five-minute expiry. Only the Site holds the encryption key. Owner, calendar, grant generation and occurrence identifiers stay encrypted; event text never enters the envelope. Registration and callbacks use separate timestamped HMAC keys. Cloudflare cannot choose a callback destination.

Changes register fresh alarms. Old alarms expire naturally. At wake, the Site decrypts, checks current connection and consent, and fetches the actual Google occurrence. Cancelled, moved, revoked or overdue occurrences are acknowledged without due work. A valid recurring occurrence registers only its next Google-expanded instance, then claims a unique due-work row. A stale alarm never advances a series. Google change handling seeds the new schedule.

The scheduling path needs no calendar-event database: the seven-day snapshot remains a setup/sync demonstration. The due-work ledger retains freshly revalidated content for subsequent delivery, with a guarded unique insert preventing duplicates after retries or restarts. Revocation deletes stored contents and blocks concurrent claims. Google reads cannot be atomic with remote edits; an edit immediately after revalidation remains a provider race.

## Bounds and recovery

Target lateness is 60 seconds; callbacks within five minutes are accepted. The durable dispatcher persists retries with exponential delay up to 60 seconds and discards expired work. It keeps an opaque tombstone until one day after expiry, then sends an expired cleanup callback and deletes its state. Cleanup retries for five minutes; a Site outage can leave receipts until later claims prune records older than seven days. Logs contain opaque tags, outcomes and timing, not event content or envelopes.

Discovery is bounded to 366 days, ten pages and 500 candidate events/series; overflow fails explicitly. Registration failure surfaces recovery rather than silently declaring scheduling complete. Resync retries registration. Lost Google pushes and expiring watches still need manual recovery/renewal. Encryption-key rotation requires pending-alarm migration or deliberate reseeding.

## Subscriber delivery

Owner-scoped MCP subscription persistence and signed challenge verification are implemented behind an injectable callback transport. The Site Worker wires a Go standard TLS WASM adapter over validated-IP raw sockets; no forwarding service is used. Hosted synthetic TLS succeeds; real ChatGPT callback acceptance remains outstanding; see [callback transport checkpoint](docs/callback-transport.md). Signed delivery now consumes due work through a persisted per-subscription ledger driven by the same opaque alarm retries. Immutable bodies and logical IDs survive restart; bounded leases, backoff and attempt limits prevent concurrent claims and unbounded retries. Every wake revalidates the provider occurrence and each attempt rechecks current consent and subscription authority. See [signed outbox](docs/signed-outbox.md). `calendar.event.starting` discovery requires the explicit hosted-readiness gate. Explicit subscription requests must complete callback verification under current consent. Local callback acceptance is tested; a hosted ChatGPT response remains unproved. Calendar text grants no execution authority.
