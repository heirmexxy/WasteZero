/**
 * Where the Prospector looks for companies that spend on AI models.
 *
 *   hackernews   "Show HN" launches that mention LLMs                      free, no key
 *   hiring       "Ask HN: Who is hiring?" posts asking for LLM/AI skills   free, no key  (strongest spend signal)
 *   yc           Y Combinator companies tagged AI (yc-oss open dataset)    free, no key
 *   github       organisations with recently active LLM repositories       free; GITHUB_TOKEN raises limits
 *   producthunt  new launches in the AI topic                              needs PRODUCTHUNT_TOKEN
 *
 * Each source returns candidates { domain, url, source, email? }. Only public data is read.
 */

export const SKIP_DOMAINS = /(^|\.)(github\.com|github\.io|gitlab\.com|youtube\.com|youtu\.be|medium\.com|substack\.com|twitter\.com|x\.com|linkedin\.com|producthunt\.com|apple\.com|google\.com|huggingface\.co|notion\.site|notion\.so|vercel\.app|netlify\.app|reddit\.com|ycombinator\.com|workatastartup\.com|arxiv\.org|wikipedia\.org|npmjs\.com|pypi\.org|herokuapp\.com|pages\.dev|replit\.app|streamlit\.app|greenhouse\.io|lever\.co|ashbyhq\.com|workable\.com|bamboohr\.com|breezy\.hr|recruitee\.com|wellfound\.com|angel\.co|forms\.gle|bit\.ly|calendly\.com|docs\.google\.com|discord\.gg|discord\.com|t\.me|facebook\.com|instagram\.com|tiktok\.com|openai\.com|anthropic\.com)$/i;

export const rootDomain = (hostname) => hostname.toLowerCase().replace(/^www\./, "");

export function domainOf(url) {
  try {
    const d = rootDomain(new URL(url).hostname);
    return d.includes(".") && !SKIP_DOMAINS.test(d) ? d : null;
  } catch { return null; }
}

const decodeHtml = (s) => String(s || "").replace(/&#x2F;/gi, "/").replace(/&#x27;/gi, "'").replace(/&quot;/g, '"').replace(/&gt;/g, ">").replace(/&lt;/g, "<").replace(/&amp;/g, "&");
const stripTags = (s) => decodeHtml(String(s || "").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();

async function getJson(ctx, url, init = {}) {
  const res = await ctx.fetch(url, { ...init, signal: AbortSignal.timeout(20000) });
  if (!res.ok) { const e = new Error(`HTTP ${res.status} from ${new URL(url).host}`); e.status = res.status; throw e; }
  return res.json();
}

// ------------------------------------------------------------ the sources

async function hackernews(ctx, { now }) {
  const pc = ctx.config.prospecting;
  const since = Math.floor(now / 1000) - 30 * 86400;
  const out = [];
  for (const query of pc.queries) {
    const url = `${pc.hnApiBase}/search_by_date?${new URLSearchParams({ query, tags: "show_hn", hitsPerPage: "50", numericFilters: `created_at_i>${since}` })}`;
    const { hits = [] } = await getJson(ctx, url);
    for (const hit of hits) {
      const domain = hit.url && domainOf(hit.url);
      if (domain) out.push({ domain, url: hit.url, source: { type: "hackernews", ref: hit.objectID, title: String(hit.title || "").slice(0, 200), query } });
    }
  }
  return out;
}

/** Companies hiring for LLM work in the latest "Ask HN: Who is hiring?" thread. */
async function hiring(ctx) {
  const pc = ctx.config.prospecting;
  const { hits: stories = [] } = await getJson(ctx, `${pc.hnApiBase}/search_by_date?${new URLSearchParams({ tags: "story,author_whoishiring", hitsPerPage: "6" })}`);
  const story = stories.find((h) => /who is hiring/i.test(h.title || ""));
  if (!story) return [];
  const out = [];
  for (const query of pc.hiringQueries) {
    const { hits = [] } = await getJson(ctx, `${pc.hnApiBase}/search?${new URLSearchParams({ tags: `comment,story_${story.objectID}`, query, hitsPerPage: "100" })}`);
    for (const hit of hits) {
      const text = decodeHtml(hit.comment_text);
      const urls = [...text.matchAll(/https?:\/\/[^\s"'<>)\]]+/g)].map((m) => m[0]);
      const url = urls.find((u) => domainOf(u));
      if (!url) continue;
      const firstLine = stripTags(text.split(/<p>/i)[0]).slice(0, 200);
      out.push({ domain: domainOf(url), url: `https://${domainOf(url)}`, source: { type: "hiring", ref: hit.objectID, title: firstLine, query } });
    }
  }
  return out;
}

/** Y Combinator companies with AI tags, from the open yc-oss dataset (refreshed daily). Larger, hiring teams first. */
async function yc(ctx) {
  const pc = ctx.config.prospecting;
  const out = [];
  for (const tag of pc.ycTags) {
    let list;
    try { list = await getJson(ctx, `${pc.ycApiBase}/tags/${encodeURIComponent(tag)}.json`); }
    catch (e) { if (e.status === 404) continue; throw e; }
    if (!Array.isArray(list)) continue;
    list = list.filter((c) => c.website && (!c.status || /^active$/i.test(String(c.status).trim())))
      .sort((a, b) => (Number(b.isHiring) - Number(a.isHiring)) || ((b.team_size || 0) - (a.team_size || 0)));
    for (const c of list) {
      const domain = domainOf(c.website);
      if (domain) out.push({ domain, url: c.website, source: { type: "yc", ref: c.slug || c.name, title: `${c.name || domain}${c.batch ? ` (YC ${c.batch})` : ""}: ${c.one_liner || ""}`.slice(0, 200), query: tag } });
    }
  }
  return out;
}

/** Organisations (not individuals) pushing to LLM repositories in the last 30 days. */
async function github(ctx, { now, limit }) {
  const pc = ctx.config.prospecting;
  const headers = { accept: "application/vnd.github+json", "user-agent": "WasteZeroBot", ...(pc.githubToken ? { authorization: `Bearer ${pc.githubToken}` } : {}) };
  const since = new Date(now - 30 * 86400_000).toISOString().slice(0, 10);
  const orgs = new Map();
  for (const topic of pc.githubTopics) {
    const q = `topic:${topic} pushed:>${since}`;
    const { items = [] } = await getJson(ctx, `${pc.githubApiBase}/search/repositories?${new URLSearchParams({ q, sort: "updated", per_page: "50" })}`, { headers });
    for (const r of items) if (r.owner?.type === "Organization" && !orgs.has(r.owner.login)) orgs.set(r.owner.login, { repo: r.full_name, topic });
  }
  const out = [];
  for (const [login, hint] of orgs) {
    if (out.length >= limit) break;
    if (ctx.prospects.list().some((p) => p.source?.type === "github" && p.source.ref === login)) continue;
    let org;
    try { org = await getJson(ctx, `${pc.githubApiBase}/orgs/${encodeURIComponent(login)}`, { headers }); } catch (e) { if (e.status === 403 || e.status === 429) break; continue; }
    const site = org.blog && (/^https?:\/\//.test(org.blog) ? org.blog : `https://${org.blog}`);
    const domain = site && domainOf(site);
    if (!domain) continue;
    const email = org.email && String(org.email).toLowerCase().endsWith("@" + domain) ? String(org.email).toLowerCase() : null;
    out.push({ domain, url: site, email, source: { type: "github", ref: login, title: `${org.name || login}: ${org.description || hint.repo}`.slice(0, 200), query: hint.topic } });
  }
  return out;
}

/** Newest launches in Product Hunt's AI topic. Needs a free developer token. */
async function producthunt(ctx) {
  const pc = ctx.config.prospecting;
  if (!pc.productHuntToken) { const e = new Error("needs PRODUCTHUNT_TOKEN"); e.skip = true; throw e; }
  const query = `{ posts(first: 40, order: NEWEST, topic: "${pc.productHuntTopic.replace(/[^a-z0-9-]/gi, "")}") { edges { node { id name tagline website } } } }`;
  const data = await getJson(ctx, `${pc.productHuntApiBase}/v2/api/graphql`, {
    method: "POST", headers: { authorization: `Bearer ${pc.productHuntToken}`, "content-type": "application/json", accept: "application/json" }, body: JSON.stringify({ query })
  });
  const out = [];
  for (const { node } of data?.data?.posts?.edges || []) {
    let url = node.website;
    if (!url) continue;
    if (/producthunt\.com\/r\//.test(url)) {   // Product Hunt wraps the website in a redirect
      try { const r = await ctx.fetch(url, { redirect: "manual", signal: AbortSignal.timeout(10000) }); url = r.headers.get("location") || ""; } catch { continue; }
    }
    const domain = domainOf(url);
    if (domain) out.push({ domain, url, source: { type: "producthunt", ref: node.id, title: `${node.name}: ${node.tagline || ""}`.slice(0, 200), query: pc.productHuntTopic } });
  }
  return out;
}

export const SOURCES = { hackernews, hiring, yc, github, producthunt };

/**
 * Run every enabled source; add up to `perSourceLimit` new companies from each.
 * Returns { added, bySource: { name: count | "error: ..." } }.
 */
export async function discoverAll(ctx, { now = Date.now() } = {}) {
  const pc = ctx.config.prospecting;
  const bySource = {};
  let added = 0;
  for (const name of pc.sources) {
    const fn = SOURCES[name];
    if (!fn) { bySource[name] = "unknown source"; continue; }
    try {
      const candidates = await fn(ctx, { now, limit: pc.perSourceLimit });
      let n = 0;
      for (const c of candidates) {
        if (n >= pc.perSourceLimit) break;
        if (ctx.prospects.byDomain(c.domain)) continue;
        const p = await ctx.prospects.add({ domain: c.domain, url: c.url, source: c.source });
        if (p) { if (c.email) await ctx.prospects.set(p, null, { sourceEmail: c.email }); n++; }
      }
      bySource[name] = n; added += n;
    } catch (error) {
      bySource[name] = error.skip ? `off (${error.message})` : `error: ${error.message}`;
      if (!error.skip) ctx.log.error(`prospect source ${name} failed:`, error.message);
    }
  }
  return { added, bySource };
}

/** Hunter.io: find a role address (hello@, sales@...) for a domain when its website shows none. */
export async function hunterRoleEmail(ctx, domain, roleAddresses) {
  const pc = ctx.config.prospecting;
  if (!pc.hunterApiKey) return null;
  try {
    const data = await getJson(ctx, `${pc.hunterApiBase}/v2/domain-search?${new URLSearchParams({ domain, type: "generic", limit: "10", api_key: pc.hunterApiKey })}`);
    const emails = (data?.data?.emails || []).map((e) => String(e.value || "").toLowerCase()).filter((e) => e.endsWith("@" + domain));
    return emails.find((e) => roleAddresses.has(e.split("@")[0])) || emails[0] || null;
  } catch (error) { ctx.log.error("hunter lookup failed:", error.message); return null; }
}
