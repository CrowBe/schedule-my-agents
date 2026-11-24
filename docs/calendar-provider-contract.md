# Calendar provider contract

The common calendar path consumes `CalendarProvider`, not provider HTTP payloads. `ProviderAdapter` registers connection creation, authorization, notification decoding, cursor ordering, and an explicit verified-ingress gate. Google is the only production registration; the deterministic opaque adapter in the contract tests is a test fixture.

## Identities and authority

- A provider ID selects a registered adapter; unknown IDs fail closed.
- An owner has one active connection at a time. Changing providers or accounts requires disconnect first. New connections have a random saved connection ID; metadata returned to scheduling contains no stored credential.
- Calendar IDs and occurrence lookup IDs are opaque within that connection. Calendar grants remain owner/calendar scoped with a fresh consent generation. Shared scheduling includes owner, calendar, generation, and connection identity in its immutable work binding.
- Canonical occurrences carry provider, calendar, and lookup identity, actual timed start, optional series ID, and optional stable recurrence ID. Recurrence IDs may be opaque strings, not dates. Providers expand recurrence and normalize their own source shapes; shared alarms register only the current candidate and its successor after a valid wake.
- Watches, snapshots, occurrence receipts, and pending subscriber delivery must still belong to the same connection. Asynchronous provider calls, scheduling registration, and database commits recheck connection and consent. A replacement connection cannot inherit old source identifiers or pending work.

Google owns OAuth scopes, PKCE/state/cookie validation, encrypted credential retrieval, token refresh, and source-specific headers in `lib/calendar/google-connection.ts` and `lib/calendar/google.ts`. A 401 gets one access-token refresh within the adapter; repeated failure does not loop. Provider failures distinguish transient, lost authorization, and permanent rejection. Absent or cancelled occurrences produce no work. Google rate-limit 403 reasons are treated as transient rather than revoked authority. Error bodies are bounded and raw messages or credentials are not forwarded or logged.

## Notifications and recovery

Google uses `/api/google/webhook`; another configured adapter uses `/api/providers/<id>/webhook`. The adapter decodes source-specific notification shapes and owns cursor ordering. Common handling checks the saved channel token and resource, owner, generation, connection, and expiry before authoritative sync. Initial notifications do not race the watch bootstrap. Duplicate or out-of-order notifications do not overwrite a newer cursor or create authority. Tokens and calendar content stay out of diagnostics.

Failed or overlapping syncs surface a recovery warning until an uncontended resync succeeds. Never claim an adapter's ingress is verified solely because its registration exists.

## Migration and existing work

Migrations `0006`–`0008` add provider and connection metadata. Existing rows default to Google and an empty connection ID, recognized as a legacy connection using its owner and creation identity. No Google credential is rewritten or decrypted by a migration. New OAuth connections get a random ID.

Existing v1 encrypted alarm fields and Google logical-ID material remain readable. Legacy alarms and receipts are accepted only with their migrated original connection; a newly connected account cannot claim them. Existing callback bodies remain frozen in the delivery ledger. All alarm expiry remains five minutes after occurrence start.

Google recurrence timestamps are normalized to equivalent UTC identities while opaque providers retain their literal slot IDs. Atomic source-occurrence dedup routes equivalent offset-based and canonicalized jobs to the original receipt. Callback instant comparison uses UTC so equivalent start/end offsets do not discard pending work.

## Adding another production provider

Implement `CalendarProvider` for discovery, watches, stop, authoritative sync, candidate selection, occurrence lookup, and next-instance expansion. Register a connection factory, provider-owned authorization module when needed, notification decoder, and cursor comparison. The adapter must enforce provider-specific signature or body validation before returning a normalized change; common channel and consent checks add to that validation.

Give connection creation a distinct provider ID and saved random connection ID, keep credentials within the adapter, and leave all discovered calendars disabled until explicitly enabled. Generic registered authorization routes are `/api/providers/<id>/connect` and `/api/providers/<id>/callback`; only the authenticated owner reaches them, and connect requires the configured bridge origin. Verify logged-out provider ingress before enabling that adapter's readiness gate, and run the shared persisted-state contract tests alongside provider-specific authentication and live checks.
