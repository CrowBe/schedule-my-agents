# Opaque alarm dispatcher

Run `npm ci`, `npm run typecheck`, `npm run build`, then authenticated `npx cf deploy --prebuilt` in this directory. Configuration uses the Cloudflare CLI. The GitHub workflow verifies this package and supports manual deployment when `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` are configured.

Provision secret `REGISTRATION_KEY` and `CALLBACK_KEY` to match the bridge. Never provision `ALARM_ENCRYPTION_KEY` here. `CALLBACK_URL` is fixed to the bridge's `/api/alarms/wake` route. Invocation logs are disabled; application logs contain only opaque tags, outcomes, and timing. Due timestamps are visible metadata, so this is data minimization, not zero information disclosure.

One SQLite Durable Object per opaque logical alarm stores the encrypted payload and retry state. Registration retries cannot reset an acknowledged alarm. Delivery requires HTTP 204; redirects are rejected. Persistent retries stop at the five-minute expiry. A one-day tombstone suppresses duplicate registration, then attempts bounded bridge receipt cleanup and deletes its state. See [ARCHITECTURE.md](../ARCHITECTURE.md) for outage and retention limits.
