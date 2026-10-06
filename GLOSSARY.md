# Calendar bridge language

**Connection**: An owner's authorization to read Google Calendar through an offline Google grant. It does not enable calendars.

**Discovered calendar**: A calendar visible to the connected Google account. It remains inactive until explicitly enabled.

**Calendar grant**: The owner's explicit permission to process one calendar. Disabling or disconnecting removes this authority.

**Consent generation**: The identity of a particular calendar grant, distinguishing it from a later re-enablement of the same calendar.

**Watch**: An expiring Google notification channel for one explicitly enabled calendar. It signals collection changes, not event starts.

**Notification**: A provider message identifying a changed watched resource. It contains no event contents. Change notifications require a subsequent sync; the initial channel notification is acknowledged while watch creation fetches the first snapshot.

**Occurrence**: One timed calendar event instance, including an expanded recurring instance. All-day and cancelled events are excluded from this slice.

**Canonical snapshot**: The current bounded set of upcoming occurrences for an enabled calendar. A successful sync replaces it, so edits and cancellations remove stale contents.

**Sync**: Fetching current provider state and replacing the canonical snapshot under the current calendar grant.

**Event-start delivery**: A signed notification to an MCP subscriber when an occurrence starts. Google change notifications alone do not provide it.

**Opaque alarm**: Immutable durable timer carrying encrypted occurrence coordinates and public UTC timing metadata. Old alarms require no cancellation.

**Logical alarm ID**: A Site-keyed opaque identifier for one occurrence, start and consent generation, reused for idempotent registration.

**Due work**: A unique owner-scoped receipt containing content freshly fetched and validated at the occurrence start, consumed by bounded subscriber delivery.

**Subscription**: An owner- and consent-generation-scoped, finite permission to notify a verified callback about one enabled calendar. It grants no authority to execute calendar text.

**Callback transport**: The connection boundary that validates public destination addresses, pins the connection and retains hostname TLS verification. It must be shared by verification and event delivery.

**Delivery attempt**: A leased network attempt for one frozen subscriber and logical event. Its immutable body survives retries; an accepted receipt does not prove agent execution.
