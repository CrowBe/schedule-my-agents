# Opaque alarm dispatcher

Run `npm ci`, `npm run typecheck`, `npm run build`, then authenticated `npx cf deploy --prebuilt` in this directory. Configuration uses the new Cloudflare CLI. The independent GitHub workflow verifies this package and supports manual deployment when repository `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` are configured. Local CLI authentication is sufficient for local deployment.

Provision secret `REGISTRATION_KEY` and `CALLBACK_KEY` to match the Site. Never provision the Site encryption key here. `CALLBACK_URL` is fixed to the Site wake route. Invocation logs are disabled; application logs contain only opaque tags/outcomes/timing. Due timestamps are visible metadata, so this is data minimization, not zero information disclosure.

One SQLite Durable Object per opaque logical alarm stores the encrypted payload and retry state. Registration retries cannot reset an acknowledged alarm. Delivery requires HTTP 204; redirects are rejected. Persistent retries stop at five-minute expiry. A one-day tombstone suppresses duplicate registration, then attempts bounded Site receipt cleanup and deletes its state. See the root architecture for outage and retention limits.
