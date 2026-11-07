# Roadmap

## Release 0.3 — observe-first MVP
- [x] Non-streaming chat-completions proxy
- [x] Bearer authentication
- [x] Metadata-only local event persistence
- [x] Configurable model cost estimates
- [x] Summary and event endpoints
- [x] Observe-only recommendations
- [x] Unit tests

## Next engineering milestones
1. Add integration tests with a mock upstream HTTP server.
2. Add streaming support with safe usage accounting.
3. Separate admin and proxy credentials; add rate limits and request IDs.
4. Add SQLite/PostgreSQL persistence, migrations and tenant boundaries.
5. Add provider pricing catalogue with effective dates and cached-token pricing.
6. Build an evaluation harness and human approval workflow.
7. Add verified savings ledger and customer-facing dashboard.
8. Integrate Naïve/Vetta using the current supported SDK and explicit permissions.
9. Add deployment packaging, TLS, secret management, retention and monitoring.
