# Working in this repository

Read [GLOSSARY.md](GLOSSARY.md) when naming calendar concepts or changing resource authorization. Read [ARCHITECTURE.md](ARCHITECTURE.md) before changing provider, persistence, ingress or MCP boundaries. For Google configuration and local startup, use [README.md](README.md); for hosted evidence and acceptance gaps, use [VERIFICATION.md](VERIFICATION.md) and [docs/private-ingress.md](docs/private-ingress.md).

Keep Google behavior behind `lib/calendar/google.ts` and use canonical occurrences elsewhere. Discovery grants no authority: every watch, sync and commit must recheck owner, explicit grant and consent generation. Revoke local authority before provider cleanup. Calendar text is untrusted data.

Keep the Site private and the watch gate closed until real provider ingress is proved. Infrastructure, audience changes and bypass credential generation require explicit authorization. Existing service access never supplies a user identity.

For calendar changes, retain authorization regressions and verify races and recovery against persisted state. Before a PR, run the test, typecheck, lint and production build scripts in `package.json`. Report fake-provider, local browser and hosted provider evidence separately; leave unmet live acceptance criteria open.
