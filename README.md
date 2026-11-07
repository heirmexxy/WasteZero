# WasteZero
### Make AI application spending visible. Reduce waste without sacrificing quality.

WasteZero is an observe-first cost visibility and optimization layer for applications that call language-model APIs. It sits between your application and an OpenAI-compatible chat-completions endpoint, records usage metadata, estimates spend using rates you configure, and surfaces opportunities for review.

**Product promise:** understand where inference money goes, identify avoidable spend, test safer alternatives, and only claim savings after independently verifying them.

## What this release does

- OpenAI-compatible `POST /v1/chat/completions` proxy.
- Client API-key authentication using `Authorization: Bearer ...`.
- Request-size limits, upstream timeout, JSON validation and upstream error handling.
- Usage capture from provider responses (`prompt_tokens`, `completion_tokens`, `total_tokens`).
- Configurable per-million-token cost rates.
- Persistent local JSONL event storage.
- Authenticated `GET /admin/summary` reporting calls, tokens and estimated cost by model.
- Authenticated `GET /admin/events` for recent metadata-only events.
- Conservative, observe-only policy recommendations. It does **not** silently change models or prompts.
- Tests using Node's built-in test runner; no runtime dependencies.

## Quick start

Requirements: Node.js 20 or later.

1. Copy `.env.example` to `.env`.
2. Set `WASTEZERO_API_KEY` to a long random secret.
3. Set `OPENAI_API_KEY` to your provider key.
4. Review and update `MODEL_RATES_JSON` using current provider pricing.
5. Run:

```bash
npm run check
npm test
npm start
```

The proxy listens on `http://localhost:8787` by default.

## Point your application at WasteZero

Change the OpenAI base URL in your application to `http://localhost:8787/v1` and use the `WASTEZERO_API_KEY` as the API key for the proxy. WasteZero uses its own `OPENAI_API_KEY` when forwarding to the provider.

Example:

```bash
curl http://localhost:8787/v1/chat/completions \
  -H "Authorization: Bearer $WASTEZERO_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-4o-mini",
    "messages": [{"role":"user","content":"Summarise this sentence."}]
  }'
```

## Admin reporting

```bash
curl http://localhost:8787/admin/summary \
  -H "Authorization: Bearer $WASTEZERO_API_KEY"
```

```bash
curl "http://localhost:8787/admin/events?limit=20" \
  -H "Authorization: Bearer $WASTEZERO_API_KEY"
```

## Data and privacy

WasteZero stores only operational metadata by default: timestamp, model, token counts, estimated cost, status and latency. It does not persist prompts, completions, authorization headers, or provider API keys. The proxy must still receive prompt content transiently to forward the request to the model provider.

Local event data is written to `DATA_DIR/events.jsonl`. Protect the host and its backups. This MVP has no encryption-at-rest, tenant isolation, retention scheduler, or external database.

## How cost estimates work

For each model, `MODEL_RATES_JSON` contains USD cost per one million input and output tokens. WasteZero estimates:

`(input_tokens × input_rate + output_tokens × output_rate) / 1,000,000`

The estimate is not an invoice. Provider pricing, cached-token pricing, tool charges, discounts, taxes, and other billing rules may differ. Confirm against your provider bill.

## Optimization workflow

1. Observe actual usage and spend.
2. Identify expensive or unusually repetitive usage.
3. Form a candidate change (for example, a smaller model for a narrow task).
4. Evaluate candidate output quality on representative test cases.
5. Obtain explicit customer approval before rollout.
6. Compare like-for-like usage and quality after rollout.
7. Claim savings only when the baseline, measurement window, quality guardrails and calculation are documented.

This release only provides the first two steps plus conservative recommendations. It does not execute optimization changes or certify savings.

## API

- `GET /health` — health check.
- `POST /v1/chat/completions` — forwards chat-completions requests.
- `GET /admin/summary` — aggregate usage and estimated cost.
- `GET /admin/events?limit=50` — recent metadata events.

All routes except `/health` require the WasteZero bearer key. The proxy currently supports non-streaming JSON requests only. Streaming, embeddings, audio, images, batch APIs and other endpoints are not implemented.

## Naïve / Vetta integration

The `skills/` directory contains initial agent operating instructions. They are framework-neutral and do not establish permissions. A Naïve/Vetta adapter is intentionally not enabled in this release: configure it only against the current official SDK/API documentation, then enforce credentials, budgets, approvals, audit logs and a kill switch outside the skill text.

## Production-readiness gaps

Do not expose this MVP directly to the public internet or use it as a production billing authority. Before production, add:
- durable database, migrations, tenant isolation and access roles;
- secret management, TLS/reverse proxy, rate limiting and abuse controls;
- streaming support and provider-specific endpoint coverage;
- robust pricing catalogue, cached-token and tool-cost accounting;
- retention controls, encryption at rest, backups and observability;
- evaluation harness, quality guardrails, approval workflow and rollback;
- independent savings verification and billing reconciliation.

## Repository layout

```text
src/       proxy, auth, cost calculation, policy and persistence
test/      automated tests
skills/    initial agent instructions
docs/      product and architecture notes
```

## License

Proprietary — all rights reserved, unless a separate written licence says otherwise.
