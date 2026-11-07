import test from "node:test";
import assert from "node:assert/strict";
import { resolveRate, estimateCost, costForTokens } from "../src/pricing.js";
import { loadConfig } from "../src/config.js";
import { normalizePolicy } from "../src/tenants.js";
import { plan, isCacheable } from "../src/optimizer.js";
import { computeInvoice, reconcile } from "../src/billing.js";
import { quickCompare } from "../src/evaluator.js";
import { analyze } from "../src/analyzer.js";
import { fingerprint, previousPeriod } from "../src/util.js";
import { RATES } from "./helpers.js";

test("prices dated snapshot names, never mixes up gpt-4o and gpt-4o-mini", () => {
  assert.equal(resolveRate("gpt-4o-mini-2024-07-18", RATES).key, "gpt-4o-mini");
  assert.equal(resolveRate("gpt-4o-2024-08-06", RATES).key, "gpt-4o");
  assert.equal(resolveRate("gpt-4o-mini-2024-07-18", { "gpt-4o": RATES["gpt-4o"] }), null);
  assert.equal(resolveRate("gpt-4o-audio-preview", RATES), null);
});

test("cached prompt tokens are priced at the discounted rate", () => {
  const full = estimateCost("gpt-4o", { prompt_tokens: 1000, completion_tokens: 0 }, RATES);
  const half = estimateCost("gpt-4o", { prompt_tokens: 1000, completion_tokens: 0, prompt_tokens_details: { cached_tokens: 1000 } }, RATES);
  assert.equal(full, 0.0025);
  assert.equal(half, 0.00125);
  assert.equal(costForTokens("unknown", { prompt: 1 }, RATES), null);
});

test("config rejects bad numbers and weak or shared keys", () => {
  assert.throws(() => loadConfig({ REQUEST_TIMEOUT_MS: "45s" }), /REQUEST_TIMEOUT_MS/);
  assert.throws(() => loadConfig({ PORT: "99999" }), /PORT/);
  assert.throws(() => loadConfig({ WASTEZERO_ADMIN_KEY: "short" }), /24 characters/);
  const k = "x".repeat(30);
  assert.throws(() => loadConfig({ WASTEZERO_ADMIN_KEY: k, WASTEZERO_API_KEY: k }), /differ/);
  assert.throws(() => loadConfig({ MODEL_RATES_JSON: '{"m":{"input":-1,"output":1}}' }), /input/);
  assert.throws(() => loadConfig({ MODEL_RATES_JSON: "{}", DOWNGRADE_MAP_JSON: '{"a":"b"}' }), /price/);
});

test("policy is observe-only by default and validated", () => {
  assert.deepEqual(normalizePolicy().allowedOptimizations, []);
  assert.throws(() => normalizePolicy({ allowedOptimizations: ["delete-prompts"] }));
  assert.throws(() => normalizePolicy({ revenueSharePct: 150 }));
});

test("fingerprint ignores user/stream fields but not content", () => {
  const a = { model: "m", messages: [{ role: "user", content: "hi" }], temperature: 0 };
  assert.equal(fingerprint(a), fingerprint({ temperature: 0, messages: [{ content: "hi", role: "user" }], model: "m", user: "u1", stream: true }));
  assert.notEqual(fingerprint(a), fingerprint({ ...a, messages: [{ role: "user", content: "hello" }] }));
});

test("only deterministic single-answer requests are reused by default", () => {
  const p = normalizePolicy();
  assert.equal(isCacheable({ temperature: 0 }, p), true);
  assert.equal(isCacheable({ temperature: 0.7 }, p), false);
  assert.equal(isCacheable({ temperature: 0, n: 2 }, p), false);
  assert.equal(isCacheable({ temperature: 0, stream: true }, p), false);
});

test("plan applies nothing the customer has not allowed", () => {
  const rule = { id: "r1", type: "route", target: "cheap", match: { model: "big" } };
  const rules = { match: (t, type, model, tag, state) => (type === "route" && state === "active" ? rule : null) };
  const body = { model: "big", messages: [] };
  const off = plan({ tenant: { id: "t", policy: normalizePolicy() }, body, rules, evalBudgetLeftUsd: 10 });
  assert.equal(off.effectiveModel, "big");
  const on = plan({ tenant: { id: "t", policy: normalizePolicy({ allowedOptimizations: ["route"] }) }, body, rules, evalBudgetLeftUsd: 10, random: () => 0 });
  assert.equal(on.effectiveModel, "cheap");
  assert.equal(on.evaluation.mode, "audit");
  const broke = plan({ tenant: { id: "t", policy: normalizePolicy({ allowedOptimizations: ["route"] }) }, body, rules, evalBudgetLeftUsd: 0, random: () => 0 });
  assert.equal(broke.evaluation, null);
});

test("invoice nets losses, floors the fee at zero, skips failed calls and other customers", () => {
  const tenant = { id: "t", name: "T", policy: normalizePolicy({ revenueSharePct: 25 }) };
  const e = (o) => ({ tenantId: "t", timestamp: "2026-09-10T00:00:00Z", status: 200, actualCostUsd: 1, baselineCostUsd: 1, savingsUsd: 0, optimization: null, ...o });
  const inv = computeInvoice({ tenant, period: "2026-09", events: [
    e({ optimization: "route", actualCostUsd: 1, baselineCostUsd: 5, savingsUsd: 4 }),
    e({ optimization: "cache", actualCostUsd: 0, baselineCostUsd: 2, savingsUsd: 2 }),
    e({ optimization: "route", actualCostUsd: 2, baselineCostUsd: 1, savingsUsd: -1 }),
    e({ optimization: "route", status: 500, savingsUsd: 99 }),
    e({ tenantId: "other", optimization: "route", savingsUsd: 99 }),
    e({ timestamp: "2026-10-01T00:00:00Z", optimization: "route", savingsUsd: 99 })
  ] });
  assert.equal(inv.savingsUsd, 5);
  assert.equal(inv.feeUsd, 1.25);
  assert.equal(inv.calls, 3);
  const loss = computeInvoice({ tenant, period: "2026-09", events: [e({ optimization: "route", savingsUsd: -3 })] });
  assert.equal(loss.feeUsd, 0);
  assert.equal(reconcile({ invoice: inv, providerBilledUsd: 3, tolerancePct: 5 }).withinTolerance, true);
  assert.equal(reconcile({ invoice: inv, providerBilledUsd: 10, tolerancePct: 5 }).withinTolerance, false);
});

test("quick comparison: identical passes, different tool call fails, truncation fails", () => {
  const ans = (content, extra = {}) => ({ choices: [{ message: { content, ...extra }, finish_reason: "stop" }] });
  assert.equal(quickCompare(ans("4"), ans("4")).passed, true);
  assert.equal(quickCompare(ans("hi"), ans("hello")).decided, false);
  const tool = (name, args) => ans(null, { tool_calls: [{ function: { name, arguments: JSON.stringify(args) } }] });
  assert.equal(quickCompare(tool("refund", { id: 1 }), tool("refund", { id: 1 })).passed, true);
  assert.equal(quickCompare(tool("refund", { id: 1 }), tool("refund", { id: 2 })).passed, false);
  assert.equal(quickCompare(ans("full"), { choices: [{ message: { content: "parti" }, finish_reason: "length" }] }).passed, false);
});

test("analyser proposes reuse for repeats and routing for short tasks", () => {
  const config = { modelRates: RATES, downgradeMap: { "gpt-4o": "gpt-4o-mini" } };
  const tenant = { id: "t", policy: normalizePolicy() };
  const now = Date.parse("2026-10-30T12:00:00Z");
  const events = Array.from({ length: 60 }, (_, i) => ({
    tenantId: "t", timestamp: new Date(now - 86400_000 + i * 1000).toISOString(), requestedModel: "gpt-4o", tag: null,
    fingerprint: `fp${i % 20}`, deterministic: true, status: 200, promptTokens: 1000, completionTokens: 200, actualCostUsd: 0.0045
  }));
  const { proposals } = analyze({ events, tenant, config, now });
  assert.deepEqual(proposals.map((p) => p.type).sort(), ["cache", "route"]);
  assert.equal(proposals.find((p) => p.type === "cache").evidence.repeatedCalls, 40);
  const long = events.map((e) => ({ ...e, completionTokens: 2000, fingerprint: Math.random() + "" }));
  assert.equal(analyze({ events: long, tenant, config, now }).proposals.length, 0);
});

test("previous billing period", () => {
  assert.equal(previousPeriod(new Date("2026-01-15T00:00:00Z")), "2025-12");
});
