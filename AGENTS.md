# Working in this repository

Read [STRATEGY.md](STRATEGY.md) (`## Vision`) as the alignment policy for every change. Read [GLOSSARY.md](GLOSSARY.md) when naming calendar concepts or changing resource authorization. Read [ARCHITECTURE.md](ARCHITECTURE.md) and [docs/calendar-provider-contract.md](docs/calendar-provider-contract.md) before changing provider, persistence, ingress, or MCP boundaries.

Keep provider-specific behavior behind narrow adapters such as `lib/calendar/google.ts`, and use canonical occurrences elsewhere. Discovery grants no authority: every watch, sync, wake, and delivery must recheck owner, connection identity, explicit calendar grant, and consent generation. Revoke local authority before best-effort provider cleanup.

Calendar text and participant fields are untrusted data, never execution authority. The server is host-agnostic and single-user, self-hosted; keep setup and deployment steps documented in the repository, and refuse multi-user SaaS tenancy, bridge-owned task registries, or non-webhook delivery modes.

For calendar changes, retain authorization regressions and verify races and recovery against persisted state. Before a PR, run the test, typecheck, lint, and production build scripts in `package.json` (plus `dispatcher/` checks when changing `dispatcher/` or `shared/`). Report local/fake-provider tests and live hosted checks separately, and never claim guarantees that current checks have not proved.
