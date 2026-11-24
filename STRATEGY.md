# schedule-my-agents Strategy

## Vision

<!-- vision: author-approved 2026-11-24 -->

`schedule-my-agents` exists so that scheduling an agent requires nothing more than adding it to an ordinary calendar event.
It serves a single calendar owner running a self-hosted bridge across any MCP Events host, and it turns calendar invitations and timed occurrences into verified, webhook-driven MCP Event deliveries that onboard and trigger a known task.
It owns exactly one thing: the authorized bridge between the owner's calendar events and MCP Events subscribers.

### The calendar is the schedule

The owner's native calendar owns dates, times, timezones, recurrence, edits, and cancellations.
Adding one or more agents to an event uses native calendar guests with dedicated agent email aliases, and each added agent receives its own independent delivery.
`schedule-my-agents` does not build a competing scheduler UI, a cron system, or a task directory; adding an agent emits an invitation event so the configured agent host can bind or create the known task on its own side.
Durable timers then revalidate each occurrence against the calendar provider at start time or at a declared lead time before start so edits and cancellations suppress stale triggers.
All-day events and cancelled occurrences do not trigger runs because they declare no execution instant.
Background watch renewal and missed-push convergence keep recurring schedules active unattended once the owner authorizes them.

### Explicit authority, fail closed

Connecting a calendar account discovers calendars without granting access to any of them.
Every calendar, watch, and event subscription remains inactive until the owner explicitly enables it, and newly shared or discovered calendars fail closed.
Watches, sync cursors, alarms, receipts, and subscriptions bind to the owner, connection identity, calendar grant, and consent generation, and every asynchronous wake or retry rechecks that authority before acting.
Only the owner and users on an explicit owner-configured allowlist may invite an agent's guest alias; invites from anyone else are blocked at the integration layer before anything reaches the agent, minimizing prompt-injection and denial-of-service exposure.
External invites from allowlisted users still require the owner to approve or configure the agent's action before execution.
Revoking a calendar, subscription, allowlist entry, or connection removes local authority and stored content immediately before best-effort provider cleanup.

### Calendar content informs, never authorizes

The bridge stays blind to task parameter schemas and carries raw event titles and descriptions alongside structured event provenance so the agent host can enforce its own trust policy.
Event content may pass runtime parameters and context into a known task, while the task definition and its tool permissions remain fixed on the agent host and calendar text never grants execution authority.
Calendar write-back starts narrowly scoped to agent RSVP feedback and brief run-status notes behind an extensible, owner-authorized write surface, rather than opening general calendar editing.
The bridge keeps stored event data minimal, retains no full calendar history, and excludes secrets and private event text from logs, opaque alarms, and model-visible setup surfaces.

### Provider-neutral, host-agnostic MCP Events bridge

Provider-specific authentication, watch mechanics, notification decoding, cursor ordering, and recurrence expansion stay isolated behind narrow provider adapters.
The bridge is host-agnostic rather than tied to ChatGPT Sites or any single vendor runtime; any MCP Events-compatible agent host can subscribe through standard discovery, verification, and signed webhook delivery.
Delivery stays webhook-only rather than adding stream or cursor-polling modes, stays bounded by a five-minute late window and finite retries, and guarantees at-least-once signed receipt rather than claiming exactly-once agent execution.

### Self-hosted simplicity and verified guarantees

`schedule-my-agents` is deployed and operated as a single-user, self-hosted server whose setup and deployment steps stay documented in the repository, avoiding multi-tenant hosted security risk.
The bridge prefers native runtime capabilities and adds extra hosted infrastructure only when a currently re-validated protocol or platform gap makes it unavoidable and the owner explicitly authorizes it.
Security boundaries, including destination validation and consent isolation, fail closed rather than silently weakening to make a demo pass, and evolve as the MCP Events protocol and runtimes mature.
Automated local tests, fake-provider runs, and live hosted checks are reported separately, and unmet live guarantees remain open until proved.

### Scope

`schedule-my-agents` is not a calendar client, not a recurrence engine, not an agent runtime, not a task registry, not a notification platform, not a general SaaS integration product, and not a hosted multi-user or team administration service.
It does not store a long-term calendar archive, expose broad calendar-editing MCP tools, or manage agent execution quotas.

A change aligns when it makes adding one or more agents to a calendar event safely onboard and trigger known tasks over signed MCP Events webhooks across any calendar provider and agent host in a self-hosted deployment while keeping authority explicit and attack surface minimal.
A change should be resisted when it duplicates calendar scheduling semantics, moves task definitions into the bridge, locks the server to one agent host, adds multi-user SaaS tenancy, allows unallowlisted third parties to reach an agent, adds non-webhook delivery modes, lets calendar text grant execution authority, or claims guarantees that current checks have not proved.
