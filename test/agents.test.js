import test from "node:test";
import assert from "node:assert/strict";
import { startMockProvider, startApp, waitFor, ask, ADMIN } from "./helpers.js";
import { inboxSecret } from "../src/contact.js";

let provider;
test.before(async () => { provider = await startMockProvider(); });
test.after(async () => { await provider.close(); });
const admin = (s, method, path, body) => s.call(method, path, { key: ADMIN, body });

test("WasteZero runs its own AI calls through itself, on its own budget-capped account", async () => {
  const s = await startApp({ OPENAI_BASE_URL: provider.url, AGENT_DAILY_BUDGET_USD: "2" });
  s.ctx.selfUrl = s.base;
  const internal = s.ctx.tenants.list().find((t) => t.internal);
  assert.ok(internal);
  assert.ok(internal.policy.allowedOptimizations.includes("route"));
  assert.equal(internal.policy.budgets.dailyUsd, 2);
  assert.equal(internal.policy.loopBreaker.action, "block");
  const r = await s.ctx.callModel({ model: "gpt-4o-mini", messages: [{ role: "user", content: "grade this" }] }, { tag: "grader", purpose: "eval" });
  assert.equal(r.ok, true);
  await waitFor(async () => (await s.ctx.events.all()).some((e) => e.tenantId === internal.id));
  const e = (await s.ctx.events.all()).find((x) => x.tenantId === internal.id);
  assert.equal(e.tag, "grader");
  assert.equal(e.keySource, "wastezero");
  // Not counted as a customer, never invoiced.
  assert.equal((await s.call("GET", "/stats")).json.customers, 0);
  const report = await s.app.runOperator({ now: new Date(Date.now() + 40 * 86400_000) });
  assert.ok(!report.invoices.some((i) => i.tenantId === internal.id));
  await s.close();
});

test("the grader is never switched to a cheaper model, but agents' own calls are optimised", async () => {
  const s = await startApp({ OPENAI_BASE_URL: provider.url });
  s.ctx.selfUrl = s.base;
  const internal = s.ctx.tenants.list().find((t) => t.internal);
  const rule = (await admin(s, "POST", "/admin/rules", { tenantId: internal.id, type: "route", match: { model: "gpt-4o" }, target: "gpt-4o-mini" })).json.rule;
  await admin(s, "POST", `/admin/rules/${rule.id}/transition`, { to: "active" });
  provider.state.calls.length = 0;
  await s.ctx.callModel({ model: "gpt-4o", messages: [{ role: "user", content: "grade" }] }, { tag: "grader", purpose: "eval" });
  assert.equal(provider.state.calls.at(-1).body.model, "gpt-4o");
  await s.ctx.callModel({ model: "gpt-4o", messages: [{ role: "user", content: "draft a brief" }] }, { tag: "agent-chief_of_staff", purpose: "agent" });
  assert.equal(provider.state.calls.at(-1).body.model, "gpt-4o-mini");
  await s.close();
});

test("Chief of Staff sets weekly goals once and writes the daily brief from real numbers", async () => {
  const s = await startApp({ OPENAI_BASE_URL: provider.url, FOUNDER_EMAIL: "founder@wz.test", BRIEF_HOUR_UTC: "0", PUBLIC_BASE_URL: "http://wz.test" });
  s.ctx.selfUrl = s.base;
  const now = new Date();
  let r = await s.app.runAgents({ now, only: "chief_of_staff" });
  const goals = s.ctx.company.m.goals;
  assert.ok(goals.week && goals.targets.signups >= 3);
  assert.match(r.agents.chief_of_staff, /set goals/);
  assert.match(r.agents.chief_of_staff, /daily brief/);
  const brief = (await s.ctx.outbox.all()).find((m) => m.kind === "brief");
  assert.equal(brief.to, "founder@wz.test");
  assert.match(brief.text, /Waiting on you/);
  r = await s.app.runAgents({ now, only: "chief_of_staff" });
  assert.equal(r.agents.chief_of_staff, "nothing due");          // once per week / per day
  const team = (await admin(s, "GET", "/admin/team")).json;
  assert.equal(team.agents.length, 6);
  assert.ok(team.brief.text.length > 20);
  await s.close();
});

test("Onboarding nudges a silent signup, welcomes a live one, and hands a stuck one to the founder", async () => {
  const s = await startApp({ OPENAI_BASE_URL: provider.url, PUBLIC_BASE_URL: "http://wz.test" });
  const quiet = (await admin(s, "POST", "/admin/tenants", { name: "Quiet", email: "q@quiet.test" })).json;
  const live = (await admin(s, "POST", "/admin/tenants", { name: "Live", email: "l@live.test" })).json;
  await s.chat(live.apiKey, ask("hello"));
  await waitFor(async () => (await s.ctx.events.all()).length === 1);
  const day = 86400_000;
  await s.app.runAgents({ now: new Date(Date.now() + 1.5 * day), only: "onboarding" });
  let mails = await s.ctx.outbox.all();
  assert.ok(mails.some((m) => m.to === "q@quiet.test" && m.kind === "onboarding_nudge1"));
  assert.ok(mails.some((m) => m.to === "l@live.test" && m.kind === "onboarding_welcomed"));
  await s.app.runAgents({ now: new Date(Date.now() + 1.6 * day), only: "onboarding" });
  assert.equal((await s.ctx.outbox.all()).filter((m) => m.to === "q@quiet.test").length, 1);   // no repeat
  await s.app.runAgents({ now: new Date(Date.now() + 4 * day), only: "onboarding" });
  await s.app.runAgents({ now: new Date(Date.now() + 8 * day), only: "onboarding" });
  assert.ok((await s.ctx.outbox.all()).some((m) => m.to === "q@quiet.test" && m.kind === "onboarding_nudge2"));
  assert.ok(s.ctx.company.tasks.some((t) => t.owner === "founder" && /Reach out personally to Quiet/.test(t.title)));
  await s.close();
});

test("Inbox: unsubscribes are honoured automatically; other messages get a drafted reply that waits for approval", async () => {
  const s = await startApp({ OPENAI_BASE_URL: provider.url, PUBLIC_BASE_URL: "http://wz.test" });
  const secret = inboxSecret(s.ctx.config);
  const post = (body, sec = secret) => s.call("POST", "/webhooks/inbound-email", { body, headers: { "x-wastezero-inbox-secret": sec } });
  assert.equal((await post({ From: "a@b.test", TextBody: "hi" }, "wrong")).status, 401);
  await post({ From: "Jane <jane@corp.test>", Subject: "unsubscribe", TextBody: "Please unsubscribe me and stop emailing." });
  assert.ok(s.ctx.prospects.data.suppression.emails.includes("jane@corp.test"));
  // contact form → inbox → task (no AI available in this test, so it goes to the founder)
  const form = await fetch(s.base + "/contact", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ name: "Ola", email: "ola@shop.test", message: "Is there a minimum spend to use WasteZero?" }).toString() });
  assert.match(await form.text(), /be in touch/);
  const task = s.ctx.company.tasks.find((t) => /ola@shop.test/.test(t.detail));
  assert.ok(task);
  // An approval-type task: approving sends exactly the (edited) draft.
  const draft = await s.ctx.company.addTask({ owner: "inbox", title: "sales: question", approval: { type: "send_email", payload: { to: "ola@shop.test", subject: "Re: hi", text: "Draft" } } });
  const ok = await admin(s, "POST", `/admin/tasks/${draft.id}/approve`, { edits: { text: "No minimum. Start free: http://wz.test/signup" } });
  assert.equal(ok.json.task.status, "done");
  const sent = (await s.ctx.outbox.all()).find((m) => m.kind === "approved_reply");
  assert.equal(sent.text, "No minimum. Start free: http://wz.test/signup");
  assert.equal((await admin(s, "POST", `/admin/tasks/${draft.id}/approve`, {})).status, 409);
  await s.close();
});

test("Reliability opens an incident when a provider fails and closes it when it recovers", async () => {
  const s = await startApp({ OPENAI_BASE_URL: provider.url });
  const now = new Date();
  for (let i = 0; i < 6; i++) await s.ctx.events.add({ tenantId: "x", timestamp: now.toISOString(), provider: "openai", status: 502 });
  await s.app.runReliability();
  let open = s.ctx.company.m.incidents.filter((i) => !i.closedAt);
  assert.ok(open.some((i) => i.key === "provider:openai"));
  assert.ok((await s.ctx.audit.all()).some((a) => a.action === "incident_open" && a.level === "escalation"));
  for (let i = 0; i < 40; i++) await s.ctx.events.add({ tenantId: "x", timestamp: new Date().toISOString(), provider: "openai", status: 200 });
  await s.app.runReliability();
  open = s.ctx.company.m.incidents.filter((i) => !i.closedAt && i.key === "provider:openai");
  assert.equal(open.length, 0);
  await s.close();
});
