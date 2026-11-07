import test from "node:test";
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { startMockProvider, startApp, waitFor, ask, ADMIN } from "./helpers.js";

let provider;
test.before(async () => { provider = await startMockProvider(); });
test.after(async () => { await provider.close(); });

async function customer(env, policy = {}) {
  const s = await startApp({ OPENAI_BASE_URL: provider.url, ...env });
  const { json } = await s.admin("POST", "/admin/tenants", { name: "Acme", policy });
  return { ...s, key: json.apiKey, tenantId: json.tenant.id };
}

test("keys are separated: customers cannot read admin data, admins cannot proxy", async () => {
  const s = await customer();
  assert.equal((await s.call("GET", "/health")).status, 200);
  assert.equal((await s.call("GET", "/admin/summary", { key: s.key })).status, 401);
  assert.equal((await s.chat(ADMIN, ask("hi"))).status, 401);
  assert.equal((await s.chat(s.key, ask("hi"))).status, 200);
  await s.close();
});

test("dated model names are priced; provider headers pass through; internal headers do not", async () => {
  const s = await customer();
  const r = await s.chat(s.key, ask("hello"));
  assert.equal(r.headers.get("x-request-id"), "req_123");
  assert.equal(r.headers.get("x-ratelimit-remaining-requests"), "99");
  assert.equal(r.headers.get("x-internal"), null);
  const [event] = await s.ctx.events.all();
  assert.equal(event.servedModel, "gpt-4o-2024-07-18");
  assert.equal(event.actualCostUsd, 0.0045);
  await s.close();
});

test("oversized body gets a clean 413", async () => {
  const s = await customer({ MAX_BODY_BYTES: "2048" });
  const r = await s.call("POST", "/v1/chat/completions", { key: s.key, raw: JSON.stringify(ask("x".repeat(10000))) });
  assert.equal(r.status, 413);
  await s.close();
});

test("a failed usage write never turns a paid answer into an error, and the server survives a broken store", async () => {
  const s = await customer();
  await mkdir(path.join(s.dataDir, "events.jsonl"), { recursive: true });   // make the event log unwritable
  const r = await s.chat(s.key, ask("still works"));
  assert.equal(r.status, 200);
  assert.equal((await s.admin("GET", "/admin/summary")).status, 500);
  assert.equal((await s.call("GET", "/health")).status, 200);
  await s.close();
});

test("customer's own provider key is used when sent", async () => {
  const s = await customer();
  provider.state.calls.length = 0;
  await s.chat(s.key, ask("byok"), { "x-upstream-authorization": "Bearer sk-customer" });
  assert.equal(provider.state.calls[0].auth, "Bearer sk-customer");
  await s.close();
});

test("streaming: usage is captured, the extra usage chunk is hidden unless asked for", async () => {
  const s = await customer();
  const r = await s.chat(s.key, ask("stream me", { stream: true }));
  assert.equal(r.status, 200);
  assert.match(r.text, /answer from gpt-4o/);
  assert.doesNotMatch(r.text, /"usage"/);
  assert.match(r.text, /\[DONE\]/);
  const r2 = await s.chat(s.key, ask("stream me", { stream: true, stream_options: { include_usage: true } }));
  assert.match(r2.text, /"usage"/);
  await waitFor(async () => (await s.ctx.events.all()).length === 2);
  const events = await s.ctx.events.all();
  assert.equal(events[0].promptTokens, 1000);
  assert.equal(events[0].actualCostUsd, 0.0045);
  await s.close();
});

test("without consent nothing is optimised; the operator asks instead", async () => {
  const s = await customer();
  for (let i = 0; i < 60; i++) await s.chat(s.key, ask(`q${i % 20}`));
  const report = (await s.admin("POST", "/admin/operator/run")).json;
  assert.equal(report.proposals.length, 2);
  assert.ok(report.escalations.every((e) => /not allowed/.test(e.message)));
  assert.equal(report.actions.length, 0);
  const r = await s.chat(s.key, ask("q1"));
  assert.equal(r.headers.get("x-wastezero-cache"), null);
  assert.equal(r.headers.get("x-wastezero-routed-from"), null);
  await s.close();
});

test("full loop: detect → test → go live → save → audit → roll back → invoice", async () => {
  provider.state.judgeAcceptable = true;
  const s = await customer({}, { allowedOptimizations: ["cache", "route"], autoShadow: true, autoPromote: true, minSamples: 5, shadowSampleRate: 1, auditSampleRate: 1, revenueSharePct: 20 });

  // 1. Observe: 60 calls, 20 distinct questions asked 3 times each, short answers on an expensive model.
  for (let i = 0; i < 60; i++) await s.chat(s.key, ask(`q${i % 20}`));
  let report = (await s.admin("POST", "/admin/operator/run")).json;
  assert.deepEqual(report.proposals.map((p) => p.type).sort(), ["cache", "route"]);
  const states = () => Object.fromEntries(s.ctx.rules.forTenant(s.tenantId).map((r) => [r.type, r.state]));
  assert.deepEqual(states(), { cache: "active", route: "shadow" });

  // 2. Shadow: customer still gets gpt-4o; a copy goes to gpt-4o-mini and is graded.
  for (let i = 0; i < 6; i++) {
    const r = await s.chat(s.key, ask(`new${i}`));
    assert.match(r.json.choices[0].message.content, /from gpt-4o to/);
  }
  const route = s.ctx.rules.forTenant(s.tenantId).find((r) => r.type === "route");
  await waitFor(() => route.stats.shadow.n >= 6);
  report = (await s.admin("POST", "/admin/operator/run")).json;
  assert.equal(states().route, "active");
  assert.match(report.actions[0].reason, /measured cost reduction 94/);

  // 3. Live: routed to the cheaper model, savings recorded per request.
  const live = await s.chat(s.key, ask("live1"));
  assert.equal(live.headers.get("x-wastezero-routed-from"), "gpt-4o");
  assert.match(live.json.choices[0].message.content, /from gpt-4o-mini/);
  let last = (await s.ctx.events.all()).at(-1);
  assert.equal(last.optimization, "route");
  assert.equal(last.savingsUsd, 0.00423);

  // 4. Reuse: same question again is answered from memory at zero cost.
  const again = await s.chat(s.key, ask("live1"));
  assert.equal(again.headers.get("x-wastezero-cache"), "hit");
  last = (await s.ctx.events.all()).at(-1);
  assert.equal(last.optimization, "cache");
  assert.equal(last.actualCostUsd, 0);
  assert.equal(last.savingsUsd, 0.0045);

  // 5. Quality slips: live audits fail, the operator rolls back and stops reusing answers.
  provider.state.judgeAcceptable = false;
  for (let i = 0; i < 12; i++) await s.chat(s.key, ask(`drift${i}`));
  await waitFor(() => route.stats.audit.recent.length >= 12);
  report = (await s.admin("POST", "/admin/operator/run")).json;
  assert.equal(states().route, "rolled_back");
  assert.ok(report.escalations.some((e) => /Rolled back/.test(e.message)));
  const after = await s.chat(s.key, ask("post-rollback"));
  assert.equal(after.headers.get("x-wastezero-routed-from"), null);

  // 6. Billing: savings this month, fee at 20%, reconciled against the provider bill.
  const period = new Date().toISOString().slice(0, 7);
  const preview = (await s.admin("GET", `/admin/invoices?tenant=${s.tenantId}&period=${period}`)).json.invoice;
  assert.ok(preview.savingsUsd > 0);
  assert.equal(preview.feeUsd, Math.round(preview.savingsUsd * 0.2 * 100) / 100);
  const good = (await s.admin("POST", "/admin/reconcile", { tenantId: s.tenantId, period, providerBilledUsd: preview.actualCostUsd })).json.invoice;
  assert.equal(good.status, "ready");
  const bad = (await s.admin("POST", "/admin/reconcile", { tenantId: s.tenantId, period, providerBilledUsd: preview.actualCostUsd * 2 + 1 })).json.invoice;
  assert.equal(bad.status, "needs_review");
  const html = await s.call("GET", `/admin/invoices?tenant=${s.tenantId}&period=${period}&format=html`, { key: ADMIN });
  assert.match(html.text, /Savings share \(20% of savings\)/);

  // 7. Customer sees only their own numbers.
  const mine = (await s.call("GET", "/v1/wastezero/summary", { key: s.key })).json;
  assert.ok(mine.thisMonth.savingsUsd > 0);
  const other = (await s.admin("POST", "/admin/tenants", { name: "Other" })).json;
  const theirs = (await s.call("GET", "/v1/wastezero/summary", { key: other.apiKey })).json;
  assert.equal(theirs.allTime.calls, 0);
  await s.close();
});

test("kill switch halts the operator; humans can still act", async () => {
  const s = await customer();
  await s.admin("POST", "/admin/operator/kill");
  assert.equal((await s.admin("POST", "/admin/operator/run")).json.halted, true);
  await s.admin("POST", "/admin/operator/resume");
  assert.equal((await s.admin("POST", "/admin/operator/run")).json.halted, false);
  await s.close();
});

test("route rules cannot skip testing unless a human decides", async () => {
  const s = await customer();
  const rule = (await s.admin("POST", "/admin/rules", { tenantId: s.tenantId, type: "route", match: { model: "gpt-4o" }, target: "gpt-4o-mini" })).json.rule;
  await assert.rejects(s.ctx.rules.transition(rule.id, "active", { actor: "operator", reason: "x" }), /shadow testing/);
  assert.equal((await s.admin("POST", `/admin/rules/${rule.id}/transition`, { to: "active", reason: "customer asked" })).status, 200);
  await s.close();
});
