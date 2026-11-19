import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { startMockProvider, startApp, waitFor, ask } from "./helpers.js";

let provider;
test.before(async () => { provider = await startMockProvider(); });
test.after(async () => { await provider.close(); });

const json = (d, status = 200) => new Response(JSON.stringify(d), { status, headers: { "content-type": "application/json" } });
export function tools(calls = []) {
  return async (url, init = {}) => {
    const u = new URL(url);
    if (u.host === "gh.test") {
      calls.push({ url: u.toString(), auth: init.headers?.authorization });
      if (u.pathname === "/search/issues") return json({ items: [{ user: { login: "Ada-L" } }, { user: { login: "ada-l" } }, { user: { login: "lin" } }, { user: { login: "outsider" } }] });
    }
    if (u.host === "jira.test") {
      calls.push({ url: u.toString(), auth: init.headers?.authorization });
      return json({ issues: [{ fields: { assignee: { emailAddress: "ada@acme.test" } } }, { fields: { assignee: { emailAddress: "ada@acme.test" } } }, { fields: { assignee: { displayName: "Lin" } } }, { fields: { assignee: null } }], isLast: true });
    }
    return globalThis.fetch(url, init);
  };
}

const cookieOf = (r) => (r.headers.get("set-cookie") || "").split(";")[0];
export async function company(env = {}, fetchImpl) {
  const s = await startApp({ OPENAI_BASE_URL: provider.url, PUBLIC_BASE_URL: "http://wz.test", GITHUB_API_BASE: "http://gh.test", JIRA_HOST_PATTERN: "^http://jira\\.test$", ...env }, fetchImpl ? { fetch: fetchImpl } : {});
  const { json: t } = await s.admin("POST", "/admin/tenants", { name: "Acme", email: "owner@acme.test" });
  const cookie = cookieOf(await fetch(s.base + "/signin/key", { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "apiKey=" + t.apiKey }));
  const api = async (method, p, body) => {
    const r = await fetch(s.base + "/app/api" + p, { method, headers: { cookie, "x-wz-ui": "1", "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
    const text = await r.text(); let j = null; try { j = JSON.parse(text); } catch {}
    return { status: r.status, json: j, text };
  };
  return { ...s, key: t.apiKey, tenantId: t.tenant.id, cookie, api };
}

test("ROI ledger: merged PRs and done tickets per person and team, $ per PR; tokens encrypted; ROI note prefilled", async () => {
  const calls = [];
  const s = await company({}, tools(calls));
  await s.api("POST", "/teams/import", { csv: "email,name,role,team,manager_email,github\nlin@acme.test,Lin,Technical,Platform,,lin\nada@acme.test,Ada,Technical,Platform,lin@acme.test,@Ada-L" });
  await s.api("PATCH", "/teams/settings", { enabled: true });
  const t = s.ctx.tenants.get(s.tenantId);
  const ada = t.org.people.find((p) => p.email === "ada@acme.test");
  const key = (await s.api("POST", `/teams/people/${ada.id}/key`)).json.apiKey;
  for (const m of ["r1", "r2"]) assert.equal((await s.chat(key, ask(m))).status, 200);
  await waitFor(async () => (await s.ctx.events.all()).filter((e) => e.personId === ada.id).length === 2);

  assert.equal((await s.api("PUT", "/insights/integrations", { jira: { site: "https://evil.example", email: "a@b.co", token: "x".repeat(20) } })).status, 400, "only Atlassian sites (SSRF guard)");
  const put = await s.api("PUT", "/insights/integrations", { github: { org: "acme", token: "ghp_" + "z".repeat(36) }, jira: { site: "http://jira.test", email: "bot@acme.test", token: "jira-token-123" } });
  assert.equal(put.status, 200, put.text);
  assert.equal(put.json.github.org, "acme");
  assert.ok(!(await readFile(path.join(s.dataDir, "tenants.json"), "utf8")).includes("z".repeat(36)), "token encrypted at rest");

  const sync = await s.api("POST", "/insights/roi/sync");
  assert.equal(sync.status, 200, sync.text);
  assert.deepEqual(sync.json.errors, {});
  const r = sync.json.report;
  const a = r.people.find((p) => p.email === "ada@acme.test");
  assert.equal(a.prs, 2); assert.equal(a.tickets, 2);
  assert.equal(a.usdPerPr, Math.round(a.spentUsd / 2 * 100) / 100);
  assert.equal(r.people.find((p) => p.email === "lin@acme.test").tickets, 1, "matched by display name when Jira hides emails");
  assert.equal(r.company.prs, 4); assert.equal(r.teams[0].prs, 3);
  assert.deepEqual(r.unmatchedGithub, ["outsider"]);
  assert.ok(calls.some((c) => c.url.includes("is%3Apr+is%3Amerged+org%3Aacme") && c.auth === "Bearer ghp_" + "z".repeat(36)));
  assert.ok(calls.some((c) => c.url.includes("/rest/api/3/search/jql") && c.auth.startsWith("Basic ")));

  // the employee's budget request comes with the numbers filled in
  await fetch(s.base + "/me/signin", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "email=ada@acme.test" });
  const link = (await s.ctx.outbox.all()).filter((m) => m.kind === "team-signin").at(-1).text.match(/http:\/\/wz\.test(\/me\?token=\S+)/)[1];
  const page = await (await fetch(s.base + link)).text();
  assert.match(page, /2 merged pull requests \(\$[\d.]+ each\); 2 tickets done/);
  await s.close();
});

const RATES_ALL = JSON.stringify({ "gpt-4o": { input: 2.5, cachedInput: 1.25, output: 10 }, "gpt-4o-mini": { input: 0.15, cachedInput: 0.075, output: 0.6 }, "claude-sonnet-4-5": { input: 3, output: 15 } });
const ev = (tenantId, extra) => ({ timestamp: new Date().toISOString(), tenantId, status: 200, actualCostUsd: 1, baselineCostUsd: 1, savingsUsd: 0, provider: "anthropic", requestedModel: "claude-sonnet-4-5", ...extra });

test("seat advisor: heavy interactive users to a seat, light users stay pay-per-use, seat holders who also pay per use are flagged", async () => {
  const s = await company();
  await s.api("POST", "/teams/import", { csv: "email,name,role,team,seat\nheavy@acme.test,H,Technical,P,\nlight@acme.test,L,Technical,P,\ntwice@acme.test,T,Technical,P,Claude Team Premium" });
  const o = s.ctx.tenants.get(s.tenantId).org;
  const id = (e) => o.people.find((p) => p.email === e).id;
  for (let i = 0; i < 4; i++) await s.ctx.events.add(ev(s.tenantId, { personId: id("heavy@acme.test"), actualCostUsd: 50 }));
  await s.ctx.events.add(ev(s.tenantId, { personId: id("light@acme.test"), actualCostUsd: 40 }));
  await s.ctx.events.add(ev(s.tenantId, { personId: id("twice@acme.test"), actualCostUsd: 60 }));
  const r = (await s.api("GET", "/insights")).json.seats;
  const by = (e) => r.people.find((p) => p.email === e);
  assert.equal(by("heavy@acme.test").action, "seat");
  assert.equal(by("heavy@acme.test").monthlySavingUsd, 100, "$200/month pay-per-use vs a $100 annual seat");
  assert.equal(by("light@acme.test").action, "pay-per-use");
  assert.equal(by("twice@acme.test").action, "check");
  assert.equal(r.totalMonthlySavingUsd, 100);
  await s.close();
});

test("prepaid credit forecast warns before money expires unused, and steers offers to that provider", async () => {
  const s = await company();
  const day = 86400_000, now = Date.now();
  const set = await s.api("PATCH", "/insights/settings", { credits: [{ id: "anth-q4", provider: "anthropic", amountUsd: 1000, startAt: new Date(now - 20 * day).toISOString(), expiresAt: new Date(now + 10 * day).toISOString(), note: "Q4 commit" }] });
  assert.equal(set.status, 200, set.text);
  for (let i = 0; i < 10; i++) await s.ctx.events.add(ev(s.tenantId, { timestamp: new Date(now - i * day).toISOString(), actualCostUsd: 10 }));
  const c = (await s.api("GET", "/insights")).json.credits[0];
  assert.equal(c.usedUsd, 100); assert.equal(c.atRisk, true);
  assert.ok(c.projectedUnusedUsd > 800);
  await s.app.runOperator();
  assert.ok((await s.ctx.outbox.all()).some((m) => m.kind === "alert" && /Prepaid credit at risk/.test(m.text) && /Q4 commit/.test(m.text)));
  assert.ok(s.ctx.creditBias.get(s.tenantId).has("anthropic"));
  const { rankOffers } = await import("../src/offers.js");
  const config = { offers: { fast: [{ provider: "openai", model: "gpt-4o-mini" }, { provider: "anthropic", model: "claude-sonnet-4-5" }] },
    providers: { openai: { name: "openai", serverKey: "k" }, anthropic: { name: "anthropic", serverKey: "k" } }, modelRates: JSON.parse(RATES_ALL) };
  const health = { healthy: () => true };
  assert.equal(rankOffers(config, "fast", { health })[0].provider.name, "openai", "cheapest first normally");
  assert.equal(rankOffers(config, "fast", { health, prefer: new Set(["anthropic"]) })[0].provider.name, "anthropic", "credit at risk first");
  await s.close();
});

test("margins: cost per feature, and an alert when a customer's AI cost passes the threshold of their plan price", async () => {
  const s = await company();
  await s.api("PATCH", "/insights/settings", { planPrices: { pro: 10 }, marginAlertPct: 30 });
  await s.ctx.events.add(ev(s.tenantId, { endUser: "u1", endUserLabel: "Bigco", plan: "pro", tag: "chat", actualCostUsd: 5 }));
  await s.ctx.events.add(ev(s.tenantId, { endUser: "u2", plan: "pro", tag: "search", actualCostUsd: 0.5 }));
  const m = (await s.api("GET", "/insights")).json.margins;
  assert.equal(m.atRiskUsers, 1);
  assert.equal(m.features[0].feature, "chat"); assert.equal(m.features[0].sharePct, 90.9);
  await s.app.runOperator();
  assert.ok((await s.ctx.outbox.all()).some((x) => /Margin alert/.test(x.text) && /Bigco/.test(x.text)));
  await s.close();
});

test("benchmarks appear only with 5+ sharing companies; insights point at the gap; opting out removes a company", async () => {
  const s = await company();
  const ids = [s.tenantId];
  for (let i = 0; i < 5; i++) ids.push((await s.admin("POST", "/admin/tenants", { name: `Peer${i}`, email: `p${i}@peer.test` })).json.tenant.id);
  const add = async (id, n, model, cost) => { for (let i = 0; i < n; i++) await s.ctx.events.add(ev(id, { requestedModel: model, servedModel: model, actualCostUsd: cost, promptTokens: 1000, cachedTokens: 100 })); };
  await add(ids[0], 60, "claude-opus-4-7", 0.5);           // us: all top-tier
  for (const id of ids.slice(1, 4)) await add(id, 60, "claude-sonnet-4-5", 0.2);
  let b = (await s.api("GET", "/insights")).json.benchmarks;
  assert.equal(b.rows.find((r) => r.metric === "topTierSharePct").enough, false, "4 companies: not enough to show");
  await add(ids[4], 60, "claude-sonnet-4-5", 0.2);
  b = (await s.api("GET", "/insights")).json.benchmarks;
  const top = b.rows.find((r) => r.metric === "topTierSharePct");
  assert.equal(top.enough, true); assert.equal(top.you, 100); assert.equal(top.median, 0);
  const cpr = b.rows.find((r) => r.metric === "costPerRequestUsd");
  assert.equal(cpr.verdict, "worse"); assert.ok(b.insights.some((t) => /Cost per request/.test(t)));
  s.ctx.tenants.get(ids[4]).policy.shareBenchmarks = false;
  b = (await s.api("GET", "/insights")).json.benchmarks;
  assert.equal(b.rows.find((r) => r.metric === "costPerRequestUsd").enough, false);
  await s.close();
});

test("deferred requests go through OpenAI and Anthropic batch services at half price, with results, savings and a callback", async () => {
  const seen = { files: [], batches: [], callbacks: [], anthropic: [] };
  let openaiPolls = 0;
  const batchApi = async (url, init = {}) => {
    const u = new URL(url);
    if (u.host === "hook.test") { seen.callbacks.push(JSON.parse(init.body)); return json({ ok: true }); }
    if (u.host !== "batch.test") return globalThis.fetch(url, init);
    // OpenAI
    if (u.pathname === "/v1/files" && init.method === "POST") { seen.files.push(await init.body.get("file").text()); assert.equal(init.body.get("purpose"), "batch"); return json({ id: "file_in" }); }
    if (u.pathname === "/v1/batches" && init.method === "POST") { seen.batches.push(JSON.parse(init.body)); return json({ id: "batch_1", status: "validating" }); }
    if (u.pathname === "/v1/batches/batch_1") return json(++openaiPolls < 2 ? { id: "batch_1", status: "in_progress" } : { id: "batch_1", status: "completed", output_file_id: "file_out" });
    if (u.pathname === "/v1/files/file_out/content") {
      const lines = seen.files[0].trim().split("\n").map((l) => JSON.parse(l));
      return new Response(lines.map((l) => JSON.stringify({ custom_id: l.custom_id, response: { status_code: 200, body: { model: "gpt-4o", choices: [{ message: { role: "assistant", content: "batched " + l.body.messages[0].content } }], usage: { prompt_tokens: 1000, completion_tokens: 200 } } } })).join("\n"));
    }
    // Anthropic
    if (u.pathname === "/v1/messages/batches" && init.method === "POST") { seen.anthropic.push(JSON.parse(init.body)); assert.equal(init.headers["x-api-key"], "sk-ant-server"); return json({ id: "msgbatch_1", processing_status: "in_progress" }); }
    if (u.pathname === "/v1/messages/batches/msgbatch_1") return json({ id: "msgbatch_1", processing_status: "ended", results_url: "http://batch.test/results/msgbatch_1" });
    if (u.pathname === "/results/msgbatch_1") return new Response(seen.anthropic[0].requests.map((r) => JSON.stringify({ custom_id: r.custom_id, result: { type: "succeeded", message: { model: "claude-sonnet-4-5", content: [{ type: "text", text: "ok" }], usage: { input_tokens: 1000, output_tokens: 100 } } } })).join("\n"));
    return json({ error: "unexpected " + u.pathname }, 404);
  };
  const s = await company({ OPENAI_BASE_URL: "http://batch.test/v1", ANTHROPIC_BASE_URL: "http://batch.test", ANTHROPIC_API_KEY: "sk-ant-server", MODEL_RATES_JSON: RATES_ALL }, batchApi);
  s.ctx.lookup = async () => ({ address: "93.184.216.34" });
  const q1 = await s.call("POST", "/v1/deferred/chat/completions", { key: s.key, body: ask("nightly 1"), headers: { "x-wastezero-callback": "https://hook.test/done", "x-wastezero-tag": "nightly-report" } });
  const q2 = await s.call("POST", "/v1/deferred/chat/completions", { key: s.key, body: ask("nightly 2") });
  const q3 = await s.call("POST", "/v1/deferred/messages", { key: s.key, body: { model: "claude-sonnet-4-5", max_tokens: 100, messages: [{ role: "user", content: "summarise" }] } });
  assert.equal(q1.status, 202, q1.text); assert.equal(q1.json.status, "queued"); assert.equal(q3.status, 202, q3.text);
  assert.equal((await s.call("POST", "/v1/deferred/chat/completions", { key: s.key, body: { ...ask("x"), stream: true } })).status, 400);
  let r = await s.app.runDeferred();          // submits all three; Anthropic's batch is already done, OpenAI's still running
  assert.equal(r.submitted, 3);
  assert.equal(r.completed, 1);
  assert.equal(seen.files[0].trim().split("\n").length, 2, "one OpenAI batch for both jobs");
  assert.equal(seen.batches[0].endpoint, "/v1/chat/completions");
  r = await s.app.runDeferred();
  assert.equal(r.completed, 2);
  const done = await s.call("GET", `/v1/deferred/${q1.json.id}`, { key: s.key });
  assert.equal(done.json.status, "completed");
  assert.equal(done.json.result.choices[0].message.content, "batched nightly 1");
  const other = (await s.admin("POST", "/admin/tenants", { name: "Other", email: "o@o.test" })).json.apiKey;
  assert.equal((await s.call("GET", `/v1/deferred/${q1.json.id}`, { key: other })).status, 404, "other customers can't read it");
  const evs = (await s.ctx.events.all()).filter((e) => e.deferred);
  assert.equal(evs.length, 3);
  const e1 = evs.find((e) => e.jobId === q1.json.id);
  assert.equal(e1.optimization, "batch"); assert.equal(e1.baselineCostUsd, 0.0045); assert.equal(e1.actualCostUsd, 0.00225); assert.equal(e1.savingsUsd, 0.00225);
  await waitFor(async () => seen.callbacks.length === 1);
  assert.equal(seen.callbacks[0].id, q1.json.id);
  const batch = (await s.api("GET", "/insights")).json.batch;
  assert.ok(batch.deferredSavedUsd > 0);
  await s.close();
});
