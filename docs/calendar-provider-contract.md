# Calendar provider contract

The common calendar path consumes `CalendarProvider`, not provider HTTP payloads. `ProviderAdapter` registers connection creation, authorization, notification decoding, cursor ordering and an explicit verified-ingress gate. Google is the only production registration. The deterministic opaque adapter in the contract tests is a test fixture, not a second production connection.

## Identities and authority

- A provider ID selects a registered adapter; unknown IDs fail closed.
- An owner has one active connection in this release. Changing providers/accounts requires disconnect first. New connections have a random saved connection ID; metadata returned to scheduling contains no stored credential.
- Calendar IDs and occurrence lookup IDs are opaque within that connection. Calendar grants remain owner/calendar scoped with a fresh consent generation. Shared scheduling includes owner, calendar, generation and connection identity in its immutable work binding.
- Canonical occurrences carry provider, calendar and lookup identity, actual timed start, optional series ID and optional stable recurrence ID. Recurrence IDs may be opaque strings, not dates. Providers expand recurrence and normalize their own source shapes; shared alarms register only the current candidate and its successor after a valid wake.
- Watches, snapshots, occurrence receipts and pending subscriber delivery must still belong to the same connection. Asynchronous provider calls, scheduling registration and database commits recheck connection and consent. A replacement connection cannot inherit old source identifiers or pending work.

Google owns OAuth scopes, PKCE/state/cookie validation, encrypted credential retrieval, token refresh and source-specific headers in `google-connection.ts`/`google.ts`. A 401 gets one access-token refresh within the adapter; repeated failure does not loop. Provider failures distinguish transient, lost authorization and permanent rejection. Absent/cancelled occurrences produce no work. Google rate-limit 403 reasons are treated as transient, rather than revoked authority. Error bodies are bounded and raw messages/credentials are not forwarded or logged. See [Google error guidance](https://developers.google.com/workspace/calendar/api/guides/errors).

## Notifications and recovery

Google keeps `/api/google/webhook`; another configured adapter uses `/api/providers/<id>/webhook`. The adapter decodes source-specific notification shape and owns cursor ordering. Common handling checks the saved channel token/resource, owner, generation, connection and expiry before authoritative sync. Initial notifications do not race the watch bootstrap. Duplicate/out-of-order notifications do not overwrite a newer cursor or create authority. Tokens and calendar content stay out of diagnostics.

The current production recovery policy remains explicit: failed/overlapping sync surfaces a recovery warning; owners can resync an active watch and start/renew a watch. No new periodic scheduler is introduced. Further renewal/missed-push recovery work is tracked in the reliability checklist. Never claim an adapter's ingress verified solely because its registration exists.

## Migration and existing work

Migrations 0006–0008 add provider/connection metadata. Existing rows default to Google and an empty connection ID, recognized as a legacy connection using its owner and creation identity. No Google credential is rewritten or decrypted by a migration. New OAuth connections get a random ID.

Existing v1 encrypted alarm fields and Google logical-ID material remain readable. Legacy alarms/receipts are accepted only with their migrated original connection; a newly connected account cannot claim them. The deployed legacy alarm ID is checked against the unchanged PR #15 implementation. Existing callback bodies remain frozen in the delivery ledger. All alarm expiry remains exactly five minutes after occurrence start.

Google recurrence timestamps are normalized to equivalent UTC identities while opaque providers retain their literal slot IDs. A deployed offset-based job can have a different alarm ID from a newly canonicalized job; atomic source-occurrence dedup routes both to the original receipt. Callback instant comparison uses UTC so equivalent start/end offsets do not discard pending work. Already persisted callback bodies are still sent unchanged.

## Adding another production provider

Implement the existing `CalendarProvider` for discovery, watches, stop, authoritative sync, candidate selection, occurrence lookup and next-instance expansion. Register a connection factory, provider-owned authorization module when needed, notification decoder and cursor comparison. The adapter must enforce any provider-specific signature/body validation before returning a normalized change; the common channel/consent checks add to that validation.

Give connection creation a distinct provider ID and saved random connection ID, keep credentials within the adapter, and leave all discovered calendars disabled until explicitly enabled. A generic registered authorization route is `/api/providers/<id>/connect` and `/callback`; only authenticated owners reach it, and connect requires the original Site origin. Match the provider's sign-in/redirect/consent requirements and add its own user-facing setup. Verify logged-out provider ingress on the existing Site before enabling that adapter's readiness gate.

Run the common persisted-state scheduling/delivery contracts, source-specific normalization/authentication tests and live provider acceptance. The test adapter does not establish another provider's production compatibility. The native callback connection-level assurance gap remains separate and does not block this interface work.
