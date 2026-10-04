https://github.com/CrowBe/schedule-my-agents is a fresh empty repository. Create a first commit for it from this prompt:
Build: Calendar → MCP Events Thin Slice
Build a working proof-of-concept as a single hosted ChatGPT Site, with the goal of validating this interaction:
«A user connects a specific Google Calendar, explicitly opts that calendar into the service, schedules something using their normal Google Calendar interface, and that calendar activity is exposed to ChatGPT through MCP Events without polling.»
The long-term product idea is a provider-agnostic bridge between users' existing scheduling systems and AI agents. Do not build that larger platform yet. This first implementation should prove the smallest useful end-to-end architecture.
Core product principle
The calendar is the scheduling system.
We are not building another scheduler UI, cron system, or task manager. Google Calendar already provides mature scheduling semantics including:
- dates and times
- recurrence
- timezones
- editing
- cancellation
- mobile/native UI
- reminders
- shared events
Our job is to bridge calendar activity into MCP Events so an AI client can react to it.
Eventually this should support multiple calendar providers and arbitrary MCP-compatible agents. For this slice, support:
Google Calendar → hosted MCP server → ChatGPT
Everything should live inside one ChatGPT Site unless a required platform capability makes that impossible.
Architectural constraint
Prefer zero external infrastructure.
Use the facilities available to a hosted ChatGPT Site for:
- the web/setup UI
- server-side logic
- MCP server
- MCP Events implementation
- HTTP routes
- persistent storage
- secrets
- Google OAuth
- Google Calendar webhook ingestion
- subscription state
- watch lifecycle management, if possible
Do not introduce Vercel, Cloudflare Workers, Supabase, Firebase, a separate Node service, or another hosted component merely because it would be familiar.
If a required capability cannot currently be provided by ChatGPT Sites, document the limitation clearly before adding external infrastructure.
Target architecture
Aim for:
                ChatGPT
                   ▲
                   │
              MCP Events
                   │
                   ▼
         ┌───────────────────┐
         │   ChatGPT Site    │
         │                   │
         │ Setup UI          │
         │ MCP server        │
         │ Google OAuth      │
         │ Persistent state  │
         │ Google webhook    │
         │ Watch lifecycle   │
         └─────────┬─────────┘
                   │
          Google Calendar API
                   │
                   ▼
            Google Calendar
The Site should be the application and backend, not merely a frontend for another service.
User flow
Implement the smallest useful setup experience.
1. Connect Google
The user can authorize the application to access Google Calendar.
Use the narrowest Google OAuth scopes reasonably required for this proof.
OAuth credentials/secrets must never be exposed client-side.
Persist whatever authorization state is required to continue interacting with Google after the initial request.
2. Discover calendars
After connecting Google, show calendars accessible through the authorized Google account.
Important security principle:
«Discovery is not authorization.»
The fact that Google's API exposes a calendar to the connected account MUST NOT mean that calendar is enabled for AI/event processing.
For example:
Google account
Available calendars:
Personal       [Enable]
Family         [Enable]
Work           [Enable]
Birthdays      [Enable]
All calendars should default to disabled.
3. Explicitly enable a calendar
The user selects one calendar to connect to the service.
Persist this explicit authorization.
For this thin slice, supporting one enabled calendar is sufficient, although avoid unnecessarily hardcoding the data model to exactly one.
An enabled calendar should be the fundamental resource-level authorization boundary.
A newly discovered calendar must never automatically become enabled.
If somebody later shares an additional calendar with the Google account, it must remain completely inactive until explicitly enabled.
4. Establish a Google Calendar watch
For an explicitly enabled calendar, establish the appropriate Google Calendar push notification/watch subscription.
Persist enough information to associate incoming Google notifications with:
- the Google connection
- the specific enabled calendar
- the Google watch/channel
- its expiry/lifecycle state
Do NOT establish watches for calendars that have merely been discovered.
5. Receive Google Calendar notifications
Expose the HTTPS route required for Google Calendar push notifications.
When Google notifies us of a change:
1. validate/identify the notification;
2. resolve the associated enabled calendar;
3. synchronize/fetch the relevant Google Calendar state as necessary;
4. normalize it into our own small internal representation;
5. determine whether it should produce an MCP Event.
Do not treat Google webhook payloads as our domain model.
Keep provider-specific behaviour behind a small Google adapter boundary.
Canonical model
Do not over-engineer a universal calendar schema yet.
Create only the minimal canonical representation required for this slice.
Something approximately like:
type CalendarEvent = {
  id: string
  calendarId: string
  title?: string
  description?: string
  start: string
  end?: string
  status?: string
  provider: "google"
  providerEventId: string
}
Adjust based on what the implementation actually requires.
The important architectural property is:
«MCP consumers should not need to understand Google Calendar's native API schema.»
MCP server
Implement the MCP server inside the ChatGPT Site.
For this thin slice, the important capability is MCP Events, not a comprehensive set of calendar tools.
Expose one useful event type initially.
Prefer something conceptually equivalent to:
calendar.event.starting
The precise naming should follow current MCP Events conventions and whatever works best with ChatGPT's implementation.
The event definition should expose appropriate subscription filtering.
At minimum, subscriptions should be scoped to a calendar that the user has explicitly enabled.
A subscription requesting a calendar the user has not enabled should be rejected as unauthorized rather than silently broadening access.
Persist MCP subscriptions as required by the current MCP Events specification/ChatGPT implementation.
When the relevant calendar condition occurs, deliver the MCP Event through the subscribed callback mechanism.
Event payload
Keep the payload small and useful.
Approximately:
{
  "calendarId": "...",
  "eventId": "...",
  "title": "Review Weave",
  "description": "Review the open PRs and tell me what needs attention.",
  "start": "...",
  "end": "..."
}
Do not leak unrelated calendar data.
Target end-to-end demo
The implementation is successful when we can demonstrate:
1. Open the ChatGPT Site.
2. Connect a Google account.
3. See the calendars accessible through that account.
4. Explicitly enable one calendar, e.g. "Personal".
5. Other calendars remain disabled.
6. ChatGPT subscribes to the relevant MCP Event.
7. Create an ordinary event in Google Calendar on "Personal".
8. Give that event an instruction, for example:
Review Weave
Review the open PRs in CrowBe/weave and tell me if anything needs my attention.
9. At the appropriate calendar time, Google causes our Site to receive the relevant notification/state change.
10. Our MCP server emits the subscribed MCP Event.
11. ChatGPT wakes/reacts to that event without polling.
The important demo is:
«I scheduled an AI action by creating an ordinary Google Calendar event.»
I should not have to create a second scheduled task inside ChatGPT.
Security invariants
Treat these as architectural requirements even for the prototype.
Provider access != resource authorization
Google OAuth may technically allow the service to discover/access multiple calendars.
Only calendars explicitly enabled by the user are part of this system.
Conceptually:
Google account
├── Personal       ✓ enabled
├── Family         ✗
├── Work           ✗
└── Shared calendar ✗
New calendars fail closed
If a new calendar becomes visible through Google after initial setup, it receives:
- no watch
- no MCP subscriptions
- no event delivery
- no agent capabilities
until explicitly enabled.
Calendar content is untrusted
Titles, descriptions, attendee names and other event content are data supplied by potentially untrusted parties.
Do not treat event content as authorization.
Minimize data
Do not ingest/store an entire user's calendar history unnecessarily.
Store only what is required for:
- enabled-calendar configuration
- Google watch state
- event synchronization required by the integration
- MCP subscription state
- basic debugging/audit information
Watch lifecycle
Google Calendar watch channels expire.
Implement automatic renewal inside the Site if ChatGPT Sites provides an appropriate persistent/background scheduling primitive.
Persist channel expiration information.
Renew watches sufficiently before expiration.
If Sites cannot reliably perform this background work, document that as a platform limitation rather than immediately redesigning the application.
For the first successful vertical-slice demo, manual renewal is acceptable if necessary.
Provider isolation
Although only Google is implemented, keep Google-specific behaviour behind a narrow boundary.
Conceptually:
interface CalendarProvider {
  discoverCalendars(...)
  watchCalendar(...)
  stopWatchingCalendar(...)
  syncEvents(...)
}
Do not spend significant time designing this interface upfront.
Extract only the boundary naturally required by the Google implementation.
The goal is to make a later Outlook adapter plausible without prematurely building a generic integration framework.
Explicitly out of scope
Do NOT build yet:
- Outlook support
- arbitrary integration providers
- generic SaaS integrations
- multiple agent routing
- assistant email aliases
- automatic contact creation
- agent RSVP behaviour
- a custom calendar UI
- a custom recurrence engine
- cron scheduling
- rich calendar editing
- comprehensive MCP calendar tools
- organization/team administration
- billing
- enterprise policy management
- elaborate permission matrices
- a generic Composio competitor
We are testing one hypothesis:
«Can an existing calendar become a clean, native scheduling interface for AI agents through MCP Events?»
Things that MUST be verified against current platform documentation
Before assuming they work, verify the current ChatGPT Sites and MCP Events behaviour for:
1. Arbitrary inbound HTTPS routes
   - Can the hosted Site expose a stable public endpoint suitable for Google Calendar webhook POSTs?
2. Google OAuth callback handling
   - Can the Site host the OAuth initiation and redirect/callback routes itself?
   - Can it securely persist refresh credentials/tokens?
   - Are there restrictions around OAuth redirect URLs or custom authentication flows?
3. Persistent storage
   - Confirm the supported persistence mechanism and use it for Google connections, enabled calendars, watch state and MCP subscriptions.
4. Secrets
   - Confirm Google OAuth client secrets and similar credentials can remain server-side and inaccessible to visitors.
5. Background/scheduled execution
   - Determine whether the Site can reliably renew expiring Google watch channels without an active user session.
6. Outbound HTTPS
   - Confirm server-side code can call Google APIs and deliver MCP Event callbacks.
7. MCP Events
   - Implement against the current OpenAI/MCP Events specification rather than assumptions.
   - Verify "events/list", "events/subscribe", authorization/filter behaviour, persistence requirements, callback signing/verification requirements and delivery semantics.
8. Timing semantics
   - Google Calendar push notifications primarily represent resource changes, not necessarily "the event's start time has arrived."
   - Verify how "calendar.event.starting" should actually be implemented.
   - Determine whether the Site needs a scheduled/background primitive to translate future event start times into timely MCP Events.
   - Do not incorrectly assume Google will send a webhook merely because an event's start time arrives.
This final point is especially important.
If Google Calendar does not generate a provider notification at event start, then separate the architecture into:
Google change notification
        ↓
sync upcoming event
        ↓
persist scheduled occurrence
        ↓
Site scheduling/background mechanism
        ↓
calendar.event.starting MCP Event
Prefer the simplest reliable Site-native implementation.
Development approach
Work vertically rather than building layers in isolation.
Suggested milestones:
Milestone 1: Site can complete Google OAuth.
Milestone 2: Site can list calendars.
Milestone 3: User can explicitly enable one calendar and the decision persists.
Milestone 4: Site can establish a Google watch for only that calendar.
Milestone 5: Google successfully POSTs a notification to the hosted Site.
At this point, stop and verify that the fundamental "single Site" architecture works.
Then:
Milestone 6: Normalize relevant calendar changes.
Milestone 7: Implement the minimum MCP Events server surface.
Milestone 8: ChatGPT successfully subscribes.
Milestone 9: A calendar event causes an MCP Event to reach ChatGPT.
Milestone 10: Make event-start scheduling reliable enough for the demo.
Avoid polishing the setup UI until the complete vertical slice works.
Documentation
Keep a short "README" describing:
- the hypothesis being tested
- architecture
- setup requirements
- Google OAuth configuration
- how explicit calendar authorization works
- MCP event contract
- known limitations
- which ChatGPT Sites capabilities were verified
- anything that unexpectedly required external infrastructure
Also keep a small "VERIFICATION.md" recording the results of the platform-capability checks above.
Do not hide unresolved platform assumptions behind abstractions. If something cannot currently be done inside a hosted ChatGPT Site, state exactly what is missing and propose the smallest possible external component that would fill that gap.
Success criterion
Optimize for reaching one compelling demo:
«I install/connect the Site/plugin once, explicitly enable my Personal Google Calendar, then continue using Google Calendar normally. I create an event containing an instruction for my agent. At the scheduled time, ChatGPT receives an MCP Event and acts on it, without polling and without me separately configuring a ChatGPT scheduled task.»
If that works, stop.
Do not expand the product until that interaction has been validated.