import test from "node:test";
import assert from "node:assert/strict";
import { startApp } from "./helpers.js";
import { runProspecting, isPrivateAddress, robotsAllows } from "../src/prospecting.js";

const json = (d, status = 200) => new Response(JSON.stringify(d), { status, headers: { "content-type": "application/json" } });
const html = (h) => new Response(h, { status: 200, headers: { "content-type": "text/html" } });

const SITES = {
  "acme-ai.com": `<html><head><title>Acme AI | Agents for support teams</title><meta name="description" content="AI agents that answer support tickets using GPT-4 and your docs."></head>
    <body>Built on OpenAI and LLMs. Contact <a href="mailto:jane.doe@acme-ai.com">Jane</a> or <a href="mailto:hello@acme-ai.com">hello@acme-ai.com</a>. Partner: sales@other.com</body></html>`,
  "bakery.com": `<html><title>Fresh bread</title><body>We bake bread. info@bakery.com</body></html>`,
  "nocontact.ai": `<html><title>NoContact</title><body>LLM agents. Email jane@nocontact.ai</body></html>`,
  "blocked.ai": `<html><title>Blocked</title><body>hello@blocked.ai LLM</body></html>`
};

function world() {
  const calls = [];
  const fetch = async (url, init = {}) => {
    const u = new URL(url);
    calls.push(u.toString());
    if (u.host === "hn.test") return json({ hits: [
      { objectID: "1", title: "Show HN: Acme AI", url: "https://www.acme-ai.com/launch" },
      { objectID: "2", title: "Show HN: my repo", url: "https://github.com/x/y" },
      { objectID: "3", title: "Show HN: bread", url: "https://bakery.com" },
      { objectID: "4", title: "Show HN: internal", url: "https://intranet.test" },
      { objectID: "5", title: "Show HN: no contact", url: "https://nocontact.ai" },
      { objectID: "6", title: "Show HN: blocked", url: "https://blocked.ai" }
    ] });
    if (u.host === "model.test") {
      const evidence = JSON.parse(JSON.parse(init.body).messages[1].content);
      const fit = /acme/.test(evidence.domain) ? 9 : 2;
      return json({ model: "gpt-4o-mini", usage: { prompt_tokens: 10, completion_tokens: 10 }, choices: [{ message: { content: JSON.stringify({ fit, reason: fit > 5 ? "Hosted AI agent product" : "Bakery", personalization: "Your support agents answer tickets from customer docs." }) } }] });
    }
    const site = SITES[u.host];
    if (site !== undefined) {
      if (u.pathname === "/robots.txt") return new Response(u.host === "blocked.ai" ? "User-agent: *\nDisallow: /" : "User-agent: *\nDisallow: /private", { status: 200 });
      return u.pathname === "/" ? html(site) : new Response("", { status: 404 });
    }
    return new Response("", { status: 404 });
  };
  const lookup = async (host) => ({ address: host === "intranet.test" ? "10.0.0.5" : "93.184.216.34" });
  return { calls, fetch, lookup };
}

const env = { PROSPECTING_ENABLED: "true", HN_API_BASE: "http://hn.test", PROSPECT_QUERIES: "LLM", OPENAI_BASE_URL: "http://model.test/v1",
  PUBLIC_BASE_URL: "http://wz.test", SENDER_ADDRESS: "1 Example Road, Iseyin, Oyo State, Nigeria", SENDER_NAME: "Emeka at WasteZero", EMAIL_FROM: "emeka@wastezero.test" };

test("network guards", () => {
  for (const ip of ["10.1.2.3", "127.0.0.1", "192.168.1.1", "172.20.0.1", "169.254.169.254", "::1", "fd00::1", "::ffff:10.0.0.1"]) assert.equal(isPrivateAddress(ip), true, ip);
  assert.equal(isPrivateAddress("93.184.216.34"), false);
  assert.equal(robotsAllows("User-agent: *\nDisallow: /", "/contact"), false);
  assert.equal(robotsAllows("User-agent: googlebot\nDisallow: /\nUser-agent: *\nDisallow: /admin", "/contact"), true);
});

test("finds, qualifies, waits for approval, sends with unsubscribe, follows up once, honours unsubscribe", async () => {
  const w = world();
  const s = await startApp(env, { fetch: w.fetch, lookup: w.lookup });
  const now = new Date();
  let report = { escalations: [] };
  await runProspecting(s.ctx, report, { now });

  const by = (d) => s.ctx.prospects.byDomain(d);
  assert.equal(by("github.com"), null);
  assert.equal(by("intranet.test").state, "unreachable");          // private address refused
  assert.equal(by("blocked.ai").state, "unreachable");             // robots.txt respected
  assert.equal(by("nocontact.ai").state, "no_contact");            // named person only: not contacted
  assert.equal(by("bakery.com").state, "disqualified");
  const acme = by("acme-ai.com");
  assert.equal(acme.contactEmail, "hello@acme-ai.com");            // role address, own domain
  assert.equal(acme.state, "drafted");
  assert.equal((await s.ctx.outbox.all()).length, 0);              // nothing sent without approval
  assert.ok(report.escalations.some((e) => /waiting for approval/.test(e.message)));
  assert.ok(!w.calls.some((u) => u.includes("intranet.test")));

  assert.equal((await s.admin("POST", "/admin/prospects/approve-all")).json.approved, 1);
  await runProspecting(s.ctx, (report = { escalations: [] }), { now });
  assert.equal(report.prospecting.sent, 1);
  const [mail] = await s.ctx.outbox.all();
  assert.equal(mail.to, "hello@acme-ai.com");
  assert.match(mail.subject, /Acme AI/);
  assert.match(mail.text, /Your support agents answer tickets/);
  assert.match(mail.text, /1 Example Road/);
  assert.match(mail.headers["List-Unsubscribe"], /wz\.test\/unsubscribe\?token=/);

  // No follow-up too early; one follow-up after the wait; never a third.
  await runProspecting(s.ctx, (report = { escalations: [] }), { now: new Date(now.getTime() + 2 * 86400_000) });
  assert.equal((await s.ctx.outbox.all()).length, 1);
  await runProspecting(s.ctx, (report = { escalations: [] }), { now: new Date(now.getTime() + 6 * 86400_000) });
  assert.equal(by("acme-ai.com").state, "followed_up");
  await runProspecting(s.ctx, (report = { escalations: [] }), { now: new Date(now.getTime() + 13 * 86400_000) });
  assert.equal((await s.ctx.outbox.all()).length, 2);

  // Unsubscribe link works and suppresses the domain.
  const unsub = mail.headers["List-Unsubscribe"].slice(1, -1).replace("http://wz.test", s.base);
  assert.equal((await fetch(unsub)).status, 200);
  assert.equal(by("acme-ai.com").state, "unsubscribed");
  assert.ok(s.ctx.prospects.data.suppression.domains.includes("acme-ai.com"));
  await s.close();
});

test("outreach is blocked until the sender's postal address and public URL are set", async () => {
  const w = world();
  const s = await startApp({ ...env, SENDER_ADDRESS: "", OUTREACH_AUTO_SEND: "true" }, { fetch: w.fetch, lookup: w.lookup });
  const report = { escalations: [] };
  await runProspecting(s.ctx, report);
  assert.match(report.prospecting.blocked, /SENDER_ADDRESS/);
  assert.equal((await s.ctx.outbox.all()).length, 0);
  await s.close();
});

test("daily cap and auto-send; signup from an outreach link creates an observe-only customer", async () => {
  const w = world();
  const s = await startApp({ ...env, OUTREACH_AUTO_SEND: "true", OUTREACH_DAILY_CAP: "0" }, { fetch: w.fetch, lookup: w.lookup });
  await runProspecting(s.ctx, { escalations: [] });
  assert.equal(s.ctx.prospects.byDomain("acme-ai.com").state, "approved");
  assert.equal((await s.ctx.outbox.all()).length, 0);          // cap of 0 sends nothing

  const prospect = s.ctx.prospects.byDomain("acme-ai.com");
  const { signToken } = await import("../src/tokens.js");
  const ref = signToken(s.ctx.config, { p: prospect.id });
  assert.equal((await s.call("GET", "/signup")).status, 200);
  const r = await s.call("POST", "/signup", { raw: new URLSearchParams({ name: "Acme AI", email: "ops@acme-ai.com", website: "acme-ai.com", ref }).toString(), headers: { "content-type": "application/x-www-form-urlencoded" } });
  assert.equal(r.status, 201);
  const key = r.text.match(/(wz_[\w-]+)/)[1];
  assert.equal(prospect.state, "signed_up");
  const tenant = s.ctx.tenants.findByKey(key);
  assert.deepEqual(tenant.policy.allowedOptimizations, []);
  assert.equal((await s.call("POST", "/signup", { raw: new URLSearchParams({ name: "Again", email: "ops@acme-ai.com" }).toString(), headers: { "content-type": "application/x-www-form-urlencoded" } })).status, 409);
  await s.close();
});
