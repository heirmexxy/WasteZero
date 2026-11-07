import test from "node:test";
import assert from "node:assert/strict";
import { startMockProvider, startApp, waitFor, ask, ADMIN, RATES } from "./helpers.js";
import { parseUsage, auditReport } from "../src/audit.js";

let provider;
test.before(async () => { provider = await startMockProvider(); });
test.after(async () => { await provider.close(); });

async function customer(policy = {}, env = {}) {
  const s = await startApp({ OPENAI_BASE_URL: provider.url, ...env });
  const { json } = await s.admin("POST", "/admin/tenants", { name: "Acme", email: "ops@acme.test", policy });
  return { ...s, key: json.apiKey, tenantId: json.tenant.id };
}
const outbox = async (s, kind) => (await s.ctx.outbox.all()).filter((m) => !kind || m.kind === kind);

test("regression: unsupported customer paths return a clean 404, never a 500; /v1/models passes through", async () => {
  const s = await customer();
  for (const [method, path] of [["POST", "/v1/embeddings"], ["GET", "/v1/files"], ["POST", "/v1/responses"], ["DELETE", "/v1/chat/completions"]]) {
    const r = await s.call(method, path, { key: s.key, body: method === "GET" ? undefined : {} });
    assert.equal(r.status, 404, `${method} ${path}`);
    assert.equal(r.json.error.code, "unsupported_endpoint");
  }
  const models = await s.call("GET", "/v1/models", { key: s.key });
  assert.equal(models.status, 200);
  assert.equal(models.json.data[0].id, "gpt-4o");
  assert.equal(models.headers.get("x-request-id"), "req_models");
  const anon = await s.call("GET", "/v1/models");
  assert.equal(anon.status, 401);
  assert.equal(anon.json.error.code, "invalid_api_key");
  await s.close();
});

test("home page, stats and audit page are public HTML/JSON", async () => {
  const s = await customer();
  const home = await s.call("GET", "/");
  assert.equal(home.status, 200);
  assert.match(home.text, /Find where your AI money leaks/);
  assert.equal((await s.call("GET", "/audit")).status, 200);
  const stats = await s.call("GET", "/stats");
  assert.equal(stats.json.customers, 1);
  await s.close();
});

test("added delay is measured and returned on every proxied answer", async () => {
  const s = await customer();
  const r = await s.chat(s.key, ask("hi"));
  assert.match(r.headers.get("x-wastezero-overhead-ms"), /^\d+$/);
  await waitFor(async () => (await s.ctx.events.all()).length === 1);
  assert.ok(Number.isFinite((await s.ctx.events.all())[0].overheadMs));
  await s.close();
});

test("daily budget: blocks once reached and alerts the customer once", async () => {
  const s = await customer({ budgets: { dailyUsd: 0.01 } });
  const statuses = [];
  for (let i = 0; i < 4; i++) statuses.push((await s.chat(s.key, ask(`b${i}`))).status);
  assert.deepEqual(statuses, [200, 200, 200, 429]);       // $0.0045 each: blocked after $0.0135 > $0.01
  const blocked = await s.chat(s.key, ask("again"));
  assert.equal(blocked.json.error.code, "budget_exceeded");
  await waitFor(async () => (await outbox(s, "alert")).length >= 1);
  assert.equal((await outbox(s, "alert")).length, 1);
  assert.match((await outbox(s, "alert"))[0].text, /Daily budget of \$0.01 reached/);
  await s.close();
});

test("alert-only budgets never block traffic", async () => {
  const s = await customer({ budgets: { dailyUsd: 0.001 }, budgetAction: "alert" });
  for (let i = 0; i < 3; i++) assert.equal((await s.chat(s.key, ask(`a${i}`))).status, 200);
  await waitFor(async () => (await outbox(s, "alert")).length === 1);
  await s.close();
});

test("per-feature and per-end-user budgets", async () => {
  const s = await customer({ budgets: { perTagDailyUsd: { "support-bot": 0.004 }, perUserDailyUsd: 0.004 } });
  assert.equal((await s.chat(s.key, ask("t1"), { "x-wastezero-tag": "support-bot" })).status, 200);
  assert.equal((await s.chat(s.key, ask("t2"), { "x-wastezero-tag": "support-bot" })).json.error.code, "budget_exceeded");
  assert.equal((await s.chat(s.key, ask("t3"), { "x-wastezero-tag": "search" })).status, 200);
  assert.equal((await s.chat(s.key, ask("u1", { user: "alice" }))).status, 200);
  assert.equal((await s.chat(s.key, ask("u2", { user: "alice" }))).status, 429);
  assert.equal((await s.chat(s.key, ask("u3", { user: "bob" }))).status, 200);
  const events = await s.ctx.events.all();
  assert.ok(!JSON.stringify(events).includes("alice"));    // end users are stored hashed
  await s.close();
});

test("loop breaker blocks a runaway repeat but lets other requests through", async () => {
  const s = await customer({ loopBreaker: { maxRepeats: 3, windowSec: 60, action: "block" } });
  const r = [];
  for (let i = 0; i < 5; i++) r.push((await s.chat(s.key, ask("same question"))).status);
  assert.deepEqual(r, [200, 200, 200, 429, 429]);
  assert.equal((await s.chat(s.key, ask("same question"))).json.error.code, "loop_detected");
  assert.equal((await s.chat(s.key, ask("different question"))).status, 200);
  await s.close();
});

test("spending spike pauses traffic until the customer resumes", async () => {
  const s = await customer({ spikeAlert: { factor: 5, minHourlyUsd: 0.001, action: "pause" } });
  const now = Date.now();
  for (let h = 1; h <= 8; h++) s.ctx.meter.add({ tenantId: s.tenantId, timestamp: new Date(now - h * 3600_000).toISOString(), actualCostUsd: 0.001 });
  assert.equal((await s.chat(s.key, ask("s1"))).status, 200);
  assert.equal((await s.chat(s.key, ask("s2"))).status, 200);   // $0.009 this hour vs $0.001 normal
  const paused = await s.chat(s.key, ask("s3"));
  assert.equal(paused.status, 429);
  assert.equal(paused.json.error.code, "wastezero_paused");
  assert.equal((await s.call("POST", "/v1/wastezero/resume", { key: s.key, body: {} })).status, 200);
  assert.equal((await s.chat(s.key, ask("s4"))).status, 200);
  await s.close();
});

test("customers manage their own safety settings, but not commercial terms", async () => {
  const s = await customer();
  const patch = (body) => s.call("PATCH", "/v1/wastezero/settings", { key: s.key, body });
  assert.equal((await patch({ revenueSharePct: 1 })).status, 400);
  assert.equal((await patch({ alertWebhookUrl: "http://insecure.test/hook" })).status, 400);
  assert.equal((await patch({ loopBreaker: { action: "explode" } })).status, 400);
  const ok = await patch({ budgets: { dailyUsd: 50 }, loopBreaker: { action: "block" }, cacheTags: ["faq"] });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.settings.budgets.dailyUsd, 50);
  assert.equal(ok.json.settings.loopBreaker.maxRepeats, 20);   // unchanged fields keep their values
  assert.equal(s.ctx.tenants.get(s.tenantId).policy.revenueSharePct, 20);
  await s.close();
});

test("answer reuse at any temperature for features the customer opted in", async () => {
  const s = await customer({ allowedOptimizations: ["cache"], cacheTags: ["faq"] });
  const rule = (await s.admin("POST", "/admin/rules", { tenantId: s.tenantId, type: "cache", match: { model: "gpt-4o" } })).json.rule;
  await s.admin("POST", `/admin/rules/${rule.id}/transition`, { to: "active" });
  const warm = { ...ask("opening hours?"), temperature: 0.7 };
  await s.chat(s.key, warm, { "x-wastezero-tag": "faq" });
  assert.equal((await s.chat(s.key, warm, { "x-wastezero-tag": "faq" })).headers.get("x-wastezero-cache"), "hit");
  await s.chat(s.key, warm, { "x-wastezero-tag": "chat" });
  assert.equal((await s.chat(s.key, warm, { "x-wastezero-tag": "chat" })).headers.get("x-wastezero-cache"), null);
  await s.close();
});

test("waste report finds loops and repeats in proxied traffic; statement lists every request", async () => {
  const s = await customer();
  for (let i = 0; i < 12; i++) await s.chat(s.key, ask("loop me"));
  const r = (await s.call("GET", "/v1/wastezero/waste-report", { key: s.key })).json;
  const loops = r.findings.find((f) => f.kind === "loops");
  assert.equal(loops.confidence, "measured");
  assert.ok(loops.monthlyUsd > 0);
  const csv = await s.call("GET", `/v1/wastezero/statement?period=${new Date().toISOString().slice(0, 7)}`, { key: s.key });
  assert.match(csv.headers.get("content-type"), /text\/csv/);
  assert.equal(csv.text.trim().split("\n").length, 13);
  assert.ok(!/loop me/.test(csv.text));
  await s.close();
});

// ---------------------------------------------------------------- free audit

const config = { modelRates: RATES, downgradeMap: { "gpt-4o": "gpt-4o-mini" } };

test("audit parses OpenAI usage pages and CSV exports with different column names", () => {
  const page = JSON.stringify({ object: "page", data: [{ start_time: 1767225600, results: [{ object: "organization.usage.completions.result", model: "gpt-4o-2024-08-06", input_tokens: 5000, input_cached_tokens: 1000, output_tokens: 200, num_model_requests: 10, batch: false }] }] });
  const [row] = parseUsage(page);
  assert.equal(row.model, "gpt-4o-2024-08-06");
  assert.equal(row.cachedTokens, 1000);
  assert.equal(row.date, "2026-01-01");
  const csv = 'Date,Model,n_context_tokens_total,n_generated_tokens_total,num_model_requests\n2026-10-01,gpt-4o,"1,000",100,2\n2026-10-02,gpt-4o,2000,200,4\n';
  const rows = parseUsage(csv.replace('"1,000"', "1000"));
  assert.equal(rows.length, 2);
  assert.equal(rows[1].inputTokens, 2000);
  assert.throws(() => parseUsage(""), /empty/);
});

test("audit report: model mix, prompt caching, batch and spikes, each with $/month and confidence", () => {
  const rows = [];
  for (let d = 1; d <= 30; d++) {
    const date = `2026-10-${String(d).padStart(2, "0")}`;
    const spike = d === 15 ? 10 : 1;
    rows.push({ date, model: "gpt-4o", inputTokens: 3_000_000 * spike, cachedTokens: 0, outputTokens: 100_000 * spike, requests: 1000 * spike, batch: false, costUsd: null });
  }
  const r = auditReport(rows, config);
  const kinds = Object.fromEntries(r.findings.map((f) => [f.kind, f]));
  assert.ok(kinds.model_mix.monthlyUsd > 0 && kinds.model_mix.confidence === "estimated");
  assert.ok(kinds.prompt_caching.monthlyUsd > 0);
  assert.ok(kinds.batch.monthlyUsd > 0);
  assert.equal(kinds.spikes.confidence, "measured");
  assert.match(kinds.spikes.detail, /2026-10-15/);
  assert.ok(r.monthlySpendUsd > 0 && r.monthlyOpportunityUsd > 0);
});

test("audit end to end: upload → report page; OpenAI connection never stores the admin key", async () => {
  const csv = "date,model,input_tokens,output_tokens,requests\n" + Array.from({ length: 10 }, (_, i) => `2026-10-${String(i + 1).padStart(2, "0")},gpt-4o,2000000,50000,800`).join("\n");
  const s = await startApp({ OPENAI_ADMIN_BASE_URL: "http://oa.test/v1", PUBLIC_BASE_URL: "http://wz.test" }, {
    fetch: async (url, init = {}) => {
      if (String(url).startsWith("http://oa.test/v1/organization/usage/completions")) {
        assert.equal(init.headers.authorization, "Bearer sk-admin-secret");
        return new Response(JSON.stringify({ data: [{ start_time: 1761955200, results: [{ model: "gpt-4o", input_tokens: 4_000_000, input_cached_tokens: 0, output_tokens: 90_000, num_model_requests: 900, batch: false }] }], has_more: false }), { status: 200 });
      }
      return new Response("{}", { status: 404 });
    }
  });
  const up = await s.call("POST", "/audit", { body: { source: "upload", content: csv, email: "cto@lead.test" } });
  assert.equal(up.status, 201);
  const view = await s.call("GET", `/audit/${up.json.id}`);
  assert.match(view.text, /a month of possible savings/);
  assert.match(view.text, /estimated/);
  assert.equal((await s.ctx.outbox.all()).filter((m) => m.kind === "audit").length, 1);

  const oa = await s.call("POST", "/audit", { body: { source: "openai", adminKey: "sk-admin-secret" } });
  assert.equal(oa.status, 201);
  const raw = JSON.stringify(await s.ctx.audits.all()) + JSON.stringify(await s.ctx.audit.all());
  assert.ok(!raw.includes("sk-admin-secret"));
  assert.equal((await s.call("POST", "/audit", { body: { source: "upload", content: "a,b\n1,2" } })).status, 400);
  assert.equal((await s.call("GET", "/audit/a_doesnotexist0")).status, 404);
  await s.close();
});

test("paystack card setup is confirmed on return from checkout, without a webhook", async () => {
  const calls = [];
  const s = await startApp({ PAYMENT_PROVIDER: "paystack", PAYSTACK_SECRET_KEY: "sk_ps", PAYSTACK_API_BASE: "http://paystack.test", PUBLIC_BASE_URL: "http://wz.test" }, {
    fetch: async (url, init = {}) => {
      const u = new URL(url);
      calls.push(u.pathname);
      if (u.pathname === "/transaction/verify/ref_9") return new Response(JSON.stringify({ status: true, data: { status: "success", reference: "ref_9", metadata: { tenant_id: tid, purpose: "card_setup" }, authorization: { authorization_code: "AUTH_9", reusable: true, last4: "1234", brand: "mastercard" }, customer: { email: "x@y.test" } } }), { status: 200 });
      if (u.pathname === "/refund") return new Response(JSON.stringify({ status: true, data: {} }), { status: 200 });
      return new Response("{}", { status: 404 });
    }
  });
  const { json } = await s.admin("POST", "/admin/tenants", { name: "PS", email: "x@y.test" });
  var tid = json.tenant.id;
  const r = await s.call("GET", "/billing/done?trxref=ref_9&reference=ref_9");
  assert.match(r.text, /mastercard ending 1234/);
  assert.equal(s.ctx.tenants.get(tid).billing.status, "card_on_file");
  assert.ok(calls.includes("/refund"));
  await s.close();
});
