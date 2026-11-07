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

## 0.5.0: win customers and stop runaway spend (this release)
- [x] Fix: unsupported paths returned 500; `/v1/models` passthrough; OpenAI-shaped errors
- [x] Landing page, public stats, published delay figure
- [x] Free audit from usage exports or the OpenAI usage API, in dollars per month
- [x] Budget caps (customer, feature, end user), loop breaker, spike alerts and pausing
- [x] Waste report on proxied traffic; per-request savings statement (CSV)
- [x] Answer reuse at any temperature for opted-in features
- [x] Deployment guide and configs (systemd, Caddy or nginx), integration guide with a fallback
- [x] Paystack card setup confirmed without a webhook

## Next (before 15 December)
1. Deploy to wastezero.tech; run Paystack/Stripe test mode and Resend for real.
2. Anthropic Messages and OpenAI Responses API support; automatic prompt-caching layout for Anthropic.
3. Pull provider bills automatically for reconciliation (OpenAI costs API).
4. Customer dashboard (spend, savings, waste report, settings, invoices).
5. AI co-workers on a shared task board:
   - **Chief of Staff:** daily brief and weekly goals
   - **Onboarding:** turns signups into traffic, then into consent
   - **Support:** handles the inbox
   - plus a public operations log
6. Dogfooding: route WasteZero's own grader and prospecting calls through WasteZero.

## Later
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
