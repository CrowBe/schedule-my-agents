# Architecture

The calendar is the scheduling interface. One publicly reachable ChatGPT Site owns the setup UI, Google OAuth, MCP endpoint and D1 state using the bundled Vinext/Workers runtime. No separately provisioned backend is part of the implementation.

## Implemented boundaries

`app/setup.tsx` calls owner-authenticated APIs. `build/sites-worker.ts` routes API and MCP requests to `CalendarService`; Sites supplies trusted identity. The service owns consent, OAuth, watch validation and sync orchestration. `GoogleCalendar` contains Google HTTP/schema behavior; `Store` owns D1 transactions and guarded snapshot replacement.

Google discovery → explicit calendar grant → expiring watch → validated resource-change notification → Google fetch → canonical snapshot in D1. Webhook authority comes from the persisted watch and current consent generation, independently of caller identity headers. OAuth refresh credentials are encrypted; watch tokens are stored as hashes.

## Planned boundaries

Verified provider ingress must precede live watch creation. Public hosting allows Google's unauthenticated POST to reach channel validation while setup, data and MCP remain authenticated and owner scoped. [The ingress investigation](docs/private-ingress.md) preserves the earlier private-hosting evidence; the user authorized changing the hosting audience instead of deploying a relay.

After ingress is proven, add Site-native durable occurrence scheduling and watch renewal, then persistent owner-scoped MCP subscriptions and signed callbacks. Subscription expiry, revocation, stable event IDs and bounded retries must be enforced at dispatch. Timer and callback-transport capabilities remain unverified. `calendar.event.starting` is planned; the current event catalog stays empty.

The seven-day snapshot is a sync demonstration, not an automatically advancing scheduler. Manual resync is an explicit recovery action; it does not establish or renew a watch. Provider-specific schemas remain inside the adapter as additional providers are considered.
