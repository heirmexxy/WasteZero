import { sealSecret, openSecret, orgOf, personBudget } from "./teams.js";

/**
 * AI return-on-investment ledger: what each person and team shipped for their AI spend.
 *
 * Connect GitHub (merged pull requests) and/or Jira (tickets done). Monthly, per person:
 *   AI spend, merged PRs, tickets done, $ per PR, $ per ticket. Same per team and company-wide.
 * People are matched by their GitHub username (CSV column "github") and by email in Jira.
 * Tokens are stored encrypted. Synced daily by the operator, or on demand.
 */

const round = (n, d = 2) => Math.round(n * 10 ** d) / 10 ** d;
const monthRange = (period) => {
  const [y, m] = period.split("-").map(Number);
  const start = new Date(Date.UTC(y, m - 1, 1)), end = new Date(Date.UTC(y, m, 1));
  return { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10), lastDay: new Date(end - 86400_000).toISOString().slice(0, 10) };
};

export function jiraHostOk(config, site) {
  const pattern = config.roi?.jiraHostPattern ? new RegExp(config.roi.jiraHostPattern) : /^https:\/\/[a-z0-9-]+\.atlassian\.net$/;
  return pattern.test(site);
}

/** Store or remove integrations. github: { token, org }, jira: { site, email, token } */
export function setIntegrations(config, tenant, input) {
  const o = orgOf(tenant);
  o.integrations ||= {};
  if (input.github === null) delete o.integrations.github;
  else if (input.github) {
    const org = String(input.github.org || "").trim();
    if (!/^[\w.-]{1,39}$/.test(org)) throw new Error("GitHub organisation name is not valid");
    const token = String(input.github.token || "").trim();
    if (token.length < 20 && !o.integrations.github) throw new Error("Paste a GitHub token with read access to pull requests");
    o.integrations.github = { org, token: token.length >= 20 ? sealSecret(config, token) : o.integrations.github.token };
  }
  if (input.jira === null) delete o.integrations.jira;
  else if (input.jira) {
    const site = String(input.jira.site || "").trim().replace(/\/+$/, "");
    if (!jiraHostOk(config, site)) throw new Error("Jira site must look like https://yourcompany.atlassian.net");
    const email = String(input.jira.email || "").trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("Jira account email is not valid");
    const token = String(input.jira.token || "").trim();
    if (token.length < 10 && !o.integrations.jira) throw new Error("Paste a Jira API token");
    o.integrations.jira = { site, email, token: token.length >= 10 ? sealSecret(config, token) : o.integrations.jira.token };
  }
  return integrationsView(tenant);
}

export function integrationsView(tenant) {
  const i = tenant.org?.integrations || {};
  return { github: i.github ? { org: i.github.org, tokenHint: i.github.token?.hint } : null, jira: i.jira ? { site: i.jira.site, email: i.jira.email, tokenHint: i.jira.token?.hint } : null };
}

async function getJson(ctx, url, headers) {
  const r = await ctx.fetch(url, { headers, signal: AbortSignal.timeout(20000), redirect: "error" });
  if (!r.ok) throw new Error(`HTTP ${r.status} from ${new URL(url).host}`);
  return r.json();
}

async function githubMerged(ctx, gh, period) {
  const token = openSecret(ctx.config, gh.token);
  if (!token) throw new Error("GitHub token can't be read: store it again");
  const { start, lastDay } = monthRange(period);
  const base = ctx.config.prospecting.githubApiBase;
  const headers = { accept: "application/vnd.github+json", authorization: `Bearer ${token}`, "user-agent": "WasteZero" };
  const byLogin = {};
  let total = 0;
  for (let page = 1; page <= 10; page++) {
    const q = `is:pr is:merged org:${gh.org} merged:${start}..${lastDay}`;
    const data = await getJson(ctx, `${base}/search/issues?${new URLSearchParams({ q, per_page: "100", page: String(page) })}`, headers);
    for (const it of data.items || []) { const l = String(it.user?.login || "").toLowerCase(); if (l) { byLogin[l] = (byLogin[l] || 0) + 1; total++; } }
    if (!data.items || data.items.length < 100) break;
  }
  return { byLogin, total };
}

async function jiraDone(ctx, jira, period) {
  const token = openSecret(ctx.config, jira.token);
  if (!token) throw new Error("Jira token can't be read: store it again");
  const { start, end } = monthRange(period);
  const headers = { accept: "application/json", authorization: `Basic ${Buffer.from(`${jira.email}:${token}`).toString("base64")}` };
  const jql = `statusCategory = Done AND resolved >= "${start}" AND resolved < "${end}"`;
  const byEmail = {}, byName = {};
  let total = 0, next = null;
  for (let page = 0; page < 20; page++) {
    const params = new URLSearchParams({ jql, fields: "assignee", maxResults: "100", ...(next ? { nextPageToken: next } : {}) });
    const data = await getJson(ctx, `${jira.site}/rest/api/3/search/jql?${params}`, headers);
    for (const issue of data.issues || []) {
      const a = issue.fields?.assignee;
      if (!a) continue;
      total++;
      if (a.emailAddress) byEmail[a.emailAddress.toLowerCase()] = (byEmail[a.emailAddress.toLowerCase()] || 0) + 1;
      else if (a.displayName) byName[a.displayName.toLowerCase()] = (byName[a.displayName.toLowerCase()] || 0) + 1;
    }
    next = data.nextPageToken;
    if (!next || data.isLast) break;
  }
  return { byEmail, byName, total };
}

/** Pull this month's (or a given month's) output from the connected tools. */
export async function syncRoi(ctx, tenant, period = new Date().toISOString().slice(0, 7)) {
  const o = orgOf(tenant);
  const i = o.integrations || {};
  const out = { at: new Date().toISOString(), errors: {} };
  if (i.github) { try { out.github = await githubMerged(ctx, i.github, period); } catch (e) { out.errors.github = e.message; } }
  if (i.jira) { try { out.jira = await jiraDone(ctx, i.jira, period); } catch (e) { out.errors.jira = e.message; } }
  o.roi ||= {};
  o.roi[period] = out;
  const keep = Object.keys(o.roi).sort().slice(-13);       // a year of history
  for (const k of Object.keys(o.roi)) if (!keep.includes(k)) delete o.roi[k];
  await ctx.tenants.doc.save();
  return out;
}

/** Daily, for every company with a connection (run by the operator). */
export async function syncAllRoi(ctx, now = new Date()) {
  let n = 0;
  const period = now.toISOString().slice(0, 7);
  for (const t of ctx.tenants.listCustomers()) {
    const i = t.org?.integrations;
    if (!i || (!i.github && !i.jira)) continue;
    const last = t.org.roi?.[period]?.at;
    if (last && now - new Date(last) < 20 * 3600_000) continue;
    await syncRoi(ctx, t, period); n++;
  }
  return n;
}

/** The ledger for a month: spend and output per person and team. */
export function roiReport(tenant, events, period) {
  const o = orgOf(tenant);
  const data = o.roi?.[period] || null;
  const spend = {};
  let companySpend = 0, unattributed = 0;
  for (const e of events) {
    if (e.tenantId !== tenant.id || !String(e.timestamp).startsWith(period) || !(e.actualCostUsd > 0)) continue;
    companySpend += e.actualCostUsd;
    if (e.personId) spend[e.personId] = (spend[e.personId] || 0) + e.actualCostUsd; else unattributed += e.actualCostUsd;
  }
  const prsOf = (p) => (p.githubLogin && data?.github?.byLogin?.[p.githubLogin]) || 0;
  const ticketsOf = (p) => (data?.jira ? (data.jira.byEmail?.[p.email] || (p.name && data.jira.byName?.[p.name.toLowerCase()]) || 0) : 0);
  const privacy = !!o.settings.privacyMode;
  const people = o.people.filter((p) => p.active !== false).map((p) => {
    const s = round(spend[p.id] || 0), prs = prsOf(p), tickets = ticketsOf(p);
    return { id: p.id, email: p.email, name: p.name || "", teamId: p.teamId || null, githubLogin: p.githubLogin || null, spentUsd: s, prs, tickets,
      usdPerPr: prs ? round(s / prs) : null, usdPerTicket: tickets ? round(s / tickets) : null };
  });
  const teams = o.teams.map((t) => {
    const m = people.filter((p) => p.teamId === t.id);
    const s = round(m.reduce((a, p) => a + p.spentUsd, 0)), prs = m.reduce((a, p) => a + p.prs, 0), tickets = m.reduce((a, p) => a + p.tickets, 0);
    return { id: t.id, name: t.name, spentUsd: s, prs, tickets, usdPerPr: prs ? round(s / prs) : null, usdPerTicket: tickets ? round(s / tickets) : null };
  });
  const prs = data?.github?.total || 0, tickets = data?.jira?.total || 0;
  return {
    period, connected: integrationsView(tenant), syncedAt: data?.at || null, errors: data?.errors || {},
    company: { spentUsd: round(companySpend), unattributedUsd: round(unattributed), prs, tickets, usdPerPr: prs ? round(companySpend / prs) : null, usdPerTicket: tickets ? round(companySpend / tickets) : null },
    teams,
    people: privacy ? [] : people.sort((a, b) => b.spentUsd - a.spentUsd),
    unmatchedGithub: data?.github ? Object.keys(data.github.byLogin).filter((l) => !o.people.some((p) => p.githubLogin === l)).slice(0, 50) : []
  };
}

/** A ready-made ROI note for a budget request, from the person's own record. */
export function roiNote(tenant, events, person, now = new Date()) {
  const period = now.toISOString().slice(0, 7);
  const r = roiReport(tenant, events, period);
  const me = r.people.find((p) => p.id === person.id) || { spentUsd: 0, prs: 0, tickets: 0 };
  const parts = [`This month so far: $${me.spentUsd.toFixed(2)} of AI spend`];
  if (r.connected.github) parts.push(`${me.prs} merged pull request${me.prs === 1 ? "" : "s"}${me.usdPerPr != null ? ` ($${me.usdPerPr} each)` : ""}`);
  if (r.connected.jira) parts.push(`${me.tickets} ticket${me.tickets === 1 ? "" : "s"} done${me.usdPerTicket != null ? ` ($${me.usdPerTicket} each)` : ""}`);
  const team = r.teams.find((t) => t.id === person.teamId);
  if (team?.usdPerPr != null && me.usdPerPr != null) parts.push(`team average $${team.usdPerPr} per pull request`);
  const b = personBudget(orgOf(tenant), person, now);
  return `${parts.join("; ")}. Monthly budget $${b.total}. What the extra budget will produce: `;
}
