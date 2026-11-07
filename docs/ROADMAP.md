# Roadmap

## 0.4.0 — the full loop (this release)
- [x] v0.3 fixes:
  - `.env` loading
  - dated model pricing
  - crash safety
  - clean 413
  - config validation
  - separate admin key
- [x] Multiple customers with consent policies; bring-your-own provider key; per-feature tags
- [x] Streaming support with usage accounting
- [x] Answer reuse and cheaper-model routing
- [x] Shadow testing, LLM grader, live audits, automatic rollback
- [x] Per-request savings record, invoices, reconciliation against the provider bill
- [x] Card billing through Stripe or Paystack, with webhooks and retries
- [x] Finding customers and outreach, with guardrails; self-serve signup
- [x] Autonomous operator, audit log, escalation webhook, kill switch
- [x] 29 tests against mock providers

## Next
1. Trial runs against live Stripe/Paystack test mode, Resend, and OpenAI, using a real pilot customer.
2. Pull provider bills automatically (OpenAI and Anthropic usage/cost APIs) so reconciliation needs no human.
3. Postgres storage and a shared cache (Redis), so more than one instance can run.
4. More providers and endpoints: Anthropic Messages, Gemini, embeddings, the Responses API, batch.
5. More savings levers:
   - provider prompt-caching layout
   - batch API for work that isn't urgent
   - output-length caps
   - retry-loop breaker
   - near-duplicate (semantic) reuse with quality testing
6. Customer dashboard (savings over time, rules, invoices, card).
7. Inbox handling for replies to outreach; CRM export.
8. Security review, data processing agreement, SOC 2 groundwork.
