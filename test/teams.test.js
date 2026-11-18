import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";
import { startMockProvider, startApp, waitFor, ask } from "./helpers.js";
import { approvalPlan, importPeople, defaultOrg, fallbackModel, sealSecret, openSecret } from "../src/teams.js";

let provider;
test.before(async () => { provider = await startMockProvider(); });
test.after(async () => { await provider.close(); });

const CSV = `email,name,role,team,manager_email
ceo@acme.test,Ceo,Leadership,Exec,
cto@acme.test,Cto,Technical,Platform,ceo@acme.test
lin@acme.test,Lin,Technical,Platform,cto@acme.test
ada@acme.test,Ada,Technical,Platform,lin@acme.test
bo@acme.test,Bo,Technical,Platform,lin@acme.test
sam@acme.test,Sam,Seller,Sales,ceo@acme.test`;

const cookieOf = (r) => (r.headers.get("set-cookie") || "").split(";")[0];
async function raw(s, method, p, { cookie, body, form, headers = {} } = {}) {
  const r = await fetch(s.base + p, { method, redirect: "manual",
    headers: { ...(cookie ? { cookie } : {}), ...(form ? { "content-type": "application/x-www-form-urlencoded" } : body ? { "content-type": "application/json" } : {}), "x-wz-ui": "1", ...headers },
    body: form ? new URLSearchParams(form).toString() : body ? JSON.stringify(body) : undefined });
  const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch {}
  return { status: r.status, headers: r.headers, text, json };
}

/** A company with people imported and Teams switched on; budgets tiny so a few requests cross them. */
async function company({ settings = {}, technicalUsd = 0.01, env = {} } = {}) {
  const s = await startApp({ OPENAI_BASE_URL: provider.url, PUBLIC_BASE_URL: "http://wz.test", ...env });
  const { json } = await s.admin("POST", "/admin/tenants", { name: "Acme", email: "owner@acme.test" });
  const cookie = cookieOf(await raw(s, "POST", "/signin/key", { form: { apiKey: json.apiKey } }));
  const imp = await raw(s, "POST", "/app/api/teams/import", { cookie, body: { csv: CSV } });
  assert.equal(imp.status, 200, imp.text);
  const roles = imp.json.report.roles.map((r) => ({ ...r, monthlyUsd: r.id === "technical" ? technicalUsd : r.monthlyUsd }));
  assert.equal((await raw(s, "PUT", "/app/api/teams/roles", { cookie, body: { roles } })).status, 200);
  const st = await raw(s, "PATCH", "/app/api/teams/settings", { cookie, body: { enabled: true, ...settings } });
  assert.equal(st.status, 200, st.text);
  const tenant = s.ctx.tenants.get(json.tenant.id);
  const who = (email) => tenant.org.people.find((p) => p.email === email);
  const keyFor = async (email) => (await raw(s, "POST", `/app/api/teams/people/${who(email).id}/key`, { cookie })).json.apiKey;
  return { ...s, cookie, tenant, who, keyFor, companyKey: json.apiKey };
}
const lastCallFor = (text) => provider.state.calls.filter((c) => c.body.messages?.at(-1)?.content === text).at(-1);
const mails = async (s, kind) => (await s.ctx.outbox.all()).filter((m) => !kind || m.kind === kind);

test("CSV import builds people, roles, teams, managers and team leads", () => {
  const o = defaultOrg();
  const r = importPeople(o, CSV + "\nnot-an-email,X,,,\nzed@acme.test,Zed,Technical,Platform,ghost@acme.test");
  assert.equal(r.added, 7);
  assert.equal(r.errors.length, 2);
  const by = (e) => o.people.find((p) => p.email === e);
  assert.equal(by("ada@acme.test").managerId, by("lin@acme.test").id);
  assert.ok(o.roles.some((x) => x.id === "seller" && x.monthlyUsd === 100), "unknown roles are created");
  assert.equal(o.teams.find((t) => t.id === "platform").leadId, by("lin@acme.test").id, "lead = the manager most members report to");
});

test("approval chain scales with the ask; missing managers fall back to the account owner", () => {
  const o = defaultOrg(); importPeople(o, CSV);
  const ada = o.people.find((p) => p.email === "ada@acme.test");   // ada → lin → cto → ceo; technical = $1,000
  assert.deepEqual(approvalPlan(o, ada, 200, "owner@x").groups[0].emails, ["cto@acme.test"]);   // ≤ +20%: second line
  const p2 = approvalPlan(o, ada, 1500, "owner@x");
  assert.equal(p2.needsRoi, true); assert.equal(p2.days, 90); assert.deepEqual(p2.groups[0].emails, ["ceo@acme.test"]);   // ≤ 3×: third line
  const p3 = approvalPlan(o, ada, 5000, "owner@x");
  assert.deepEqual(p3.groups.map((g) => g.name), ["executive", "finance"]);
  const ceo = o.people.find((p) => p.email === "ceo@acme.test");
  assert.deepEqual(approvalPlan(o, ceo, 10, "owner@x").groups[0].emails, ["owner@x"]);
});

test("cheaper fallback model: exact map first, then prefix; already-small models stay", () => {
  const o = defaultOrg();
  const config = { downgradeMap: { "gpt-4o": "gpt-4o-mini" } };
  assert.equal(fallbackModel(config, o, "gpt-4o"), "gpt-4o-mini");
  assert.equal(fallbackModel(config, o, "claude-opus-4-7"), "claude-haiku-4-5");
  assert.equal(fallbackModel(config, o, "claude-haiku-4-5"), null);
  assert.equal(fallbackModel(config, o, "gpt-4o-mini"), null);
});

test("over budget: the team pool covers first, then requests move to a cheaper model; alerts go to the person and manager", async () => {
  const s = await company();   // technical $0.01; each gpt-4o request costs $0.0045 → 3 requests cross it
  const adaKey = await s.keyFor("ada@acme.test");
  const send = async (text) => { const r = await s.chat(adaKey, ask(text)); assert.equal(r.status, 200, r.text); return lastCallFor(text).body.model; };
  assert.equal(await send("t1"), "gpt-4o");
  assert.equal(await send("t2"), "gpt-4o");
  assert.equal(await send("t3"), "gpt-4o");   // crosses her own $0.01 on this one
  // Platform has 4 people × $0.01 = $0.04: her overspend is absorbed by the team pool
  assert.equal(await send("t4"), "gpt-4o");
  await waitFor(async () => (await mails(s, "team-alert")).some((m) => m.to === "lin@acme.test"));
  const alerts = await mails(s, "team-alert");
  assert.ok(alerts.some((m) => m.to === "ada@acme.test" && /used up|100%/.test(m.subject)), "person told");
  assert.ok(alerts.some((m) => m.to === "lin@acme.test" && /Ada/.test(m.subject)), "manager told");
  // use up the team pool
  for (let i = 0; i < 6; i++) await send("fill" + i);
  assert.equal(await send("t-after-pool"), "gpt-4o-mini", "at the limit, moved to the cheaper model");
  await waitFor(async () => (await s.ctx.events.all()).filter((e) => e.personId === s.who("ada@acme.test").id).length >= 11);
  const ev = (await s.ctx.events.all()).filter((e) => e.personId === s.who("ada@acme.test").id);
  const fb = ev.at(-1);
  assert.equal(fb.budgetFallbackFrom, "gpt-4o");
  assert.equal(fb.savingsUsd, 0, "a budget fallback is policy, not savings: never billed as savings");
  const rep = (await raw(s, "GET", "/app/api/teams", { cookie: s.cookie })).json;
  assert.ok(rep.people.find((p) => p.email === "ada@acme.test").pct > 1);
  assert.ok(rep.teams.find((t) => t.id === "platform").spentUsd > 0);
  await s.close();
});

test("block mode stops requests at the limit (no pool)", async () => {
  const s = await company({ settings: { onLimit: "block", usePool: false } });
  const key = await s.keyFor("bo@acme.test");
  for (const t of ["b1", "b2", "b3"]) assert.equal((await s.chat(key, ask(t))).status, 200);
  const r = await s.chat(key, ask("b4"));
  assert.equal(r.status, 429);
  assert.equal(r.json.error.code, "person_budget_exceeded");
  assert.ok(!lastCallFor("b4"), "never reached the provider");
  await s.close();
});

test("a shared key with X-WasteZero-User = an employee's email is counted against that employee", async () => {
  const s = await company({ settings: { onLimit: "block", usePool: false } });
  for (const t of ["u1", "u2", "u3"]) assert.equal((await s.chat(s.companyKey, ask(t), { "x-wastezero-user": "Sam@acme.test" })).status, 200);
  await waitFor(async () => (await s.ctx.events.all()).filter((e) => e.personId === s.who("sam@acme.test").id).length === 3);
  assert.equal((await s.chat(s.companyKey, ask("u4"))).status, 200, "no user header: company-level traffic, not limited");
  await s.close();
});

test("privacy mode: managers get no individual alerts and the dashboard hides individual spend", async () => {
  const s = await company({ settings: { privacyMode: true, usePool: false } });
  const key = await s.keyFor("ada@acme.test");
  for (const t of ["p1", "p2", "p3", "p4"]) await s.chat(key, ask(t));
  await waitFor(async () => (await mails(s, "team-alert")).some((m) => m.to === "ada@acme.test"));
  assert.ok(!(await mails(s, "team-alert")).some((m) => m.to === "lin@acme.test"));
  const rep = (await raw(s, "GET", "/app/api/teams", { cookie: s.cookie })).json;
  assert.equal(rep.people[0].spentUsd, undefined);
  assert.ok(rep.teams.find((t) => t.id === "platform").spentUsd > 0, "team totals still shown");
  await s.close();
});

test("exceptions: employee asks via /me, the right approver approves by email link, budget grows", async () => {
  const s = await company({ technicalUsd: 1000 });
  const ada = s.who("ada@acme.test");
  // employee signs in by email
  assert.match((await raw(s, "POST", "/me/signin", { form: { email: "ada@acme.test" } })).text, /a link is on its way/);
  const link = (await mails(s, "team-signin")).at(-1).text.match(/http:\/\/wz\.test(\/me\?token=\S+)/)[1];
  const token = decodeURIComponent(link.split("token=")[1]);
  const page = await raw(s, "GET", link);
  assert.match(page.text, /My AI budget/);
  assert.match(page.text, /\$1,000\.00/);
  // a large ask needs ROI
  const noRoi = await raw(s, "POST", "/me/request", { form: { token, amountUsd: "1500", reason: "agent migration", roi: "" } });
  assert.equal(noRoi.status, 400); assert.match(noRoi.text, /ROI/);
  // a small ask goes to her second-line manager (cto)
  const ok = await raw(s, "POST", "/me/request", { form: { token, amountUsd: "150", reason: "big refactor this week", roi: "" } });
  assert.equal(ok.status, 200, ok.text); assert.match(ok.text, /second-line manager/);
  const ask1 = (await mails(s, "team-exception")).find((m) => m.to === "cto@acme.test");
  assert.ok(ask1, "cto asked");
  const approveLink = ask1.text.match(/http:\/\/wz\.test(\/teams\/approve\?token=\S+)/)[1];
  assert.match((await raw(s, "GET", approveLink)).text, /asks for <strong>\$150\.00<\/strong>/);
  const done = await raw(s, "POST", "/teams/approve", { form: { token: decodeURIComponent(approveLink.split("token=")[1]), decision: "approve" } });
  assert.match(done.text, /approved/);
  const x = s.tenant.org.exceptions.at(-1);
  assert.equal(x.state, "approved");
  assert.ok(x.expiresAt.startsWith(new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth() + 1, 1)).toISOString().slice(0, 7)), "this month only");
  assert.ok((await mails(s, "team-exception")).some((m) => m.to === "ada@acme.test" && /Approved/.test(m.subject)));
  const rep = (await raw(s, "GET", "/app/api/teams", { cookie: s.cookie })).json;
  assert.equal(rep.people.find((p) => p.id === ada.id).budgetUsd, 1150);
  // the link can't approve twice, and someone else's link can't be forged
  assert.equal((await raw(s, "POST", "/teams/approve", { form: { token: decodeURIComponent(approveLink.split("token=")[1]), decision: "approve" } })).status, 400);
  assert.equal((await raw(s, "GET", "/teams/approve?token=forged")).status, 400);
  await s.close();
});

test("big asks need an executive AND finance; the company admin can approve in the dashboard", async () => {
  const s = await company({ technicalUsd: 1000, settings: { execEmails: "ceo@acme.test", financeEmails: "cfo@acme.test" } });
  const link = await (async () => { await raw(s, "POST", "/me/signin", { form: { email: "lin@acme.test" } }); return (await mails(s, "team-signin")).at(-1).text.match(/token=(\S+)/)[1]; })();
  const r = await raw(s, "POST", "/me/request", { form: { token: decodeURIComponent(link), amountUsd: "4000", reason: "eval cluster", roi: "Replaces a $20k/month contractor workflow for the quarter" } });
  assert.equal(r.status, 200, r.text);
  const asked = (await mails(s, "team-exception")).map((m) => m.to);
  assert.ok(asked.includes("ceo@acme.test") && asked.includes("cfo@acme.test"));
  const execLink = (await mails(s, "team-exception")).find((m) => m.to === "ceo@acme.test").text.match(/token=(\S+)/)[1];
  const half = await raw(s, "POST", "/teams/approve", { form: { token: decodeURIComponent(execLink), decision: "approve" } });
  assert.match(half.text, /still needs the others/);
  const x = s.tenant.org.exceptions.at(-1);
  assert.equal(x.state, "pending");
  const viaAdmin = await raw(s, "POST", `/app/api/teams/exceptions/${x.id}/approve`, { cookie: s.cookie });
  assert.equal(viaAdmin.status, 200);
  assert.equal(x.state, "approved");
  assert.equal(x.days, 30);
  await s.close();
});

test("expired extras end and ask for a review", async () => {
  const s = await company({ technicalUsd: 1000 });
  const o = s.tenant.org, ada = s.who("ada@acme.test");
  o.exceptions.push({ id: "ex_aaaaaaaaaa", personId: ada.id, amountUsd: 500, level: 2, days: 90, state: "approved", groups: [], createdAt: new Date(Date.now() - 100 * 86400_000).toISOString(), expiresAt: new Date(Date.now() - 1000).toISOString() });
  const report = await s.app.runOperator();
  assert.equal(report.teams.expired, 1);
  assert.equal(o.exceptions.at(-1).state, "expired");
  assert.ok((await mails(s, "team-exception")).some((m) => m.to === "lin@acme.test" && /review/.test(m.subject)));
  await s.close();
});

test("employees create their own key on /me; it works without a provider key when the company stored one (encrypted)", async () => {
  const s = await company({ technicalUsd: 1000, env: { OPENAI_API_KEY: "" } });
  const store = await raw(s, "PUT", "/app/api/teams/provider-keys", { cookie: s.cookie, body: { provider: "openai", key: "sk-company-secret-123456" } });
  assert.equal(store.status, 200, store.text);
  assert.deepEqual(store.json.providerKeys, ["openai"]);
  const onDisk = await readFile(path.join(s.dataDir, "tenants.json"), "utf8");
  assert.ok(!onDisk.includes("sk-company-secret-123456"), "never stored in plain text");
  await raw(s, "POST", `/app/api/teams/people/${s.who("ada@acme.test").id}/invite`, { cookie: s.cookie });
  const token = decodeURIComponent((await mails(s, "team-invite")).at(-1).text.match(/token=(\S+)/)[1]);
  const page = await raw(s, "POST", "/me/key", { form: { token } });
  const apiKey = page.text.match(/<pre>(wz_[\w-]+)<\/pre>/)[1];
  assert.match(page.text, /ANTHROPIC_BASE_URL=http:\/\/wz\.test/);
  const r = await s.chat(apiKey, ask("with stored key"));
  assert.equal(r.status, 200, r.text);
  assert.equal(lastCallFor("with stored key").auth, "Bearer sk-company-secret-123456");
  await waitFor(async () => (await s.ctx.events.all()).some((e) => e.keySource === "customer"));
  const ev = (await s.ctx.events.all()).at(-1);
  assert.equal(ev.keySource, "customer", "the company's own key: not usage-billed");
  // person keys don't show in the company's API-keys tab, and a deactivated person's key stops working
  assert.ok(!(await raw(s, "GET", "/app/api/keys", { cookie: s.cookie })).json.keys.some((k) => k.personId));
  await raw(s, "PATCH", `/app/api/teams/people/${s.who("ada@acme.test").id}`, { cookie: s.cookie, body: { active: false } });
  assert.equal((await s.chat(apiKey, ask("after leaving"))).status, 401);
  await s.close();
});

test("secrets round-trip and the Teams tab script is valid JavaScript", async () => {
  const config = { adminKey: "x".repeat(30) };
  const sealed = sealSecret(config, "sk-abc-123");
  assert.equal(openSecret(config, sealed), "sk-abc-123");
  assert.equal(openSecret({ adminKey: "y".repeat(30) }, sealed), null);
  const s = await startApp({ OPENAI_BASE_URL: provider.url });
  const js = await (await fetch(s.base + "/app/teams.js")).text();
  assert.doesNotThrow(() => new vm.Script(js));
  await s.close();
});

test("the Teams page is public and linked from the menu, homepage and pricing; the seat fee bills active employees only", async () => {
  const s = await startApp({ OPENAI_BASE_URL: provider.url, TEAMS_SEAT_PRICE_USD: "4" });
  const page = await (await fetch(s.base + "/teams")).text();
  assert.match(page, /AI budgets for every employee/);
  assert.match(page, /\$4 per employee per month, only for employees who used AI/);
  for (const p of ["/", "/pricing"]) assert.match(await (await fetch(s.base + p)).text(), /href="\/teams"/);
  const { computeInvoice } = await import("../src/billing.js");
  const tenant = { id: "t1", name: "Acme", policy: { revenueSharePct: 20 } };
  const ev = (personId) => ({ tenantId: "t1", timestamp: "2026-11-05T00:00:00Z", status: 200, actualCostUsd: 1, personId });
  const inv = computeInvoice({ events: [ev("p1"), ev("p1"), ev("p2"), ev(null)], tenant, period: "2026-11", usage: { teamsSeatUsd: 4 } });
  assert.equal(inv.seats, 2); assert.equal(inv.seatsUsd, 8); assert.equal(inv.totalUsd, 8);
  assert.equal(computeInvoice({ events: [ev("p1")], tenant, period: "2026-11", usage: {} }).seatsUsd, 0, "free unless a price is set");
  await s.close();
});

test("admin sets the Teams seat price: $5 by default, changes announced for next month, invoices use their own month's price", async () => {
  const s = await startApp({ OPENAI_BASE_URL: provider.url, PUBLIC_BASE_URL: "http://wz.test" });
  const { billingFor } = await import("../src/settings.js");
  const r0 = await s.admin("GET", "/admin/settings");
  assert.equal(r0.json.teamsSeat.currentUsd, 5);
  assert.match(await (await fetch(s.base + "/teams")).text(), /\$5 per employee per month/);
  // a Teams customer to notify
  const { json } = await s.admin("POST", "/admin/tenants", { name: "Acme", email: "owner@acme.test" });
  s.ctx.tenants.get(json.tenant.id).org = { ...defaultOrg(), enabled: true };
  const now = new Date();
  const thisMonth = now.toISOString().slice(0, 7);
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString().slice(0, 7);
  const r1 = await s.admin("PATCH", "/admin/settings", { teamsSeatUsd: 7, when: "next_month", notifyCustomers: true });
  assert.equal(r1.status, 200, r1.text);
  assert.equal(r1.json.notified, 1);
  assert.equal(r1.json.teamsSeat.currentUsd, 5, "this month unchanged");
  assert.deepEqual(r1.json.teamsSeat.upcoming, { usd: 7, effectiveFrom: next });
  assert.equal(billingFor(s.ctx, thisMonth).teamsSeatUsd, 5);
  assert.equal(billingFor(s.ctx, next).teamsSeatUsd, 7);
  assert.match(await (await fetch(s.base + "/teams")).text(), new RegExp(`From ${next}: \\$7 per employee`));
  assert.ok((await s.ctx.outbox.all()).some((m) => m.kind === "price-change" && m.to === "owner@acme.test" && /\$7/.test(m.text)));
  // immediate change
  const r2 = await s.admin("PATCH", "/admin/settings", { teamsSeatUsd: 4.5, when: "now" });
  assert.equal(r2.json.teamsSeat.currentUsd, 4.5);
  assert.equal(r2.json.notified, 0, "no emails unless asked");
  // validation and auth
  assert.equal((await s.admin("PATCH", "/admin/settings", { teamsSeatUsd: -1 })).status, 400);
  assert.equal((await s.call("PATCH", "/admin/settings", { body: { teamsSeatUsd: 1 } })).status, 401);
  // survives a restart
  await s.close();
  const s2 = await startApp({ OPENAI_BASE_URL: provider.url, DATA_DIR: s.dataDir });
  assert.equal((await s2.admin("GET", "/admin/settings")).json.teamsSeat.currentUsd, 4.5);
  await s2.close();
});
