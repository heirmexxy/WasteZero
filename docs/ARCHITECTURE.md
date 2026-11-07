# Architecture (0.4.0)

```text
 Hacker News / imports ──> prospecting ──> outreach email ──> /signup ──> customer (observe-only)
                                                                             │
 customer app ──(wz key + own provider key + tag)──> proxy ──> provider      │
                                                       │                     │
                          plan(): reuse? route? sample for testing?          │
                                                       │                     │
                              events.jsonl (tokens, cost, baseline, saving)  │
                                                       │                     │
 operator (timer) ── analyse ── propose ── shadow test ── promote ── audit ── roll back
        │                                                                    │
        └── invoice (savings share + base fee) ── reconcile ── email ── charge card (Stripe/Paystack)
                                                                     webhooks ─┘
        └── escalations ──> webhook (human)            kill switch ──> operator stops
```

## Rule lifecycle
`proposed → shadow → active → (paused | rolled_back)`, with `rejected` out of shadow.
- Routing must pass shadow testing before going live. Only a human admin can skip it.
- Reuse rules can go live directly, because they only replay exact repeats of deterministic requests.

## Invoice lifecycle
`draft → ready | needs_review → charging → paid | payment_failed | awaiting_card | pending`, plus `no_charge` and `void`.
The log is append-only; the latest record per customer and period wins.

## Trust boundaries
- **Customer key:** proxy plus that customer's own summary.
- **Admin key:** everything else. The two must differ.
- **Public endpoints:** signed, expiring links (HMAC); payment webhooks verified by provider signature.
- **Provider key:** the customer's own (`X-Upstream-Authorization`) or WasteZero's. Quality tests and grading always use WasteZero's key and budget.
- **Website reads for prospecting:** public addresses only, with redirects re-checked. DNS rebinding is not fully prevented. Run the server with restricted outbound network access in production.

## Design principles
- Nothing changes for a customer without their written policy.
- Prove quality on real traffic before and after a change.
- Measure savings per request, against the model the customer asked for.
- Unknown prices are unknown, not zero.
- Bookkeeping never turns a paid answer into an error.
- Charge only reconciled invoices, never twice, and stop for a human when unsure.
