# WasteZero 0.7.0
### Find where your AI money leaks. Fix it without hurting quality. Pay only from what we save.

WasteZero is a proxy that sits between a customer's app and their model provider (any OpenAI-compatible chat-completions API). It records every call, finds waste, fixes it within limits the customer has agreed to, measures the saving on each request, and bills a percentage of verified savings to a saved card. An autonomous operator runs the loop and hands decisions to a human only where it should. It can also find new customers, email them, and sign them up.

```
find customers → sign up (observe-only) → measure spend → find waste → test the fix on real traffic
      → go live if quality holds → watch quality, roll back if it slips → invoice % of savings → charge card
```

## New in 0.7.0: a company that runs itself, with a human on the money

**Customers and the founder now have real dashboards.**
- Every page has a header and nav. Returning customers sign in by email link or API key at `/signin`.
- Customer dashboard at `/app` has these tabs:
  - overview and month-end forecast;
  - savings and waste;
  - **approvals with side-by-side quality samples**;
  - **profit per customer/plan**;
  - protection settings;
  - API keys (create, rotate, revoke);
  - invoices and card;
  - setup.
- Admin console at `/console` covers:
  - overview, including what WasteZero spends on its own AI;
  - the AI team and the daily brief;
  - customers and their policies;
  - approvals;
  - invoices (reconcile, mark paid);
  - prospects;
  - the activity log.
- Pricing, docs, privacy, terms and contact pages.

**The AI team.** The operator runs these agents on every cycle:
- **Chief of Staff**: sets weekly goals and emails a daily brief (and sends it on Telegram).
- **Prospector**: finds and qualifies leads, then drafts outreach.
- **Onboarding**: nudges signups to their first request.
- **Inbox**: triages the contact form and inbound email, then drafts replies.
- **Reliability**: watches provider errors and latency, and opens incidents.
- **Billing**: invoices and collects.

Every decision is logged. **Money, contracts and anything that can't be undone stay with a human.** Outbound emails, refunds, mark-paid and policy changes wait in Approvals until you approve them.

**The physician heals itself.** All of WasteZero's own AI calls go through WasteZero, on an internal account with per-agent budgets, caching and routing. Grader calls are never downgraded. The console shows its own spend and savings.

**Finding customers.** The Prospector searches five places daily: LLM job posts in Hacker News "Who is hiring", Y Combinator's AI companies, GitHub organisations with active LLM repositories, Show HN launches and Product Hunt's AI topic. It researches each company's public site and finds a role address (hello@, sales@), using Hunter.io when the site shows none. Then it scores fit with AI and drafts an email for your approval. You can also import your own list of domains in the console.

**Moat features**
- Cheapest healthy provider with automatic failover (`MODEL_OFFERS_JSON`).
- Telegram alerts with Pause/Resume buttons.
- End-of-month spend forecasts.
- Usage billing at cost plus a markup (`BILL_USAGE`, `USAGE_MARKUP_PCT`) for customers who use WasteZero's keys.

**Brand.** Logo, favicon and social images are in `brand/`. See `brand/BRAND-KIT.md`.

## New in 0.6.0: works with any major AI provider
- **Multiple providers at once:** OpenAI, Anthropic, Gemini, Kimi (Moonshot), DeepSeek, OpenRouter, and any other OpenAI- or Anthropic-compatible provider you add in `PROVIDERS_JSON`.
  - Each request goes to the right provider based on the model name, or on the `X-WasteZero-Provider` header.
  - Customers send their own key for that provider in `X-Upstream-Authorization`.
- **Native Anthropic Messages API** (`POST /v1/messages`). Apps using the Anthropic SDK only change their base URL.
  - Budgets, the loop breaker, answer reuse, routing (e.g. Sonnet → Haiku, after shadow testing), streaming and per-request savings all work the same way.
- **Automatic prompt caching for Anthropic** (consent: `allowedOptimizations: ["prompt_cache"]`). WasteZero marks parts of the prompt for caching only where they are likely to be reused, so customers don't pay extra for cache writes that never get read:
  - a long system prompt, once it has been seen recently;
  - the conversation so far, in multi-turn exchanges.
  - Requests that already manage their own caching are left alone, and no saving is claimed for them.
  - The saving booked is the full-price input cost minus the actual cost (cache reads at 0.1× and cache writes at 1.25× the input price, unless the price list says otherwise).
- **Pricing handles each provider's cache charges:** prices for reading from and writing to the cache, and dated model names (e.g. `claude-sonnet-4-5-20250929`).
- **Routing stays within one provider**, because the customer's key and request format belong to that provider. Switching between providers is on the roadmap.

## New in 0.5.0
- **Free audit, no proxy needed** (`/audit`). The customer uploads a usage export or connects an OpenAI admin key (read once, never stored) and gets waste in dollars per month: model mix, unused prompt caching, batch candidates and spending spikes. Each finding is labelled *measured* or *estimated*, with its assumption stated.
- **Runaway-spend protection.**
  - Budget caps per customer (daily or monthly), per feature and per end user.
  - A loop breaker for identical requests repeated in a short window.
  - Spike alerts against the customer's normal hourly spend.
  - Each one alerts or blocks/pauses, as the customer chooses. Alerts go by email and to a Slack-style webhook.
- **Waste report on proxied traffic** (`GET /v1/wastezero/waste-report`). Covers loops, repeats, model mix, prompt caching, truncated answers, background work and spikes.
- **Customer self-service.** Customers change their own safety and consent settings, resume after a pause, and download a per-request savings statement (CSV).
- **Answer reuse at any temperature** for features the customer opts in (`cacheTags`).
- **Landing page** at `/` with public stats (`/stats`), including the median delay WasteZero adds. Every answer carries an `X-WasteZero-Overhead-Ms` header.
- **Paystack card setup is confirmed without a webhook**, so it can share a Paystack account whose webhook serves another platform.
- **Deployment:** systemd, Caddy and nginx configs, a step-by-step guide ([docs/DEPLOY.md](docs/DEPLOY.md)), and an integration guide with a fallback snippet ([docs/INTEGRATION.md](docs/INTEGRATION.md)).
- **Fixes:**
  - Unsupported customer paths now return a 404 instead of a 500.
  - `/v1/models` passes through to the provider.
  - Customer errors are now OpenAI-shaped.
  - Signup and audit rate limits now work behind a reverse proxy (`TRUST_PROXY`).

## What it does

| Area | What happens |
|---|---|
| **Proxy** | OpenAI-compatible `POST /v1/chat/completions`, streaming and non-streaming. Provider request-ID and rate-limit headers pass through. Each customer can use their own provider key (`X-Upstream-Authorization`), so the provider bills them directly. |
| **Measurement** | Every call is recorded with tokens, cost (including the discounted rate for cached prompt tokens), the cost it would have had without WasteZero, and the saving. Prompts and answers are **not** stored. `X-WasteZero-Tag` breaks spend down by feature. |
| **Savings levers** | **Reuse:** identical repeat requests (temperature 0) are answered from memory at zero cost. **Routing:** an expensive model doing short tasks is switched to a cheaper one. |
| **Quality checks** | Before routing goes live, a sample of real requests also goes to the cheaper model, and a grader model judges whether its answer could replace the original. Tool calls must match exactly. Once live, a smaller sample keeps being re-checked. If quality drops below the customer's threshold, the operator rolls the change back. |
| **Operator** | Runs on a timer. Finds waste, files proposals, starts tests, promotes, rejects or rolls back changes, drafts invoices, collects payment and finds customers. Every decision goes to the audit log. Decisions that need a human go to a webhook (for example Slack). A kill switch stops it. |
| **Billing** | Monthly invoice = savings share (% of verified savings) + an optional fixed monthly subscription fee. It is emailed to the customer and charged to their saved card through **Stripe** or **Paystack**. Signed webhooks mark invoices paid or failed, and failed charges are retried. |
| **Finding customers** | Finds companies that have recently launched AI products, reads their public site, and keeps only role addresses on their own domain (hello@, sales@…). A model judges fit and writes a personal line, and a template email goes out with your postal address and one-click unsubscribe. One follow-up, a daily cap, and approval first by default. |
| **Self-serve signup** | `GET /signup` creates an observe-only account and shows the API key once. It sends a welcome email and a card link, and links each signup back to the outreach email that brought it in. |

## Quick start

Requires Node.js 20.6 or later. There are no dependencies to install.

1. Copy `.env.example` to `.env`.
2. Set `WASTEZERO_ADMIN_KEY` (24+ random characters), `OPENAI_API_KEY`, and check `MODEL_RATES_JSON` against current provider prices.
3. Run the tests and start the server:
   ```bash
   npm test
   npm start
   ```
4. Create a customer. Every customer starts observe-only.
   ```bash
   curl -X POST localhost:8787/admin/tenants -H "Authorization: Bearer $WASTEZERO_ADMIN_KEY" \
     -H "content-type: application/json" -d '{"name":"Acme","email":"billing@acme.com"}'
   ```
   The response contains the customer's `apiKey`. It is shown once.
5. The customer changes one line in their app:
   ```python
   client = OpenAI(base_url="https://your-wastezero-host/v1", api_key="wz_...",
                   default_headers={"X-Upstream-Authorization": "Bearer sk-their-openai-key",
                                    "X-WasteZero-Tag": "support-bot"})
   ```

## Customer consent (the policy)

Each customer has a policy. Nothing is optimised unless the policy allows it, and the customer agrees to it in their contract.

```json
{
  "allowedOptimizations": ["cache", "route"],
  "autoShadow": true,          // operator may start quality tests on its own
  "autoPromote": true,         // operator may switch live traffic once tests pass
  "minQuality": 0.95,          // share of tested answers that must be acceptable
  "minSamples": 30,
  "shadowSampleRate": 0.1,     // share of matching requests duplicated for testing (WasteZero pays)
  "auditSampleRate": 0.02,     // share of live optimised requests re-checked
  "maxEvalSpendUsdPerMonth": 20,
  "revenueSharePct": 20,
  "monthlyBaseFeeUsd": 0,
  "cacheTtlSec": 3600,
  "cacheNondeterministic": false
}
```
Change it with `PATCH /admin/tenants/:id {"policy": {...}}`. If a customer withdraws consent, their live rules are paused on the next operator run.

With `autoShadow` and `autoPromote` both off, the operator still finds waste and runs nothing on its own: it escalates each step for approval (`POST /admin/rules/:id/transition {"to":"shadow"}`).

## How savings are measured (put this in the contract)

For each successful request that WasteZero changed:

- **Reused answer:** saving = what the request would have cost at the model the customer asked for. Actual cost = 0.
- **Routed request:** saving = the cost of the tokens at the requested model minus the cost at the model actually used. Both sides use the cheaper model's token counts, because the original model was never called. Tokenisers differ slightly between models.
- Losses net against gains. The fee is never below zero. Unpriced models are excluded and listed on the invoice.

Before an invoice is charged, `POST /admin/reconcile {"tenantId","period","providerBilledUsd"}` compares recorded spend with the provider's bill. Inside `RECONCILE_TOLERANCE_PCT` the invoice becomes `ready`; outside it, `needs_review`. Set `BILLING_REQUIRE_RECONCILIATION=false` to send and charge invoices without this check.

## Card billing

1. Set `PAYMENT_PROVIDER=stripe` (with `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET`) or `paystack` (with `PAYSTACK_SECRET_KEY`), plus `PUBLIC_BASE_URL`.
2. Point the provider's webhook at `<PUBLIC_BASE_URL>/webhooks/payments`.
   - **Stripe events:** `checkout.session.completed`, `invoice.paid`, `invoice.payment_failed`.
   - **Paystack:** set the webhook URL in the dashboard.
3. Customers save a card from the link in their welcome email or invoice, or from `POST /admin/tenants/:id/card-link`.
   - **Stripe:** hosted Checkout in setup mode.
   - **Paystack:** a small first charge that is refunded automatically.
4. Each month the operator emails the invoice and charges the card. A declined card is retried every `BILLING_RETRY_HOURS`, up to `BILLING_MAX_ATTEMPTS` times, and then escalated.

Safeguards:
- Stripe calls use idempotency keys.
- An invoice that was interrupted mid-charge is never retried automatically.
- A paid invoice cannot be reissued.

Fees are worked out in USD. To charge in another currency, set `BILLING_CURRENCY` and `BILLING_FX_RATE`, for example `ngn` and `1600` on Paystack.

## Finding customers

Set `PROSPECTING_ENABLED=true`, `PUBLIC_BASE_URL`, `SENDER_ADDRESS` (your postal address; nothing is sent without it), and an email provider (`EMAIL_PROVIDER=resend` with `RESEND_API_KEY` and `EMAIL_FROM` on a domain you have verified with Resend).

- **Sources:** Hacker News "Show HN" launches matching `PROSPECT_QUERIES`, plus any domains you import with `POST /admin/prospects {"domains":[...]}`.
- **Review:** `GET /admin/prospects?state=drafted`, and `GET /admin/prospects/:id` to see the exact email.
- **Approve:** `POST /admin/prospects/approve-all`, or approve or reject one at a time. Set `OUTREACH_AUTO_SEND=true` to skip approval.
- **Built-in limits:** only public pages are read, robots.txt is honoured, private network addresses are refused, only role addresses are contacted, and there are at most 2 emails per company. Unsubscribes and existing customers are never contacted.

Anti-spam rules for cold email differ by country (for example, CAN-SPAM in the US, GDPR/PECR in the UK and EU, and the NDPA in Nigeria). Check which apply to the markets you email.

## Running the operator

- `OPERATOR_INTERVAL_MS=3600000` runs it hourly inside the server.
- `POST /admin/operator/run` runs it once and returns what it did.
- `POST /admin/operator/kill` and `/resume` set and clear the kill switch. Live rules keep running; pause them individually.
- `ESCALATION_WEBHOOK_URL` receives decisions that need a human: consent, approvals, rollbacks, unpaid invoices, signups and outreach waiting for approval.

## API

**Customer** (customer key):
- `POST /v1/chat/completions` (any provider) and `GET /v1/models`
- `POST /v1/messages` (Anthropic format; authenticates with `x-api-key` like the Anthropic SDK)
- `GET /v1/wastezero/summary`: their spend, savings and rules
- `GET` and `PATCH /v1/wastezero/settings`, `POST /v1/wastezero/resume`
- `GET /v1/wastezero/waste-report`
- `GET /v1/wastezero/statement?period=YYYY-MM`

**Public:**
- `GET /` (landing page), `GET /stats`
- `GET /audit`, `POST /audit`, `GET /audit/:id`
- `GET /health`
- `GET|POST /signup`
- `GET /billing/setup?token=`
- `GET|POST /unsubscribe?token=`
- `POST /webhooks/payments`

**Admin** (`WASTEZERO_ADMIN_KEY`):

| Area | Endpoints |
|---|---|
| Customers | `GET/POST /admin/tenants`, `PATCH /admin/tenants/:id`, `POST /admin/tenants/:id/rotate-key`, `POST /admin/tenants/:id/card-link`, `POST /admin/tenants/:id/pause` and `/resume` |
| Waste | `GET /admin/waste-report?tenant=` |
| Reporting | `GET /admin/summary?tenant=&from=&to=`, `GET /admin/events?tenant=&limit=`, `GET /admin/analysis?tenant=` |
| Rules | `GET/POST /admin/rules`, `POST /admin/rules/:id/transition {"to","reason"}` |
| Operator | `POST /admin/operator/run`, `GET /admin/operator/status`, `POST /admin/operator/kill`, `POST /admin/operator/resume`, `GET /admin/audit` |
| Billing | `GET /admin/invoices?tenant=&period=YYYY-MM[&format=html]`, `POST /admin/reconcile`, `POST /admin/billing/collect`, `POST /admin/invoices/:id/status` |
| Prospects | `GET/POST /admin/prospects`, `GET /admin/prospects/:id`, `POST /admin/prospects/:id/approve` and `/reject`, `POST /admin/prospects/approve-all`, `POST /admin/prospects/suppress`, `POST /admin/prospecting/run` |

## Data and privacy

- Prompts and answers are not written to disk. The answer-reuse store lives in memory, only for customers who allow it.
- Quality tests send a sample of requests to a second model and to a grader. Customers consent to this when they allow `route`. Only scores are kept.
- Request fingerprints are one-way hashes.
- Customer API keys are stored as SHA-256 hashes. Card references never appear in the admin API.
- All data lives in `DATA_DIR` as JSON and JSONL files with mode 0600. Protect the host and its backups.

## Before taking real customers

This release has been tested end to end against mock providers (59 tests). It has **not** been run against live Stripe, Paystack, Resend or OpenAI accounts. Run each one in test mode first.

Still to do before scale:
- Put HTTPS and a reverse proxy in front.
- Move from files to a database, and run a single instance until then: answer reuse and rule files are per process.
- Add Gemini's native API, the OpenAI Responses API, embeddings, and routing between providers.
- Have a lawyer review the savings-share contract and the outreach practice for each market.

## Layout

```
src/app.js          HTTP routes, proxy, admin and customer API
src/providers.js    provider list, choosing a provider per request, keys and headers
src/anthropic.js    automatic prompt caching, Anthropic answer conversion and errors
src/guard.js        budgets, loop breaker, spike alerts
src/audit.js        free audit from usage exports / OpenAI usage API
src/waste.js        waste report on proxied traffic
src/site.js         landing page, audit pages, public stats
src/optimizer.js    which rule applies to a request
src/evaluator.js    quality tests and grader
src/analyzer.js     waste detection
src/operator.js     autonomous loop and escalation
src/billing.js      invoices and reconciliation
src/collections.js  invoice emails and card charging
src/payments.js     Stripe and Paystack adapters
src/prospecting.js  finding customers and outreach
src/public.js       signup, card setup, unsubscribe, webhooks
test/               unit and integration tests with mock providers
scripts/            tenant CLI, one-off operator run
deploy/             systemd, Caddy, nginx, update script
```

Proprietary. All rights reserved, unless a separate written licence says otherwise.
