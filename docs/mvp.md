# Calendar → ChatGPT MVP

The MVP is one demonstrated interaction: explicitly enable one Google Calendar, create an ordinary timed event there, and have a subscribed ChatGPT Work Cloud chat react at its start under the user's separate instructions. Google Calendar remains the scheduling interface. Do not add a second scheduled task or expand the platform after that demonstration works.

The original scope is [brief.md](brief.md). The [MVP tracker](https://github.com/CrowBe/schedule-my-agents/issues/1) and [GitHub milestone](https://github.com/CrowBe/schedule-my-agents/milestone/1) group the remaining work.

## Current checkpoint

The real provider push, durable closed-setup timing, signed callback acceptance and useful read-only Work Cloud response were verified on 8 October 2026. The current suite has 70 tests, including actual Workers/D1/Durable Object restart and race coverage. Manual watch renewal is visible and was exercised on the hosted Site.

[The acceptance matrix](mvp-acceptance.md) separates live evidence from fake-provider runtime tests and maps it to every issue. Google ingress (#2), durable timing (#3) and the functional signed outbox (#5) have acceptance evidence. The full tracker (#1), callback subscription slice (#4) and final acceptance gate (#6) remain open for connection-time validated-IP pinning on the hosted callback path. The owner-authorized OpenAI-only native-fetch experiment delivers real events but does not prove that stricter guarantee.

## MVP acceptance

- A real provider notification synchronizes a normal timed event on the enabled calendar.
- A durable timer dispatches with the setup page closed and produces a measured timing result. The proposed demo target is at most 60 seconds of lateness; unsupported timing remains a documented blocker.
- The existing Sites plugin completes a real authenticated subscription and callback challenge; a signed event reaches the subscribed ChatGPT Work Cloud chat.
- The chat performs a useful read-only action under the user's subscription instructions. A callback HTTP 2xx alone does not prove that response.
- Edits, cancellations, disable/disconnect and unsubscribe stop stale dispatch. Disabled, newly shared and unrelated calendars remain inactive.
- Diagnostics connect the provider notification, occurrence and delivery result without publishing secrets or private event contents. README and VERIFICATION retain the distinction between automated checks and hosted evidence.

## Scope and stop conditions

Use one provider, one useful event type (`calendar.event.starting`) and the existing canonical model. Keep Google responsible for recurrence expansion. All-day events remain outside this demo, and the occurrence horizon is explicitly bounded. Manual watch renewal and re-sync are acceptable within the declared demo lifetime; automatic renewal and unlimited unattended operation are not extra MVP gates.

Preserve the Site's public audience and authenticated owner/resource boundaries, as authorized while completing issue #2. Calendar content is data, not authority to execute. Prefer Site-native ingress, timing and transport. If a required capability is unavailable, document the exact missing capability and smallest fallback before provisioning anything. The user subsequently authorized the opaque Cloudflare dispatcher for issue #3. Other infrastructure and audience changes still require explicit authorization.

Outlook, multiple agent routing, a custom scheduler/calendar UI, cron scheduling, comprehensive calendar tools, billing and team administration remain outside this MVP.
