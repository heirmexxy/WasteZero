import test from "node:test";
import assert from "node:assert/strict";
import { startMockProvider, startApp, waitFor, ask } from "./helpers.js";
import { firewall, scanText, SECRET_PATTERNS, PII_PATTERNS } from "../src/firewall.js";
import { failingToolSignature as fts } from "../src/breaker.js";

let provider;
test.before(async () => { provider = await startMockProvider(); });
test.after(async () => { await provider.close(); });

async function customer(policy = {}) {
  const s = await startApp({ OPENAI_BASE_URL: provider.url, PUBLIC_BASE_URL: "http://wz.test" });
  const { json } = await s.admin("POST", "/admin/tenants", { name: "Acme", email: "owner@acme.test" });
  const set = await s.call("PATCH", "/v1/wastezero/settings", { key: json.apiKey, body: policy });
  assert.equal(set.status, 200, set.text);
  return { ...s, key: json.apiKey, tenantId: json.tenant.id };
}
const lastCall = (marker) => provider.state.calls.filter((c) => JSON.stringify(c.body).includes(marker)).at(-1);
const loopy = (marker, err = "Error: tests failed (exit 1)") => ({ model: "gpt-4o", temperature: 0, messages: [
  { role: "user", content: `fix it ${marker}` }, { role: "assistant", content: null, tool_calls: [{ id: "t1", type: "function", function: { name: "run_tests", arguments: "{}" } }] },
  { role: "tool", tool_call_id: "t1", content: err }] });

// ------------------------------------------------------------ firewall

test("finds secrets and personal data; masks without leaking values; ignores look-alikes", () => {
  const text = "key AKIAABCDEFGHIJKLMNOP and sk-ant-api03-abcdefghijklmnopqrstuvwxyz012345 and ghp_" + "a".repeat(36) +
    "\npassword=hunter2hunter2 card 4242 4242 4242 4242 mail ada@acme.com call +234 803 123 4567";
  const s = scanText(text, "mask", SECRET_PATTERNS);
  assert.deepEqual(Object.keys(s.findings).sort(), ["anthropic_key", "aws_access_key", "github_token", "password_assignment"]);
  assert.ok(!s.text.includes("AKIAABCDEFGHIJKLMNOP") && !s.text.includes("hunter2hunter2"));
  const p = scanText(text, "monitor", PII_PATTERNS);
  assert.equal(p.findings.card_number, 1); assert.equal(p.findings.email, 1); assert.equal(p.findings.phone, 1);
  assert.equal(p.text, text, "monitor never changes the text");
  assert.equal(scanText("order 1234 5678 9012 3456 shipped", "monitor", PII_PATTERNS).findings.card_number, undefined, "fails the card checksum");
});

test("masking keeps tool-call JSON valid and reaches system prompts and tool results", () => {
  const body = { system: "deploy with AKIAABCDEFGHIJKLMNOP", messages: [
    { role: "user", content: [{ type: "text", text: "hi" }, { type: "tool_result", tool_use_id: "x", content: "token ghp_" + "b".repeat(36) }] },
    { role: "assistant", content: [{ type: "tool_use", id: "x", name: "sh", input: { cmd: "export OPENAI=sk-proj-" + "c".repeat(40) } }] }] };
  const r = firewall(body, { firewall: { secrets: "mask", pii: "off" } });
  assert.equal(Object.values(r.secrets).reduce((a, b) => a + b), 3);
  assert.match(body.system, /\[REDACTED:aws_access_key\]/);
  assert.match(body.messages[0].content[1].content, /\[REDACTED:github_token\]/);
  assert.match(body.messages[1].content[0].input.cmd, /\[REDACTED:openai_key\]/);
});

test("the provider never sees a masked secret; blocking refuses before the provider; reports count without values", async () => {
  const s = await customer({ firewall: { secrets: "mask", pii: "monitor" } });
  const r = await s.chat(s.key, ask("m1 use key AKIAABCDEFGHIJKLMNOP for ada@acme.com"));
  assert.equal(r.status, 200, r.text);
  const sent = JSON.stringify(lastCall("m1").body);
  assert.ok(!sent.includes("AKIAABCDEFGHIJKLMNOP"), "secret masked");
  assert.ok(sent.includes("ada@acme.com"), "PII only logged in monitor mode");
  await s.call("PATCH", "/v1/wastezero/settings", { key: s.key, body: { firewall: { secrets: "block", pii: "monitor" } } });
  const before = provider.state.calls.length;
  const b = await s.chat(s.key, ask("m2 -----BEGIN RSA PRIVATE KEY-----\nMIIabc\n-----END RSA PRIVATE KEY-----"));
  assert.equal(b.status, 403); assert.equal(b.json.error.code, "blocked_by_firewall");
  assert.equal(provider.state.calls.length, before);
  await waitFor(async () => (await s.ctx.events.all()).filter((e) => e.firewall).length >= 2);
  const evs = await s.ctx.events.all();
  assert.ok(!JSON.stringify(evs).includes("AKIAABCDEFGHIJKLMNOP"), "never stored");
  const sessionCookie = (await fetch(s.base + "/signin/key", { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "apiKey=" + s.key })).headers.get("set-cookie").split(";")[0];
  const period = new Date().toISOString().slice(0, 7);
  const rep = await (await fetch(`${s.base}/app/api/security?period=${period}`, { headers: { cookie: sessionCookie } })).json();
  assert.equal(rep.firewall.byType.aws_access_key.count, 1);
  assert.equal(rep.firewall.byType.private_key.count, 1);
  assert.equal(rep.firewall.byAction.blocked, 1);
  const csv = await (await fetch(`${s.base}/app/api/security.csv?period=${period}`, { headers: { cookie: sessionCookie } })).text();
  assert.match(csv, /private_key:1/);
  await s.close();
});

// ------------------------------------------------------------ circuit breaker

test("a failing step repeated in a loop pauses that session only; resume link works", async () => {
  const s = await customer({ breaker: { action: "pause", usdPer10Min: 1000, repeatLimit: 4, pauseMinutes: 30 } });
  const sess = { "x-wastezero-session": "agent-run-1" };
  for (let i = 0; i < 3; i++) assert.equal((await s.chat(s.key, loopy("L"), sess)).status, 200);
  const tripped = await s.chat(s.key, loopy("L"), sess);
  assert.equal(tripped.status, 429);
  assert.match(tripped.json.error.message, /stuck in a loop/);
  assert.equal((await s.chat(s.key, ask("other work"), { "x-wastezero-session": "agent-run-2" })).status, 200, "other sessions keep working");
  assert.equal((await s.chat(s.key, ask("still paused"), sess)).status, 429);
  await waitFor(async () => (await s.ctx.outbox.all()).some((m) => m.kind === "alert" && /Circuit breaker/.test(m.text)));
  const link = tripped.json.error.message.match(/http:\/\/wz\.test(\/breaker\/resume\?token=\S+)/)[1];
  const token = decodeURIComponent(link.split("token=")[1]);
  assert.match(await (await fetch(s.base + link)).text(), /Resume this AI session/);
  assert.equal((await s.chat(s.key, ask("not yet"), sess)).status, 429, "a GET (e.g. an email scanner) does not resume");
  await fetch(s.base + "/breaker/resume", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "token=" + encodeURIComponent(token) });
  assert.equal((await s.chat(s.key, ask("back"), sess)).status, 200);
  await s.close();
});

test("spending too fast in 10 minutes pauses the session; alert mode only warns; off does nothing", async () => {
  const s = await customer({ breaker: { action: "pause", usdPer10Min: 0.5, repeatLimit: 50, pauseMinutes: 30 } });
  const big = (m) => ({ ...ask(m) });
  s.ctx.config.prices = s.ctx.config.prices;  // gpt-4o: $0.0045 per mock request
  s.ctx.tenants.get(s.tenantId).policy.breaker.usdPer10Min = 0.01;
  const h = { "x-wastezero-session": "hot" };
  let paused = false;
  for (let i = 0; i < 8 && !paused; i++) { const r = await s.chat(s.key, big("spend" + i), h); paused = r.status === 429; await new Promise((r) => setTimeout(r, 30)); }
  assert.ok(paused, "paused after crossing $0.01 in 10 minutes");
  const t = s.ctx.tenants.get(s.tenantId);
  t.policy.breaker = { ...t.policy.breaker, action: "alert" };
  const h2 = { "x-wastezero-session": "warm" };
  for (let i = 0; i < 6; i++) assert.equal((await s.chat(s.key, big("warm" + i), h2)).status, 200, "alert mode never blocks");
  t.policy.breaker = { ...t.policy.breaker, action: "off" };
  for (let i = 0; i < 6; i++) assert.equal((await s.chat(s.key, loopy("O"), { "x-wastezero-session": "o" })).status, 200);
  await s.close();
});

test("Claude Code's session id in metadata.user_id identifies the session", () => {
  assert.equal(fts({ messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: "a", is_error: true, content: "boom" }] }] }).length, 16);
  assert.equal(fts({ messages: [{ role: "user", content: "hello" }] }), null);
});
