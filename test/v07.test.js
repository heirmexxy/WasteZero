import test from "node:test";
import assert from "node:assert/strict";
import { startMockProvider, startApp, waitFor, ask, ADMIN } from "./helpers.js";
import { economics, forecastMonth } from "../src/economics.js";
import { computeInvoice } from "../src/billing.js";
import { normalizePolicy } from "../src/tenants.js";

let provider;
test.before(async () => { provider = await startMockProvider(); });
test.after(async () => { await provider.close(); });

async function setup(env = {}, policy = {}, opts = {}) {
  const s = await startApp({ OPENAI_BASE_URL: provider.url, PUBLIC_BASE_URL: "http://wz.test", ...env }, opts);
  const { json } = await s.admin("POST", "/admin/tenants", { name: "Acme", email: "ops@acme.test", policy });
  return { ...s, key: json.apiKey, tenantId: json.tenant.id };
}
const cookieOf = (r) => (r.headers.get("set-cookie") || "").split(";")[0];
async function raw(s, method, path, { cookie, body, form, headers = {} } = {}) {
  const r = await fetch(s.base + path, { method, redirect: "manual",
    headers: { ...(cookie ? { cookie } : {}), ...(form ? { "content-type": "application/x-www-form-urlencoded" } : body ? { "content-type": "application/json" } : {}), ...headers },
    body: form ? new URLSearchParams(form).toString() : body ? JSON.stringify(body) : undefined });
  const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch {}
  return { status: r.status, headers: r.headers, text, json };
}
const signIn = async (s) => cookieOf(await raw(s, "POST", "/signin/key", { form: { apiKey: s.key } }));
const ui = { "x-wz-ui": "1" };

test("every page has the header with a way back and a sign-in link; legal and docs pages exist", async () => {
  const s = await setup();
  for (const p of ["/", "/signup", "/signin", "/audit", "/pricing", "/docs", "/privacy", "/terms"]) {
    const r = await raw(s, "GET", p);
    assert.equal(r.status, 200, p);
    assert.match(r.text, /<a class="brand" href="\/"><img src="\/brand\/wastezero-logo.svg" alt="WasteZero"/, p);
    assert.match(r.text, /href="\/signin"/, p);
  }
  assert.match((await raw(s, "GET", "/signup")).text, /Already have an account\? <a href="\/signin">/);
  await s.close();
});

test("sign in with an API key; the dashboard needs a session", async () => {
  const s = await setup();
  assert.equal((await raw(s, "GET", "/app")).headers.get("location"), "/signin");
  assert.equal((await raw(s, "POST", "/signin/key", { form: { apiKey: "wz_wrong" } })).status, 401);
  const cookie = await signIn(s);
  assert.match(cookie, /^wz_s=/);
  const page = await raw(s, "GET", "/app", { cookie });
  assert.equal(page.status, 200);
  assert.match(page.text, /Acme/);
  assert.equal((await raw(s, "GET", "/app/api/overview")).status, 401);
  await s.close();
});

test("email sign-in link works once; unknown emails get the same answer and no email", async () => {
  const s = await setup();
  const ask1 = await raw(s, "POST", "/signin", { form: { email: "ops@acme.test" } });
  const ask2 = await raw(s, "POST", "/signin", { form: { email: "nobody@else.test" } });
  assert.match(ask1.text, /If that email has an account/);
  assert.match(ask2.text, /If that email has an account/);
  const mails = (await s.ctx.outbox.all()).filter((m) => m.kind === "signin");
  assert.equal(mails.length, 1);
  const link = mails[0].text.match(/(http:\/\/wz\.test\/signin\/verify\?token=\S+)/)[1].replace("http://wz.test", "");
  const first = await raw(s, "GET", link);
  assert.equal(first.status, 303);
  assert.equal(first.headers.get("location"), "/app");
  assert.match(cookieOf(first), /^wz_s=/);
  assert.equal((await raw(s, "GET", link)).status, 400);     // used once
  await s.close();
});

test("customer dashboard API: first-request indicator, changes need the dashboard header, keys, settings", async () => {
  const s = await setup();
  const cookie = await signIn(s);
  let o = (await raw(s, "GET", "/app/api/overview", { cookie })).json;
  assert.equal(o.firstRequestAt, null);
  await s.chat(s.key, ask("hello"));
  await waitFor(async () => (await s.ctx.events.all()).length === 1);
  o = (await raw(s, "GET", "/app/api/overview", { cookie })).json;
  assert.ok(o.firstRequestAt);
  assert.equal(o.month.requests, 1);

  assert.equal((await raw(s, "POST", "/app/api/keys", { cookie, body: { label: "prod" } })).status, 403);   // no header: refused
  const created = (await raw(s, "POST", "/app/api/keys", { cookie, body: { label: "prod" }, headers: ui })).json;
  assert.match(created.apiKey, /^wz_/);
  assert.equal((await s.chat(created.apiKey, ask("with new key"))).status, 200);
  const keys = (await raw(s, "GET", "/app/api/keys", { cookie })).json.keys;
  assert.equal(keys.length, 2);
  assert.ok(!JSON.stringify(keys).includes("hash"));
  assert.equal((await raw(s, "DELETE", `/app/api/keys/${created.key.id}`, { cookie, headers: ui })).status, 200);
  assert.equal((await s.chat(created.apiKey, ask("revoked"))).status, 401);

  assert.equal((await raw(s, "PATCH", "/app/api/settings", { cookie, headers: ui, body: { revenueSharePct: 1 } })).status, 400);
  const saved = await raw(s, "PATCH", "/app/api/settings", { cookie, headers: ui, body: { budgets: { dailyUsd: 25 }, planPrices: { pro: 49 }, keepTestSamples: true } });
  assert.equal(saved.status, 200);
  assert.equal(saved.json.settings.budgets.dailyUsd, 25);
  assert.equal(saved.json.settings.planPrices.pro, 49);
  assert.equal((await raw(s, "POST", "/app/api/pause", { cookie, headers: ui })).status, 200);
  assert.equal((await s.chat(s.key, ask("while paused"))).json.error.code, "wastezero_paused");
  await raw(s, "POST", "/app/api/resume", { cookie, headers: ui });
  assert.equal((await s.chat(s.key, ask("after resume"))).status, 200);
  await s.close();
});

test("approvals: customer approves testing (which records consent); can't approve before tests pass; can't touch other customers' rules", async () => {
  const s = await setup();
  const cookie = await signIn(s);
  const rule = (await s.admin("POST", "/admin/rules", { tenantId: s.tenantId, type: "route", match: { model: "gpt-4o" }, target: "gpt-4o-mini" })).json.rule;
  let r = await raw(s, "POST", `/app/api/rules/${rule.id}/approve`, { cookie, headers: ui });
  assert.equal(r.json.rule.state, "shadow");
  assert.ok(s.ctx.tenants.get(s.tenantId).policy.allowedOptimizations.includes("route"));
  r = await raw(s, "POST", `/app/api/rules/${rule.id}/approve`, { cookie, headers: ui });
  assert.equal(r.status, 409);
  assert.match(r.json.error, /Still testing: 0\/30/);
  const other = (await s.admin("POST", "/admin/tenants", { name: "Other" })).json;
  const theirs = (await s.admin("POST", "/admin/rules", { tenantId: other.tenant.id, type: "cache", match: { model: "gpt-4o" } })).json.rule;
  assert.equal((await raw(s, "POST", `/app/api/rules/${theirs.id}/approve`, { cookie, headers: ui })).status, 404);
  assert.equal((await raw(s, "POST", `/app/api/rules/${rule.id}/reject`, { cookie, headers: ui })).json.rule.state, "rejected");
  await s.close();
});

test("quality test samples are kept only with the customer's opt-in, for side-by-side review", async () => {
  const s = await setup({}, { allowedOptimizations: ["route"], shadowSampleRate: 1, keepTestSamples: true });
  const rule = (await s.admin("POST", "/admin/rules", { tenantId: s.tenantId, type: "route", match: { model: "gpt-4o" }, target: "gpt-4o-mini" })).json.rule;
  await s.admin("POST", `/admin/rules/${rule.id}/transition`, { to: "shadow" });
  await s.chat(s.key, ask("compare me"));
  await waitFor(() => (s.ctx.rules.get(rule.id).samples || []).length === 1);
  const sample = s.ctx.rules.get(rule.id).samples[0];
  assert.match(sample.original, /answer from gpt-4o to compare me/);
  assert.match(sample.cheaper, /answer from gpt-4o-mini/);
  assert.equal(sample.request, "compare me");

  const off = await setup({}, { allowedOptimizations: ["route"], shadowSampleRate: 1 });
  const r2 = (await off.admin("POST", "/admin/rules", { tenantId: off.tenantId, type: "route", match: { model: "gpt-4o" }, target: "gpt-4o-mini" })).json.rule;
  await off.admin("POST", `/admin/rules/${r2.id}/transition`, { to: "shadow" });
  await off.chat(off.key, ask("private"));
  await waitFor(() => off.ctx.rules.get(r2.id).stats.shadow.n === 1);
  assert.equal(off.ctx.rules.get(r2.id).samples, undefined);
  await s.close(); await off.close();
});

test("admin console: sign in with the admin key; cookie works for the admin API, changes need the console header", async () => {
  const s = await setup();
  assert.match((await raw(s, "GET", "/console")).text, /Admin key/);
  assert.equal((await raw(s, "POST", "/console/signin", { form: { adminKey: "nope" } })).status, 401);
  const cookie = cookieOf(await raw(s, "POST", "/console/signin", { form: { adminKey: ADMIN } }));
  assert.match(cookie, /^wz_a=/);
  assert.match((await raw(s, "GET", "/console", { cookie })).text, /Admin console/);
  const o = (await raw(s, "GET", "/admin/overview", { cookie })).json;
  assert.equal(o.customers, 1);
  assert.equal(o.tenants[0].name, "Acme");
  assert.equal((await raw(s, "POST", "/admin/tenants", { cookie, body: { name: "X" } })).status, 401);
  assert.equal((await raw(s, "POST", "/admin/tenants", { cookie, body: { name: "X" }, headers: ui })).status, 201);
  const customerCookie = await signIn(s);
  assert.equal((await raw(s, "GET", "/admin/overview", { cookie: customerCookie })).status, 401);
  await s.close();
});

test("profit per customer and plan; forecast", () => {
  const tenant = { id: "t", policy: normalizePolicy({ planPrices: { free: 0, pro: 10 } }) };
  const now = new Date("2026-11-20T12:00:00Z");
  const e = (user, plan, cost) => ({ tenantId: "t", timestamp: "2026-11-05T10:00:00Z", status: 200, endUser: user, plan, actualCostUsd: cost });
  const r = economics({ now, tenant, events: [e("a", "pro", 4), e("a", "pro", 3), e("b", "pro", 12), e("c", "free", 1), { tenantId: "t", timestamp: "2026-11-05T10:00:00Z", status: 200, actualCostUsd: 2 }] });
  assert.equal(r.userCount, 3);
  assert.equal(r.losingUsers, 2);                     // b costs 12 on a 10 plan; c costs 1 on a free plan
  assert.equal(r.users[0].user, "b");
  assert.equal(r.users[0].marginUsd, -2);
  const pro = r.plans.find((p) => p.plan === "pro");
  assert.equal(pro.avgCostPerUserUsd, 9.5);
  assert.equal(pro.avgMarginPerUserUsd, 0.5);
  assert.equal(r.untrackedCostUsd, 2);
  const f = forecastMonth(100, new Date("2026-11-11T00:00:00Z"));
  assert.equal(f.projectedUsd, 300);                  // 10 days elapsed of 30
  assert.equal(forecastMonth(5, new Date("2026-11-01T06:00:00Z")).projectedUsd, null);
});

test("usage on WasteZero's own keys is billed at cost plus markup; customer-key usage is not", () => {
  const tenant = { id: "t", name: "T", policy: normalizePolicy() };
  const ev = (keySource, cost) => ({ tenantId: "t", timestamp: "2026-10-03T00:00:00Z", status: 200, keySource, actualCostUsd: cost, baselineCostUsd: cost, savingsUsd: 0 });
  const events = [ev("wastezero", 10), ev("customer", 50), ev("wastezero", 5)];
  assert.equal(computeInvoice({ events, tenant, period: "2026-10" }).usageUsd, 0);
  const inv = computeInvoice({ events, tenant, period: "2026-10", usage: { billUsage: true, usageMarkupPct: 10 } });
  assert.equal(inv.usageUsd, 16.5);
  assert.equal(inv.totalUsd, 16.5);
});

test("Telegram: link a chat, alerts carry buttons, and the Pause button pauses traffic; bad secret refused", async () => {
  const tg = [];
  const fetchImpl = async (url, init = {}) => {
    const u = String(url);
    if (u.startsWith("http://tg.test/")) { tg.push({ method: u.split("/").pop(), body: JSON.parse(init.body || "{}") }); return new Response('{"ok":true}', { status: 200 }); }
    return fetch(url, init);
  };
  const s = await setup({ TELEGRAM_BOT_TOKEN: "123:abc", TELEGRAM_BOT_USERNAME: "wastezero_bot", TELEGRAM_API_BASE: "http://tg.test", TELEGRAM_WEBHOOK_SECRET: "sec" },
    { budgets: { dailyUsd: 0.001 }, budgetAction: "alert" }, { fetch: fetchImpl });
  const cookie = await signIn(s);
  const { telegram } = (await raw(s, "GET", "/app/api/settings", { cookie })).json;
  assert.equal(telegram.available, true);
  const token = decodeURIComponent(telegram.link.split("start=")[1]);
  const hook = (body, secret = "sec") => raw(s, "POST", "/webhooks/telegram", { body, headers: { "x-telegram-bot-api-secret-token": secret } });
  assert.equal((await hook({ message: { text: `/start ${token}`, chat: { id: 777 } } }, "wrong")).status, 401);
  await hook({ message: { text: `/start ${token}`, chat: { id: 777 } } });
  assert.equal(s.ctx.tenants.get(s.tenantId).telegramChatId, 777);

  await s.chat(s.key, ask("spend"));                          // passes the $0.001 alert-only budget
  await s.chat(s.key, ask("spend more"));
  await waitFor(() => tg.some((m) => m.method === "sendMessage" && /Daily budget/.test(m.body.text)));
  const alert = tg.find((m) => /Daily budget/.test(m.body.text || ""));
  assert.deepEqual(alert.body.reply_markup.inline_keyboard[0].map((b) => b.callback_data), ["pause", "resume", "status"]);

  await hook({ callback_query: { id: "cq1", data: "pause", message: { chat: { id: 777 } } } });
  assert.ok(s.ctx.tenants.get(s.tenantId).paused);
  assert.equal((await s.chat(s.key, ask("now"))).json.error.code, "wastezero_paused");
  await hook({ callback_query: { id: "cq2", data: "pause", message: { chat: { id: 999 } } } });   // unlinked chat can't act
  assert.ok(tg.some((m) => m.method === "answerCallbackQuery" && /isn't linked/.test(m.body.text)));
  await hook({ callback_query: { id: "cq3", data: "resume", message: { chat: { id: 777 } } } });
  assert.equal(s.ctx.tenants.get(s.tenantId).paused, null);
  await s.close();
});

test("cheapest provider for the same model, with failover; saving measured against the reference offer", async () => {
  const calls = [];
  let groqDown = false;
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    const body = JSON.parse(init.body || "{}");
    calls.push({ host: u.host, model: body.model, auth: init.headers?.authorization });
    if (u.host === "groq.test" && groqDown) return new Response('{"error":"down"}', { status: 503 });
    return new Response(JSON.stringify({ model: body.model, choices: [{ message: { content: `from ${u.host}` }, finish_reason: "stop" }], usage: { prompt_tokens: 1000, completion_tokens: 1000 } }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const env = {
    PROVIDERS_JSON: JSON.stringify({
      together: { format: "openai", baseUrl: "http://together.test/v1", keyEnv: "TOGETHER_KEY", match: [] },
      groq: { format: "openai", baseUrl: "http://groq.test/v1", keyEnv: "GROQ_KEY", match: [] }
    }),
    TOGETHER_KEY: "tk", GROQ_KEY: "gk", DOWNGRADE_MAP_JSON: "{}",
    MODEL_RATES_JSON: JSON.stringify({ "meta/llama-70b": { input: 0.9, output: 0.9 }, "llama-70b-groq": { input: 0.6, output: 0.8 }, "gpt-4o": { input: 2.5, output: 10 } }),
    MODEL_OFFERS_JSON: JSON.stringify({ "llama-3.3-70b": [{ provider: "together", model: "meta/llama-70b" }, { provider: "groq", model: "llama-70b-groq" }] })
  };
  const s = await setup(env, {}, { fetch: fetchImpl });
  const body = { model: "llama-3.3-70b", messages: [{ role: "user", content: "hi" }] };
  let r = await s.chat(s.key, body);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("x-wastezero-provider"), "groq");          // cheaper one first
  await waitFor(async () => (await s.ctx.events.all()).length === 1);
  let e = (await s.ctx.events.all())[0];
  assert.equal(e.optimization, "offer");
  assert.equal(e.savingsUsd, Number((((1000 * 0.9 + 1000 * 0.9) - (1000 * 0.6 + 1000 * 0.8)) / 1e6).toFixed(10)));
  assert.equal(e.keySource, "wastezero");

  groqDown = true;
  r = await s.chat(s.key, { ...body, messages: [{ role: "user", content: "again" }] });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("x-wastezero-failover"), "groq>together");
  assert.equal(r.json.choices[0].message.content, "from together.test");
  calls.length = 0;
  await s.chat(s.key, { ...body, messages: [{ role: "user", content: "third" }] });
  assert.equal(calls[0].host, "together.test");                        // groq cooling down: tried last

  r = await s.chat(s.key, { ...body, messages: [{ role: "user", content: "own keys" }] }, { "x-upstream-keys": JSON.stringify({ together: "my-together-key" }) });
  assert.ok(calls.some((c) => c.auth === "Bearer my-together-key"));
  await s.close();
});

test("logo, favicon and link-preview image are served", async () => {
  const s = await setup();
  for (const [p, type] of [["/brand/wastezero-logo.svg", "image/svg+xml"], ["/brand/favicon.svg", "image/svg+xml"], ["/brand/og-image-1200x630.png", "image/png"], ["/favicon.ico", "image/svg+xml"]]) {
    const r = await fetch(s.base + p);
    assert.equal(r.status, 200, p);
    assert.equal(r.headers.get("content-type"), type);
  }
  assert.equal((await fetch(s.base + "/brand/..%2Fpackage.json")).status, 404);
  assert.equal((await fetch(s.base + "/brand/..%2F..%2F.env")).status, 404);
  assert.match((await raw(s, "GET", "/")).text, /og:image" content="http:\/\/wz\.test\/brand\/og-image-1200x630\.png"/);
  await s.close();
});

test("the dashboard and console scripts are valid JavaScript", async () => {
  const vm = await import("node:vm");
  const s = await setup();
  const cookie = await signIn(s);
  const adminCookie = cookieOf(await raw(s, "POST", "/console/signin", { form: { adminKey: ADMIN } }));
  for (const [path, c] of [["/app", cookie], ["/console", adminCookie], ["/audit", null]]) {
    const html = (await raw(s, "GET", path, { cookie: c })).text;
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
    assert.ok(scripts.length, path);
    for (const code of scripts) assert.doesNotThrow(() => new vm.Script(code), path);
  }
  await s.close();
});
