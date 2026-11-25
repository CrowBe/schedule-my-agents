# Calendar bridge language

**Connection**: An owner's authorization to access a calendar provider through an offline grant. It does not enable calendars.

**Provider adapter**: The registered implementation of connection authorization, calendar operations, source notification decoding, and cursor ordering. Google is the production adapter; an opaque second adapter proves the shared test contract.

**Connection identity**: A saved provider ID and connection ID, distinct from owner, calendar, and occurrence IDs. Replacement connections cannot inherit immutable work from an earlier connection.

**Recurrence identity**: A provider-owned stable slot within a series, retained when the actual start moves. It may be an opaque string; common scheduling does not expand recurrence rules.

**Discovered calendar**: A calendar visible to the connected provider account. It remains inactive until explicitly enabled.

**Calendar grant**: The owner's explicit permission to process one calendar. Disabling or disconnecting removes this authority.

**Consent generation**: The identity of a particular calendar grant, distinguishing it from a later re-enablement of the same calendar.

**Watch**: An expiring provider notification channel for one explicitly enabled calendar. It signals collection changes, not event starts.

**Notification**: A provider message identifying a changed watched resource. It contains no event contents. Change notifications require a subsequent sync; the initial channel notification is acknowledged while watch creation fetches the first snapshot.

**Occurrence**: One timed calendar event instance, including an expanded recurring instance. All-day and cancelled events are excluded.

**Canonical snapshot**: The current bounded set of upcoming occurrences for an enabled calendar. A successful sync replaces it, so edits and cancellations remove stale contents.

**Sync**: Fetching current provider state and replacing the canonical snapshot under the current calendar grant.

**Event delivery**: A signed webhook notification to an MCP Events subscriber. Provider change notifications alone do not supply timed triggers.

**Opaque alarm**: An immutable durable timer carrying encrypted occurrence coordinates and public UTC timing metadata. Old alarms require no cancellation.

**Logical alarm ID**: A bridge-keyed opaque identifier for one occurrence, start, and consent generation, reused for idempotent registration.

**Due work**: A unique owner-scoped receipt containing content freshly fetched and validated at the occurrence trigger time, consumed by bounded subscriber delivery.

**Subscription**: An owner- and consent-generation-scoped, finite permission to notify a verified webhook callback about one enabled calendar. It grants no authority to execute calendar text.

**Callback transport**: The shared connection boundary for subscription verification and event delivery. It validates public destination addresses at connection time, connects to a validated address, and enforces original-hostname TLS verification.

**Delivery attempt**: A leased network attempt for one frozen subscriber and logical event. Its immutable body survives retries; an accepted HTTP 2xx receipt proves delivery only, not agent execution.

**Agent alias**: An owner-registered guest email address identifying an agent that may be invited to calendar events. It holds no task definitions or tool permissions; removing it immediately revokes its subscriptions, invitations, and pending deliveries.

**Invite allowlist**: The owner's explicit list of external organizer email addresses allowed to invite an agent alias. Unallowlisted external organizers are blocked at the integration layer before anything reaches an agent.

**Agent invitation**: A persisted record linking an occurrence (or recurring instance), a registered agent alias, and organizer provenance, used to deduplicate `calendar.event.invited` onboarding deliveries and gate external invites on explicit owner approval.

**Event provenance**: Structured organizer, creator, and approval metadata carried alongside raw untrusted calendar text so the receiving agent host can enforce its own trust policy.

**Write-back**: Narrow, per-calendar opt-in provider updates (`calendar_rsvp` and bounded `calendar_run_note`), off by default and re-authorized against live event state before every write.
