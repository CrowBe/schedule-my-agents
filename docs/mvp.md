# Calendar → ChatGPT MVP

The MVP is one demonstrated interaction: explicitly enable one Google Calendar, create an ordinary timed event there, and have a subscribed ChatGPT Work Cloud chat react at its start under the user's separate instructions. Google Calendar remains the scheduling interface. Do not add a second scheduled task or expand the platform after that demonstration works.

The original scope is [brief.md](brief.md). The [MVP tracker](https://github.com/CrowBe/schedule-my-agents/issues/1) and [GitHub milestone](https://github.com/CrowBe/schedule-my-agents/milestone/1) group the remaining work.

## Verified starting point

At source commit `840e25ad17ec9ea4cce9559d5ecb19397b62aed5`, one private Site contains Google OAuth, encrypted refresh credentials, discovery, explicit calendar consent, the Google provider adapter, watch/webhook/sync routes, D1 migrations and the authenticated MCP endpoint. On 5 October 2026, the user completed OAuth and enabled Personal. Separate live DB inspection confirmed one connection and one enabled calendar, with no watch or event records yet.

Sixteen integration tests cover the implemented routes, including three in the actual Workers runtime. Hosted Google ingress returned HTTP 401 at the private boundary. Event-start timing, persisted MCP subscriptions, callback delivery and ChatGPT reaction remain unproven. See [VERIFICATION.md](../VERIFICATION.md) for the evidence and platform constraints.

## Remaining slices

| Slice | Reviewable outcome | Required integration predecessors |
| --- | --- | --- |
| [1. Live Google ingress and sync — #2](https://github.com/CrowBe/schedule-my-agents/issues/2) | An actual notification reaches the private Site and updates only the enabled calendar's canonical snapshot. | Shipped OAuth and consent |
| [2. Durable occurrence timing — #3](https://github.com/CrowBe/schedule-my-agents/issues/3) | A persisted occurrence becomes due work with the browser closed, surviving restart and invalidating stale edits/cancellations. | #2; investigate the timer independently |
| [3. Verified MCP subscriptions — #4](https://github.com/CrowBe/schedule-my-agents/issues/4) | Authorized subscriptions persist and complete signed destination verification through a proven safe transport. | Shipped consent; can proceed alongside #2/#3 |
| [4. Signed due-event delivery — #5](https://github.com/CrowBe/schedule-my-agents/issues/5) | Due occurrences reach matching subscriptions through a persistent outbox with bounded retries and stable logical event IDs. | #2, #3, #4 |
| [5. Real ChatGPT demo — #6](https://github.com/CrowBe/schedule-my-agents/issues/6) | An ordinary Google Calendar event wakes a subscribed Work Cloud chat and produces the instructed response. | #2, #3, #4, #5 |

The issues contain their acceptance checks. Start with #2 to prove the single-Site ingress boundary. Timer and callback-transport capability investigations can proceed in parallel; do not advertise production event-start readiness until the complete delivery path works.

## MVP acceptance

- A real provider notification synchronizes a normal timed event on the enabled calendar.
- A durable timer dispatches with the setup page closed and produces a measured timing result. The proposed demo target is at most 60 seconds of lateness; unsupported timing remains a documented blocker.
- The existing Sites plugin completes a real authenticated subscription and callback challenge; a signed event reaches the subscribed ChatGPT Work Cloud chat.
- The chat performs a useful read-only action under the user's subscription instructions. A callback HTTP 2xx alone does not prove that response.
- Edits, cancellations, disable/disconnect and unsubscribe stop stale dispatch. Disabled, newly shared and unrelated calendars remain inactive.
- Diagnostics connect the provider notification, occurrence and delivery result without publishing secrets or private event contents. README and VERIFICATION retain the distinction between automated checks and hosted evidence.

## Scope and stop conditions

Use one provider, one useful event type (`calendar.event.starting`) and the existing canonical model. Keep Google responsible for recurrence expansion. All-day events remain outside this demo, and the occurrence horizon is explicitly bounded. Manual watch renewal and re-sync are acceptable within the declared demo lifetime; automatic renewal and unlimited unattended operation are not extra MVP gates.

Preserve the Site's private audience and authenticated owner/resource boundaries. Calendar content is data, not authority to execute. Prefer Site-native ingress, timing and transport. If a required capability is unavailable, document the exact missing capability and smallest fallback before provisioning anything. No relay, external dispatcher, replacement plugin or bypass credential is authorized by the roadmap itself.

Outlook, multiple agent routing, a custom scheduler/calendar UI, cron scheduling, comprehensive calendar tools, billing and team administration remain outside this MVP.
