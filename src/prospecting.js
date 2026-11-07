import dns from "node:dns/promises";
import net from "node:net";
import { randomBytes } from "node:crypto";
import { JsonDoc } from "./store.js";
import { signToken, link } from "./tokens.js";
import { escapeHtml } from "./util.js";
import { DEFAULT_POLICY } from "./tenants.js";

/**
 * Finding customers, in stages:
 *   discovered -> enriched -> qualified -> drafted -> approved -> contacted -> followed_up
 *   side exits: unreachable, no_contact, disqualified, rejected, unsubscribed, signed_up, closed
 *
 * Guardrails (deliberate, keep them):
 *   - only public company websites are read; robots.txt is respected; private network addresses are refused
 *   - only role addresses on the company's own domain are contacted (hello@, sales@...), never named people
 *   - at most 2 emails per company; unsubscribes and existing customers are never contacted
 *   - every email carries the sender's postal address and a one-click unsubscribe
 *   - a daily send cap; by default each first email waits for human approval
 */

const ROLE_ADDRESSES = new Set(["hello", "hi", "hey", "contact", "info", "sales", "team", "founders", "founder", "partnerships", "partners", "business", "growth", "bd"]);
const SKIP_DOMAINS = /(^|\.)(github\.com|github\.io|gitlab\.com|youtube\.com|youtu\.be|medium\.com|substack\.com|twitter\.com|x\.com|linkedin\.com|producthunt\.com|apple\.com|google\.com|huggingface\.co|notion\.site|vercel\.app|netlify\.app|reddit\.com|ycombinator\.com|arxiv\.org|wikipedia\.org|npmjs\.com|pypi\.org|chrome\.google\.com|herokuapp\.com|pages\.dev|replit\.app|streamlit\.app)$/i;
const AI_SIGNALS = [/\bGPT[-‑ ]?\d/i, /\bLLMs?\b/, /\bOpenAI\b/i, /\bAnthropic\b|\bClaude\b/, /\bGemini\b/, /\bAI[- ](powered|agents?|assistant|copilot|native)\b/i, /\bgenerative AI\b/i, /\bchatbots?\b/i, /\bRAG\b/, /\bembeddings?\b/i, /\blanguage models?\b/i];
const MAX_PAGE_BYTES = 512 * 1024;

export class Prospects {
  constructor(file) { this.doc = new JsonDoc(file, { prospects: [], suppression: { emails: [], domains: [] }, lastDiscoveryAt: null }); }
  async init() { await this.doc.load(); }
  get data() { return this.doc.data; }
  get(id) { return this.data.prospects.find((p) => p.id === id) || null; }
  byDomain(domain) { return this.data.prospects.find((p) => p.domain === domain) || null; }
  list(state) { return this.data.prospects.filter((p) => !state || p.state === state); }
  async add({ domain, url, source }) {
    if (this.byDomain(domain)) return null;
    const now = new Date().toISOString();
    const p = { id: "p_" + randomBytes(6).toString("hex"), domain, url, source, state: "discovered", discoveredAt: now, updatedAt: now, touches: [], history: [{ at: now, to: "discovered" }] };
    this.data.prospects.push(p);
    await this.doc.save();
    return p;
  }
  async set(p, state, patch = {}, note = "") {
    Object.assign(p, patch);
    const now = new Date().toISOString();
    if (state && state !== p.state) { p.history.push({ at: now, from: p.state, to: state, note }); p.state = state; }
    p.updatedAt = now;
    await this.doc.save();
    return p;
  }
  suppressed(email, domain) {
    const s = this.data.suppression;
    return s.emails.includes(String(email).toLowerCase()) || s.domains.includes(domain);
  }
  async suppress({ email, domain }) {
    const s = this.data.suppression;
    if (email && !s.emails.includes(email.toLowerCase())) s.emails.push(email.toLowerCase());
    if (domain && !s.domains.includes(domain)) s.domains.push(domain);
    for (const p of this.data.prospects) {
      if ((domain && p.domain === domain) || (email && p.contactEmail === email.toLowerCase())) {
        if (!["signed_up"].includes(p.state)) { p.history.push({ at: new Date().toISOString(), from: p.state, to: "unsubscribed" }); p.state = "unsubscribed"; }
      }
    }
    await this.doc.save();
  }
}

// ------------------------------------------------------------ safe page fetching

export function isPrivateAddress(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const v = ip.toLowerCase();
  if (v.startsWith("::ffff:")) return isPrivateAddress(v.slice(7));
  return v === "::1" || v === "::" || v.startsWith("fc") || v.startsWith("fd") || v.startsWith("fe8") || v.startsWith("fe9") || v.startsWith("fea") || v.startsWith("feb");
}

export const rootDomain = (hostname) => hostname.toLowerCase().replace(/^www\./, "");

async function fetchPage(ctx, url, redirects = 3) {
  const u = new URL(url);
  if (!["http:", "https:"].includes(u.protocol)) throw new Error("unsupported protocol");
  const lookup = ctx.lookup || ((h) => dns.lookup(h));
  const { address } = await lookup(u.hostname);
  if (isPrivateAddress(address)) throw new Error("private address refused");
  const res = await ctx.fetch(u.toString(), {
    redirect: "manual",
    headers: { "user-agent": `WasteZeroBot/0.4 (+${ctx.config.publicBaseUrl || "contact via site"})`, accept: "text/html,text/plain" },
    signal: AbortSignal.timeout(10000)
  });
  if (res.status >= 300 && res.status < 400 && res.headers.get("location") && redirects > 0) {
    return fetchPage(ctx, new URL(res.headers.get("location"), u).toString(), redirects - 1);
  }
  if (!res.ok) return { status: res.status, text: "", url: u.toString() };
  const reader = res.body?.getReader?.();
  if (!reader) return { status: res.status, text: (await res.text()).slice(0, MAX_PAGE_BYTES), url: u.toString() };
  const chunks = []; let size = 0;
  while (size < MAX_PAGE_BYTES) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value); size += value.length;
  }
  reader.cancel().catch(() => {});
  return { status: res.status, text: Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("utf8").slice(0, MAX_PAGE_BYTES), url: u.toString() };
}

/** Very small robots.txt reader: honours Disallow rules in the "*" and WasteZeroBot groups. */
export function robotsAllows(robotsTxt, path) {
  let applies = false;
  const rules = [];
  for (const raw of robotsTxt.split("\n")) {
    const line = raw.replace(/#.*/, "").trim();
    const [k, ...rest] = line.split(":");
    const key = k?.toLowerCase(), value = rest.join(":").trim();
    if (key === "user-agent") applies = value === "*" || /wastezerobot/i.test(value);
    else if (key === "disallow" && applies && value) rules.push(value);
  }
  return !rules.some((r) => path.startsWith(r));
}

function parsePage(html, domain) {
  const title = (html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1] || "").trim().slice(0, 200);
  const description = (html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i)?.[1] ||
    html.match(/<meta[^>]+content=["']([^"']*)["'][^>]+name=["']description["']/i)?.[1] || "").trim().slice(0, 400);
  const text = html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
  const emails = new Set();
  for (const m of html.matchAll(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g)) {
    const e = m[0].toLowerCase().replace(/\.$/, "");
    const [local, host] = e.split("@");
    if ((host === domain || host.endsWith("." + domain)) && ROLE_ADDRESSES.has(local.split("+")[0])) emails.add(e);
  }
  return { title, description, text, emails: [...emails] };
}

export async function enrich(ctx, p) {
  const origin = `https://${p.domain}`;
  let robots = "";
  try { const r = await fetchPage(ctx, `${origin}/robots.txt`); if (r.status === 200) robots = r.text; } catch { /* none */ }
  const pages = [];
  for (const path of ["/", "/contact", "/about"]) {
    if (robots && !robotsAllows(robots, path)) continue;
    try {
      const r = await fetchPage(ctx, origin + path);
      if (r.status === 200 && r.text) pages.push(parsePage(r.text, p.domain));
    } catch { /* skip page */ }
  }
  if (!pages.length) return ctx.prospects.set(p, "unreachable", {}, robots ? "blocked by robots.txt or unreachable" : "unreachable");
  const home = pages[0];
  const allText = pages.map((x) => x.text).join(" ");
  const aiSignals = AI_SIGNALS.filter((re) => re.test(allText)).length;
  const emails = [...new Set(pages.flatMap((x) => x.emails))];
  const preferred = ["founders", "founder", "hello", "hi", "sales", "partnerships", "team", "contact", "info"];
  emails.sort((a, b) => preferred.indexOf(a.split("@")[0]) - preferred.indexOf(b.split("@")[0]));
  const company = { title: home.title, description: home.description, excerpt: allText.slice(0, 3000) };
  if (!emails.length) return ctx.prospects.set(p, "no_contact", { company, aiSignals }, "no role address on the public site");
  return ctx.prospects.set(p, "enriched", { company, aiSignals, contactEmail: emails[0] });
}

// ------------------------------------------------------------ discovery

export async function discoverFromHackerNews(ctx, { now = Date.now() } = {}) {
  const pc = ctx.config.prospecting;
  const since = Math.floor(now / 1000) - 30 * 86400;
  let added = 0;
  for (const query of pc.queries) {
    try {
      const url = `${pc.hnApiBase}/search_by_date?${new URLSearchParams({ query, tags: "show_hn", hitsPerPage: "50", numericFilters: `created_at_i>${since}` })}`;
      const res = await ctx.fetch(url, { signal: AbortSignal.timeout(15000) });
      if (!res.ok) continue;
      const { hits = [] } = await res.json();
      for (const hit of hits) {
        if (!hit.url) continue;
        let domain;
        try { domain = rootDomain(new URL(hit.url).hostname); } catch { continue; }
        if (SKIP_DOMAINS.test(domain) || ctx.prospects.byDomain(domain)) continue;
        if (await ctx.prospects.add({ domain, url: hit.url, source: { type: "hackernews", ref: hit.objectID, title: String(hit.title || "").slice(0, 200), query } })) added++;
      }
    } catch (error) { ctx.log.error(`discovery "${query}" failed:`, error.message); }
  }
  ctx.prospects.data.lastDiscoveryAt = new Date(now).toISOString();
  await ctx.prospects.doc.save();
  return added;
}

export async function importDomains(ctx, domains, source = { type: "import" }) {
  const added = [];
  for (const raw of domains) {
    let domain;
    try { domain = rootDomain(new URL(/^https?:\/\//.test(raw) ? raw : `https://${raw}`).hostname); } catch { continue; }
    const p = await ctx.prospects.add({ domain, url: `https://${domain}`, source });
    if (p) added.push(p);
  }
  return added;
}

// ------------------------------------------------------------ qualification and drafting

const QUALIFY_SYSTEM = [
  "You qualify B2B leads for WasteZero, a service that lowers a company's spend on AI model APIs and charges a share of the savings it verifies.",
  "Score fit 0-10. High: the company's own hosted product clearly calls large language models in production (AI features, agents, chat, generation, extraction).",
  "Low: agencies, courses, tutorials, open-source libraries with no hosted product, hardware, or no evidence of LLM API use.",
  "Use only the evidence given. Do not invent facts about the company.",
  'Reply only with JSON: {"fit": 0-10, "reason": "<one sentence>", "personalization": "<one plain sentence referring to something specific on their site; no flattery; no claims about their costs>"}'
].join(" ");

export async function qualify(ctx, p) {
  const pc = ctx.config.prospecting;
  const evidence = JSON.stringify({ domain: p.domain, title: p.company?.title, description: p.company?.description, excerpt: p.company?.excerpt?.slice(0, 2500), source: p.source?.title });
  const res = await ctx.callModel({ model: pc.model, temperature: 0, response_format: { type: "json_object" },
    messages: [{ role: "system", content: QUALIFY_SYSTEM }, { role: "user", content: evidence }] });
  let verdict = null;
  if (res.ok) { try { verdict = JSON.parse(res.data.choices?.[0]?.message?.content || ""); } catch { /* fall through */ } }
  if (!verdict || !Number.isFinite(Number(verdict.fit))) {
    // No grader available: rely on visible AI signals only, and write no personal line.
    verdict = { fit: Math.min(10, (p.aiSignals || 0) * 2), reason: `${p.aiSignals || 0} AI signals on the public site (no grader available)`, personalization: "" };
  }
  const fit = Math.max(0, Math.min(10, Math.round(Number(verdict.fit))));
  const patch = { fit, reason: String(verdict.reason || "").slice(0, 300), personalization: String(verdict.personalization || "").slice(0, 300) };
  return ctx.prospects.set(p, fit >= pc.minFit ? "qualified" : "disqualified", patch, patch.reason);
}

const companyName = (p) => (p.company?.title || p.domain).split(/[|\-–—:]/)[0].trim().slice(0, 60) || p.domain;

export function draftEmail(ctx, p, kind = "first") {
  const { email, publicBaseUrl } = ctx.config;
  const pct = DEFAULT_POLICY.revenueSharePct;
  const signupUrl = link(ctx.config, "/signup", { ref: signToken(ctx.config, { p: p.id }, 60 * 86400) });
  const unsubscribeUrl = link(ctx.config, "/unsubscribe", { token: signToken(ctx.config, { e: p.contactEmail, d: p.domain }, 365 * 86400) });
  const name = companyName(p);
  const paragraphs = kind === "first" ? [
    `Hi ${name} team,`,
    p.personalization,
    "WasteZero sits between your app and your model provider (a one-line base-URL change). It finds repeated requests and simple tasks running on expensive models, tests cheaper handling against your real traffic, and only switches when answer quality holds.",
    `You pay ${pct}% of the savings we verify against your provider bill, and nothing if we save nothing. It starts in observe-only mode, so nothing changes until you approve it.`,
    `If that's useful, you can start here: ${signupUrl}`
  ] : [
    `Hi ${name} team,`,
    `A short follow-up on my note about lowering your AI model costs. Setup is a one-line change, it starts observe-only, and the fee is ${pct}% of verified savings only: ${signupUrl}`,
    "If it's not a fit, no reply is needed and I won't write again."
  ];
  const footer = [`${email.senderName}`, email.senderAddress, `Unsubscribe: ${unsubscribeUrl}`];
  const body = paragraphs.filter(Boolean);
  return {
    subject: kind === "first" ? `Lowering ${name}'s AI model costs, paid only from savings` : `Re: Lowering ${name}'s AI model costs`,
    text: [...body, "", ...footer].join("\n\n"),
    html: body.map((t) => `<p>${escapeHtml(t).replace(/(https?:\/\/\S+)/g, '<a href="$1">$1</a>')}</p>`).join("") +
      `<p style="color:#666;font-size:12px">${escapeHtml(email.senderName)}<br>${escapeHtml(email.senderAddress)}<br><a href="${escapeHtml(unsubscribeUrl)}">Unsubscribe</a></p>`,
    headers: { "List-Unsubscribe": `<${unsubscribeUrl}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" },
    canSend: Boolean(publicBaseUrl && email.senderAddress)
  };
}

function sentToday(ctx, now) {
  const day = now.toISOString().slice(0, 10);
  return ctx.prospects.list().reduce((n, p) => n + p.touches.filter((t) => t.at.startsWith(day)).length, 0);
}

async function sendTouch(ctx, p, kind, now) {
  const draft = draftEmail(ctx, p, kind);
  const result = await ctx.mailer.send({ kind: `outreach_${kind}`, to: p.contactEmail, subject: draft.subject, html: draft.html, text: draft.text, headers: draft.headers });
  if (!result.ok) return ctx.prospects.set(p, null, { lastError: result.error });
  p.touches.push({ at: now.toISOString(), kind, messageId: result.id });
  return ctx.prospects.set(p, kind === "first" ? "contacted" : "followed_up", { lastError: null });
}

/** One prospecting pass: discover (daily), enrich, qualify, draft, send within the cap, follow up once. */
export async function runProspecting(ctx, report, { now = new Date() } = {}) {
  const pc = ctx.config.prospecting;
  const out = { discovered: 0, enriched: 0, qualified: 0, drafted: 0, sent: 0, followedUp: 0, blocked: null };
  const last = ctx.prospects.data.lastDiscoveryAt ? Date.parse(ctx.prospects.data.lastDiscoveryAt) : 0;
  if (now.getTime() - last >= pc.discoverEveryHours * 3600_000) out.discovered = await discoverFromHackerNews(ctx, { now: now.getTime() });

  for (const p of ctx.prospects.list("discovered").slice(0, pc.batchSize)) { await enrich(ctx, p); if (p.state === "enriched") out.enriched++; }
  for (const p of ctx.prospects.list("enriched").slice(0, pc.batchSize)) {
    if (ctx.tenants.findByEmail(p.contactEmail) || ctx.tenants.list().some((t) => t.website && t.website.includes(p.domain))) { await ctx.prospects.set(p, "closed", {}, "already a customer"); continue; }
    await qualify(ctx, p);
    if (p.state === "qualified") out.qualified++;
  }
  for (const p of ctx.prospects.list("qualified")) {
    await ctx.prospects.set(p, pc.autoSend ? "approved" : "drafted", {}, pc.autoSend ? "auto-send enabled" : "awaiting approval");
    out.drafted++;
  }

  const probe = draftEmail(ctx, { id: "x", domain: "example.com", contactEmail: "x@example.com" });
  if (!probe.canSend) {
    out.blocked = "Set PUBLIC_BASE_URL and SENDER_ADDRESS before outreach can be sent.";
  } else {
    let budget = pc.dailyCap - sentToday(ctx, now);
    for (const p of ctx.prospects.list("approved")) {
      if (budget <= 0) break;
      if (ctx.prospects.suppressed(p.contactEmail, p.domain)) { await ctx.prospects.set(p, "unsubscribed", {}, "suppressed"); continue; }
      await sendTouch(ctx, p, "first", now);
      if (p.state === "contacted") { out.sent++; budget--; }
    }
    for (const p of ctx.prospects.list("contacted")) {
      if (budget <= 0) break;
      const lastTouch = Date.parse(p.touches.at(-1)?.at || 0);
      if (now.getTime() - lastTouch < pc.followUpDays * 86400_000) continue;
      if (ctx.prospects.suppressed(p.contactEmail, p.domain)) { await ctx.prospects.set(p, "unsubscribed", {}, "suppressed"); continue; }
      await sendTouch(ctx, p, "followup", now);
      if (p.state === "followed_up") { out.followedUp++; budget--; }
    }
    for (const p of ctx.prospects.list("followed_up")) {
      if (now.getTime() - Date.parse(p.touches.at(-1).at) > 14 * 86400_000) await ctx.prospects.set(p, "closed", {}, "no response");
    }
  }
  report.prospecting = out;
  const waiting = ctx.prospects.list("drafted").length;
  if (waiting && out.drafted) report.escalations.push({ message: `${waiting} outreach emails are waiting for approval.` });
  return out;
}
