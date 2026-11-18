import test from "node:test";
import assert from "node:assert/strict";
import { startApp } from "./helpers.js";
import { runProspecting } from "../src/prospecting.js";
import { discoverAll, domainOf } from "../src/sources.js";

const json = (d, status = 200) => new Response(JSON.stringify(d), { status, headers: { "content-type": "application/json" } });
const page = (title, body) => new Response(`<html><head><title>${title}</title></head><body>${body}</body></html>`, { status: 200, headers: { "content-type": "text/html" } });

function world() {
  const calls = [];
  const fetch = async (url, init = {}) => {
    const u = new URL(url); calls.push(u.toString());
    if (u.host === "hn.test") {
      const tags = u.searchParams.get("tags") || "";
      if (tags === "show_hn") return json({ hits: [] });
      if (tags === "story,author_whoishiring") return json({ hits: [{ objectID: "900", title: "Ask HN: Who is hiring? (November 2026)" }] });
      if (tags === "comment,story_900") return json({ hits: [
        { objectID: "901", comment_text: "Hirely | LLM Engineer | Remote<p>We run GPT-4 in production. Apply: <a href=\"https:&#x2F;&#x2F;jobs.lever.co&#x2F;hirely\">lever</a> or see <a href=\"https:&#x2F;&#x2F;www.hirely.ai&#x2F;careers\">hirely.ai</a>" }
      ] });
    }
    if (u.host === "yc.test") {
      if (u.pathname === "/tags/generative-ai.json") return json([
        { name: "Small", slug: "small", website: "https://small.ai", status: "Active", team_size: 2, isHiring: false, one_liner: "tiny", batch: "W25" },
        { name: "Big", slug: "big", website: "https://www.bigco.ai/", status: "Active", team_size: 80, isHiring: true, one_liner: "LLM agents", batch: "S24" },
        { name: "Dead", slug: "dead", website: "https://dead.ai", status: "Inactive" }
      ]);
      return new Response("", { status: 404 });
    }
    if (u.host === "gh.test") {
      if (u.pathname === "/search/repositories") return json({ items: [
        { full_name: "orgy/agent", owner: { login: "orgy", type: "Organization" } },
        { full_name: "someone/toy", owner: { login: "someone", type: "User" } }
      ] });
      if (u.pathname === "/orgs/orgy") return json({ name: "Orgy Inc", blog: "orgy.dev", email: "jane@orgy.dev", description: "agents" });
    }
    if (u.host === "ph.test") return json({ data: { posts: { edges: [{ node: { id: "77", name: "Launchy", tagline: "AI notes", website: "https://www.producthunt.com/r/ABC" } }] } } });
    if (u.host === "www.producthunt.com") return new Response("", { status: 301, headers: { location: "https://launchy.app/?ref=producthunt" } });
    if (u.host === "hunter.test") return json({ data: { emails: [{ value: "sales@bigco.ai", type: "generic" }] } });
    if (u.host === "model.test") return json({ model: "gpt-4o-mini", usage: { prompt_tokens: 5, completion_tokens: 5 }, choices: [{ message: { content: JSON.stringify({ fit: 9, reason: "AI product", personalization: "" }) } }] });
    const sites = {
      "hirely.ai": page("Hirely", "LLM hiring copilot. hello@hirely.ai"),
      "bigco.ai": page("BigCo", "LLM agents for banks."),            // no address on site: Hunter finds one
      "small.ai": page("Small", "GPT tools. hi@small.ai"),
      "orgy.dev": page("Orgy", "LLM agents. No address here."),     // GitHub org email is on the domain, but a named person: not used
      "launchy.app": page("Launchy", "AI notes with GPT. team@launchy.app")
    };
    const site = sites[u.host];
    if (site) return u.pathname === "/" ? site : new Response("", { status: 404 });
    return new Response("", { status: 404 });
  };
  return { calls, fetch, lookup: async () => ({ address: "93.184.216.34" }) };
}

const env = { PROSPECTING_ENABLED: "true", HN_API_BASE: "http://hn.test", YC_API_BASE: "http://yc.test", GITHUB_API_BASE: "http://gh.test",
  PRODUCTHUNT_API_BASE: "http://ph.test", PRODUCTHUNT_TOKEN: "ph_tok", HUNTER_API_BASE: "http://hunter.test", HUNTER_API_KEY: "hk",
  PROSPECT_YC_TAGS: "generative-ai,not-a-tag", PROSPECT_HIRING_QUERIES: "LLM", PROSPECT_GITHUB_TOPICS: "llm",
  OPENAI_BASE_URL: "http://model.test/v1", PUBLIC_BASE_URL: "http://wz.test", SENDER_ADDRESS: "1 Example Road, Iseyin", EMAIL_FROM: "e@wastezero.test" };

test("domainOf skips job boards, social sites and code hosts", () => {
  assert.equal(domainOf("https://jobs.lever.co/x"), null);
  assert.equal(domainOf("https://github.com/x"), null);
  assert.equal(domainOf("https://www.Acme.ai/path"), "acme.ai");
});

test("every source finds companies; Hunter fills a missing role address; named people are never used", async () => {
  const w = world();
  const s = await startApp(env, { fetch: w.fetch, lookup: w.lookup });
  const d = await discoverAll(s.ctx, { now: Date.now() });
  assert.deepEqual(d.bySource, { hiring: 1, yc: 2, github: 1, hackernews: 0, producthunt: 1 });
  const byDomain = Object.fromEntries(s.ctx.prospects.list().map((p) => [p.domain, p]));
  assert.ok(byDomain["hirely.ai"] && !byDomain["lever.co"], "job-board link skipped, company site kept");
  assert.equal(s.ctx.prospects.list().findIndex((p) => p.domain === "bigco.ai") < s.ctx.prospects.list().findIndex((p) => p.domain === "small.ai"), true, "bigger hiring YC teams first");
  assert.ok(!byDomain["dead.ai"]);
  assert.equal(byDomain["launchy.app"].source.type, "producthunt");

  const report = { escalations: [] };
  s.ctx.prospects.data.lastDiscoveryAt = new Date().toISOString();   // discovery already done above
  await runProspecting(s.ctx, report);
  const after = Object.fromEntries(s.ctx.prospects.list().map((p) => [p.domain, p]));
  assert.equal(after["bigco.ai"].contactEmail, "sales@bigco.ai");
  assert.equal(after["bigco.ai"].contactVia, "hunter");
  assert.equal(after["hirely.ai"].contactEmail, "hello@hirely.ai");
  assert.equal(after["orgy.dev"].state, "no_contact");                // jane@ is a named person: never used
  assert.equal(after["launchy.app"].state, "drafted");
  assert.equal(report.prospecting.sent, 0, "nothing goes out without approval");
  await s.close();
});

test("Product Hunt is skipped without a token, and a failing source doesn't stop the others", async () => {
  const w = world();
  const s = await startApp({ ...env, PRODUCTHUNT_TOKEN: "", GITHUB_API_BASE: "http://down.test" }, { fetch: w.fetch, lookup: w.lookup });
  const d = await discoverAll(s.ctx, { now: Date.now() });
  assert.match(d.bySource.producthunt, /off \(needs PRODUCTHUNT_TOKEN\)/);
  assert.match(d.bySource.github, /error/);
  assert.equal(d.bySource.yc, 2);
  await s.close();
});

test("a GitHub org's published role address is used when its site shows none", async () => {
  const w = world();
  const inner = w.fetch;
  w.fetch = async (url, init) => new URL(url).pathname === "/orgs/orgy" ? json({ name: "Orgy", blog: "orgy.dev", email: "hello@orgy.dev" }) : inner(url, init);
  const s = await startApp({ ...env, PROSPECT_SOURCES: "github", HUNTER_API_KEY: "" }, { fetch: w.fetch, lookup: w.lookup });
  await runProspecting(s.ctx, { escalations: [] });
  const p = s.ctx.prospects.byDomain("orgy.dev");
  assert.equal(p.contactEmail, "hello@orgy.dev");
  assert.equal(p.state, "drafted");
  await s.close();
});

test("companies scored without AI are re-scored once AI works", async () => {
  const w = world();
  let aiDown = true;
  const inner = w.fetch;
  w.fetch = async (url, init) => (aiDown && new URL(url).host === "model.test") ? json({ error: { message: "The model `gpt-x` does not exist" } }, 404) : inner(url, init);
  const s = await startApp({ ...env, PROSPECT_SOURCES: "yc", HUNTER_API_KEY: "" }, { fetch: w.fetch, lookup: w.lookup });
  const report = { escalations: [], agents: {} };
  await runProspecting(s.ctx, report);
  const small = s.ctx.prospects.byDomain("small.ai");
  assert.equal(small.state, "disqualified");
  assert.equal(report.prospecting.aiScoringDown, true);
  assert.match(s.ctx.lastAiError.message, /does not exist/);
  aiDown = false;
  await runProspecting(s.ctx, { escalations: [] });
  assert.equal(s.ctx.prospects.byDomain("small.ai").state, "drafted");
  await s.close();
});
