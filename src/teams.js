import { randomBytes, createCipheriv, createDecipheriv, createHash } from "node:crypto";
import { signToken, verifyToken } from "./tokens.js";
import { note } from "./operator.js";

/**
 * WasteZero for Teams: AI budgets for a company's employees.
 *
 *   company (tenant) ── roles (monthly budget per role)
 *                    ── teams (members' budgets pool together, like T&E)
 *                    ── people (email, role, team, manager) ── own WasteZero key
 *                    ── exceptions (more budget, approved up a chain that scales with the ask)
 *
 * Every request from a person is checked against their budget (plus approved extras). Over budget,
 * the team pool can absorb it; when that is used up too, the company chooses: switch to a cheaper
 * model (default, work doesn't stop) or stop until more budget is approved.
 * Alerts at 80% and 100% go to the person and their manager. Privacy mode (works-council countries):
 * managers see team totals only, never one person's spend.
 */

export const DEFAULT_FALLBACK_MODELS = { "claude-": "claude-haiku-4-5", "gpt-5": "gpt-5-mini", "gpt-4": "gpt-4o-mini", "o3": "gpt-4o-mini", "o4": "gpt-4o-mini", "gemini-": "gemini-2.5-flash" };

export function defaultOrg() {
  return {
    enabled: false,
    roles: [
      { id: "technical", name: "Technical", monthlyUsd: 1000 },
      { id: "delivery", name: "Delivery (technical)", monthlyUsd: 500 },
      { id: "non-technical", name: "Non-technical", monthlyUsd: 100 }
    ],
    teams: [], people: [], exceptions: [],
    settings: { onLimit: "downgrade", usePool: true, privacyMode: false, alertPcts: [80, 100], slackWebhookUrl: "", fallbackModels: {}, execEmails: [], financeEmails: [] },
    providerKeys: {}
  };
}

const newId = (p) => `${p}_${randomBytes(5).toString("hex")}`;
const round = (n) => Math.round(n * 100) / 100;
const monthOf = (d) => d.toISOString().slice(0, 7);
const slug = (s) => String(s || "").toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);
const isEmail = (s) => /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/.test(s);

export function orgOf(tenant) {
  if (!tenant.org) tenant.org = defaultOrg();
  const o = tenant.org, d = defaultOrg();
  for (const k of Object.keys(d)) if (o[k] === undefined) o[k] = d[k];
  o.settings = { ...d.settings, ...o.settings };
  return o;
}

export const person = (o, id) => o.people.find((p) => p.id === id && p.active !== false) || null;
export const personByEmail = (o, email) => o.people.find((p) => p.email === String(email || "").toLowerCase().trim() && p.active !== false) || null;
const manager = (o, p) => (p?.managerId ? person(o, p.managerId) : null);
/** n = 1: manager; n = 2: manager's manager ("second line"); n = 3: third line. */
function lineManager(o, p, n) {
  let cur = p;
  for (let i = 0; i < n && cur; i++) cur = manager(o, cur);
  return cur && cur.id !== p.id ? cur : null;
}

// ------------------------------------------------------------ budgets

export function activeExceptions(o, personId, now = new Date()) {
  return o.exceptions.filter((x) => x.personId === personId && x.state === "approved" && (!x.expiresAt || Date.parse(x.expiresAt) > now.getTime()));
}

export function personBudget(o, p, now = new Date()) {
  const role = o.roles.find((r) => r.id === p.roleId);
  const base = Number.isFinite(p.monthlyUsd) ? p.monthlyUsd : (role?.monthlyUsd ?? 0);
  const extra = activeExceptions(o, p.id, now).reduce((s, x) => s + x.amountUsd, 0);
  return { base, extra: round(extra), total: round(base + extra) };
}

export function teamBudget(o, teamId, now = new Date()) {
  return round(o.people.filter((p) => p.active !== false && p.teamId === teamId).reduce((s, p) => s + personBudget(o, p, now).total, 0));
}

export function fallbackModel(config, o, model) {
  const m = String(model || "");
  const exact = o.settings.fallbackModels?.[m] || config.downgradeMap?.[m];
  if (exact) return exact;
  const prefixes = { ...DEFAULT_FALLBACK_MODELS, ...(config.teams?.fallbackModels || {}), ...(o.settings.fallbackModels || {}) };
  const hit = Object.keys(prefixes).filter((k) => m.startsWith(k)).sort((a, b) => b.length - a.length)[0];
  const to = hit && prefixes[hit];
  return to && to !== m && !m.includes("haiku") && !m.includes("mini") && !m.includes("flash") ? to : null;
}

/**
 * Check a request from a company employee. Identifies the person (by their own key, or by
 * X-WasteZero-User = their email), may switch the model when they are over budget, and returns
 * null to go ahead or { status, code, message } to refuse. Sets req.wzTeam for the event log.
 */
export function teamsGate(ctx, tenant, req, body) {
  const o = tenant.org;
  if (!o?.enabled) return null;
  let p = req.wzPersonId ? person(o, req.wzPersonId) : null;
  if (!p) { const u = String(req.headers["x-wastezero-user"] || ""); if (u.includes("@")) p = personByEmail(o, u); }
  if (!p) return null;
  req.wzTeam = { personId: p.id, teamId: p.teamId || null };
  const now = new Date();
  const m = ctx.meter.month(tenant.id);
  const b = personBudget(o, p, now);
  const used = m.person(p.id);
  thresholds(ctx, tenant, o, p, used, b.total, now);
  if (!(b.total > 0) || used < b.total) return null;
  if (o.settings.usePool && p.teamId) {
    const pool = teamBudget(o, p.teamId, now);
    if (m.team(p.teamId) < pool) { req.wzTeam.overBudget = "team_pool"; return null; }
  }
  req.wzTeam.overBudget = o.settings.onLimit === "block" ? "blocked" : "fallback";
  if (o.settings.onLimit === "block") {
    return { status: 429, code: "person_budget_exceeded", message: `Your monthly AI budget of $${b.total} is used up. Ask for more: ${ctx.config.publicBaseUrl}/me/signin` };
  }
  const to = fallbackModel(ctx.config, o, body.model);
  if (to) { req.wzTeam.budgetFallbackFrom = body.model; body.model = to; }
  return null;
}

// ------------------------------------------------------------ alerts

const sentAlerts = new Set();

function thresholds(ctx, tenant, o, p, used, total, now) {
  if (!(total > 0)) return;
  const month = monthOf(now);
  for (const pct of [...o.settings.alertPcts].sort((a, b) => b - a)) {
    if (used < total * pct / 100) continue;
    const key = `${tenant.id}:${p.id}:${month}:${pct}`;
    p.alerted ||= {};
    if (sentAlerts.has(key) || p.alerted[`${month}:${pct}`]) return;
    sentAlerts.add(key);
    p.alerted = Object.fromEntries(Object.entries(p.alerted).filter(([k]) => k.startsWith(month)));
    p.alerted[`${month}:${pct}`] = now.toISOString();
    ctx.tenants.doc.save().catch(() => {});
    personAlert(ctx, tenant, o, p, pct, used, total).catch((e) => ctx.log.error("team alert failed:", e.message));
    return;   // only the highest threshold crossed
  }
  teamThreshold(ctx, tenant, o, p.teamId, now);
}

async function personAlert(ctx, tenant, o, p, pct, used, total) {
  const link = meLink(ctx, tenant, p);
  const over = o.settings.onLimit === "block" ? "AI requests will stop until more budget is approved" : "your requests will move to a cheaper model";
  const what = pct >= 100 ? `You've used your AI budget for this month ($${round(used)} of $${total}). Unless your team has budget to spare, ${over}.` : `You've used ${pct}% of your AI budget for this month ($${round(used)} of $${total}).`;
  await ctx.mailer.send({ kind: "team-alert", to: p.email, subject: pct >= 100 ? "Your AI budget is used up" : `You've used ${pct}% of your AI budget`,
    text: `${what}\n\nSee your usage or ask for more: ${link}\n\nTip: match the model to the task. Smaller models handle drafting, summaries and simple edits well.` });
  const mgr = manager(o, p);
  if (mgr && !o.settings.privacyMode) {
    await ctx.mailer.send({ kind: "team-alert", to: mgr.email, subject: `${p.name || p.email} has used ${pct}% of their AI budget`,
      text: `${p.name || p.email} has used $${round(used)} of their $${total} AI budget this month (${pct}%).\n\nWorth a quick word: what's driving it, and could a smaller model get the same result? They can ask for more here: ${link.split("?")[0].replace("/me", "/me/signin")}` });
  }
  await slack(ctx, o, o.settings.privacyMode ? null : `:warning: ${p.name || p.email} has used ${pct}% of their AI budget ($${round(used)} / $${total}).`);
  await note(ctx, { actor: "teams", action: "budget_alert", tenantId: tenant.id, message: `${o.settings.privacyMode ? "A person" : p.email} reached ${pct}% of their budget` });
}

function teamThreshold(ctx, tenant, o, teamId, now) {
  if (!teamId) return;
  const team = o.teams.find((t) => t.id === teamId);
  const pool = teamBudget(o, teamId, now);
  if (!team || !(pool > 0)) return;
  const used = ctx.meter.month(tenant.id).team(teamId);
  const month = monthOf(now);
  for (const pct of [...o.settings.alertPcts].sort((a, b) => b - a)) {
    if (used < pool * pct / 100) continue;
    team.alerted ||= {};
    if (team.alerted[`${month}:${pct}`]) return;
    team.alerted = Object.fromEntries(Object.entries(team.alerted).filter(([k]) => k.startsWith(month)));
    team.alerted[`${month}:${pct}`] = now.toISOString();
    ctx.tenants.doc.save().catch(() => {});
    const lead = team.leadId ? person(o, team.leadId) : null;
    const text = `Team ${team.name} has used ${pct}% of its pooled AI budget this month ($${round(used)} of $${pool}).`;
    if (lead) ctx.mailer.send({ kind: "team-alert", to: lead.email, subject: `Team ${team.name}: ${pct}% of AI budget used`, text }).catch(() => {});
    slack(ctx, o, `:bar_chart: ${text}`).catch(() => {});
    return;
  }
}

async function slack(ctx, o, text) {
  const url = o.settings.slackWebhookUrl;
  if (!text || !url || !/^https:\/\/hooks\.slack\.com\//.test(url)) return;
  try { await ctx.fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text }), signal: AbortSignal.timeout(8000) }); }
  catch (e) { ctx.log.error("slack post failed:", e.message); }
}

// ------------------------------------------------------------ exceptions (more budget)

/**
 * Who approves depends on the size of the ask, against the person's role budget:
 *   up to +20%, this month only      → second-line manager
 *   up to 3× the budget, 90 days     → third-line manager, with an ROI note
 *   above 3×, reviewed monthly        → an executive and finance (both)
 * Missing managers fall back to the company's account owner.
 */
export function approvalPlan(o, p, amountUsd, ownerEmail) {
  const base = personBudget(o, p).base || 1;
  const fallback = (who) => (who ? [who.email] : ownerEmail ? [ownerEmail] : []);
  if (amountUsd <= base * 0.2 + 1e-9) return { level: 1, needsRoi: false, days: null, groups: [{ name: "second-line manager", emails: fallback(lineManager(o, p, 2) || lineManager(o, p, 1)) }] };
  if (amountUsd <= base * 2 + 1e-9) return { level: 2, needsRoi: true, days: 90, groups: [{ name: "third-line manager", emails: fallback(lineManager(o, p, 3) || lineManager(o, p, 2) || lineManager(o, p, 1)) }] };
  const exec = o.settings.execEmails?.length ? o.settings.execEmails : (ownerEmail ? [ownerEmail] : []);
  const fin = o.settings.financeEmails?.length ? o.settings.financeEmails : (ownerEmail ? [ownerEmail] : []);
  return { level: 3, needsRoi: true, days: 30, groups: [{ name: "executive", emails: exec }, { name: "finance", emails: fin }] };
}

export async function requestException(ctx, tenant, p, { amountUsd, reason, roi }, now = new Date()) {
  const o = orgOf(tenant);
  amountUsd = round(Number(amountUsd));
  if (!(amountUsd > 0) || amountUsd > 1e6) throw new Error("Enter how many extra dollars you need this month");
  reason = String(reason || "").trim().slice(0, 1000);
  roi = String(roi || "").trim().slice(0, 1500);
  if (!reason) throw new Error("Say what the extra budget is for");
  if (o.exceptions.some((x) => x.personId === p.id && x.state === "pending")) throw new Error("You already have a request waiting for approval");
  const plan = approvalPlan(o, p, amountUsd, tenant.billing?.email);
  if (plan.needsRoi && roi.length < 20) throw new Error("A request this size needs a short ROI justification: what it will produce, and why it's worth the cost");
  if (!plan.groups.every((g) => g.emails.length)) throw new Error("No approver is set up for a request this size. Ask your company admin.");
  const x = {
    id: newId("ex"), personId: p.id, amountUsd, reason, roi, level: plan.level, days: plan.days, state: "pending",
    groups: plan.groups.map((g) => ({ name: g.name, emails: g.emails, approvedBy: null })), createdAt: now.toISOString()
  };
  o.exceptions.push(x);
  if (o.exceptions.length > 2000) o.exceptions = o.exceptions.slice(-2000);
  await ctx.tenants.doc.save();
  for (const g of x.groups) for (const email of g.emails) {
    const link = `${ctx.config.publicBaseUrl}/teams/approve?token=${encodeURIComponent(signToken(ctx.config, { k: "tx", t: tenant.id, x: x.id, a: email }, 14 * 86400))}`;
    await ctx.mailer.send({ kind: "team-exception", to: email, subject: `AI budget request: ${p.name || p.email} asks for $${amountUsd} more`,
      text: `${p.name || p.email} asks for $${amountUsd} more AI budget (${describeTerm(x)}).\n\nWhat for: ${reason}${roi ? `\nROI: ${roi}` : ""}\n\nYou're asked as ${g.name}. Approve or decline: ${link}` });
  }
  await note(ctx, { actor: "teams", action: "exception_requested", tenantId: tenant.id, message: `$${amountUsd} more for ${p.email} (level ${x.level})` });
  return x;
}

export function describeTerm(x) {
  return x.level === 1 ? "this month only" : x.level === 2 ? "for 90 days, then reviewed" : "for 30 days, reviewed monthly";
}

function endOfMonth(now) { return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString(); }

/** An approver (by email, from their signed link) or the company admin ("admin") decides. */
export async function decideException(ctx, tenant, exId, approverEmail, decision, now = new Date()) {
  const o = orgOf(tenant);
  const x = o.exceptions.find((e) => e.id === exId);
  if (!x) throw new Error("Request not found");
  if (x.state !== "pending") throw new Error(`This request was already ${x.state}`);
  const admin = approverEmail === "admin";
  const groups = admin ? x.groups : x.groups.filter((g) => g.emails.includes(approverEmail) && !g.approvedBy);
  if (!groups.length) throw new Error("You're not an approver for this request, or you've already approved it");
  const p = o.people.find((q) => q.id === x.personId);
  if (decision === "decline") {
    x.state = "declined"; x.decidedAt = now.toISOString(); x.decidedBy = admin ? "admin" : approverEmail;
  } else {
    for (const g of groups) g.approvedBy = admin ? "admin" : approverEmail;
    if (x.groups.every((g) => g.approvedBy)) {
      x.state = "approved"; x.decidedAt = now.toISOString();
      x.expiresAt = x.days ? new Date(now.getTime() + x.days * 86400_000).toISOString() : endOfMonth(now);
    }
  }
  await ctx.tenants.doc.save();
  if (p && x.state !== "pending") {
    await ctx.mailer.send({ kind: "team-exception", to: p.email, subject: x.state === "approved" ? `Approved: $${x.amountUsd} more AI budget` : "Your AI budget request was declined",
      text: x.state === "approved" ? `Your request for $${x.amountUsd} more AI budget was approved (${describeTerm(x)}, until ${x.expiresAt.slice(0, 10)}).` : `Your request for $${x.amountUsd} more AI budget was declined. Talk to your manager if you'd like to discuss it.` });
  }
  await note(ctx, { actor: "teams", action: `exception_${decision}`, tenantId: tenant.id, message: `${x.id} ${decision} by ${admin ? "admin" : approverEmail} → ${x.state}` });
  return x;
}

/** Mark expired extras and ask for a review (run by the operator). */
export async function sweepTeams(ctx, now = new Date()) {
  let n = 0;
  for (const t of ctx.tenants.list()) {
    const o = t.org;
    if (!o?.enabled) continue;
    for (const x of o.exceptions) {
      if (x.state !== "approved" || !x.expiresAt || Date.parse(x.expiresAt) > now.getTime()) continue;
      x.state = "expired"; n++;
      const p = o.people.find((q) => q.id === x.personId);
      if (p && x.level > 1) {
        const review = [p.email, ...(o.settings.privacyMode ? [] : [manager(o, p)?.email])].filter(Boolean);
        for (const to of review) await ctx.mailer.send({ kind: "team-exception", to, subject: "Extra AI budget has ended: review",
          text: `The extra $${x.amountUsd}/month AI budget for ${p.name || p.email} has ended. If it's still needed, request it again with what it produced.` }).catch(() => {});
      }
    }
    for (const x of o.exceptions) if (x.state === "pending" && Date.parse(x.createdAt) < now.getTime() - 14 * 86400_000) { x.state = "expired"; n++; }
  }
  if (n) await ctx.tenants.doc.save();
  return n;
}

// ------------------------------------------------------------ directory: CSV import

/**
 * CSV columns (header row required, any order): email, name, role, team, manager_email, monthly_usd
 * Unknown roles and teams are created (new roles start at $100). Existing people are updated.
 * People missing from the file are left alone unless deactivateMissing is set.
 */
export function importPeople(o, csv, { deactivateMissing = false } = {}) {
  const lines = String(csv || "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length < 2) throw new Error("Paste a header row and at least one person");
  const split = (l) => { const out = []; let cur = "", q = false; for (const ch of l) { if (ch === '"') q = !q; else if (ch === "," && !q) { out.push(cur.trim()); cur = ""; } else cur += ch; } out.push(cur.trim()); return out; };
  const head = split(lines[0]).map((h) => h.toLowerCase().replace(/[^a-z_]/g, ""));
  const col = (name, ...alts) => [name, ...alts].map((n) => head.indexOf(n)).find((i) => i >= 0) ?? -1;
  const ci = { email: col("email"), name: col("name"), role: col("role"), team: col("team"), manager: col("manager_email", "manageremail", "manager"), usd: col("monthly_usd", "monthlyusd", "budget") };
  if (ci.email < 0) throw new Error("The header needs an email column");
  if (lines.length - 1 > 5000) throw new Error("At most 5,000 people per import");
  const result = { added: 0, updated: 0, deactivated: 0, errors: [] };
  const seen = new Set(), managers = [];
  lines.slice(1).forEach((line, i) => {
    const c = split(line);
    const email = (c[ci.email] || "").toLowerCase();
    if (!isEmail(email)) { result.errors.push(`Row ${i + 2}: "${email}" is not an email`); return; }
    seen.add(email);
    let p = o.people.find((q) => q.email === email);
    if (!p) { p = { id: newId("p"), email, createdAt: new Date().toISOString() }; o.people.push(p); result.added++; } else result.updated++;
    p.active = true;
    if (ci.name >= 0 && c[ci.name]) p.name = c[ci.name].slice(0, 80);
    if (ci.role >= 0 && c[ci.role]) {
      const rid = slug(c[ci.role]);
      if (!o.roles.some((r) => r.id === rid)) o.roles.push({ id: rid, name: c[ci.role].slice(0, 40), monthlyUsd: 100 });
      p.roleId = rid;
    }
    if (!p.roleId) p.roleId = o.roles[0]?.id;
    if (ci.team >= 0 && c[ci.team]) {
      const tid = slug(c[ci.team]);
      if (!o.teams.some((t) => t.id === tid)) o.teams.push({ id: tid, name: c[ci.team].slice(0, 60), leadId: null });
      p.teamId = tid;
    }
    if (ci.usd >= 0 && c[ci.usd] !== "" && c[ci.usd] !== undefined) {
      const v = Number(String(c[ci.usd]).replace(/[$,]/g, ""));
      if (Number.isFinite(v) && v >= 0) p.monthlyUsd = v; else result.errors.push(`Row ${i + 2}: monthly_usd "${c[ci.usd]}" is not a number`);
    }
    if (ci.manager >= 0) managers.push([p, (c[ci.manager] || "").toLowerCase()]);
  });
  for (const [p, mEmail] of managers) {
    const m = mEmail && o.people.find((q) => q.email === mEmail);
    p.managerId = m && m.id !== p.id ? m.id : null;
    if (mEmail && !m) result.errors.push(`${p.email}: manager ${mEmail} is not in the list`);
  }
  // A team's lead is the manager most of its members report to.
  for (const t of o.teams) {
    const counts = {};
    for (const p of o.people) if (p.teamId === t.id && p.managerId && p.active !== false) counts[p.managerId] = (counts[p.managerId] || 0) + 1;
    const top = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
    if (top) t.leadId = top[0];
  }
  if (deactivateMissing) for (const p of o.people) if (!seen.has(p.email) && p.active !== false) { p.active = false; result.deactivated++; }
  return result;
}

// ------------------------------------------------------------ reports

export function teamsReport(ctx, tenant, now = new Date()) {
  const o = orgOf(tenant);
  const m = ctx.meter.month(tenant.id);
  const people = o.people.filter((p) => p.active !== false).map((p) => {
    const b = personBudget(o, p, now), used = round(m.person(p.id));
    return { id: p.id, email: p.email, name: p.name || "", roleId: p.roleId, teamId: p.teamId || null, managerEmail: manager(o, p)?.email || null,
      budgetUsd: b.total, extraUsd: b.extra, spentUsd: used, pct: b.total > 0 ? used / b.total : null, hasKey: !!p.keyId };
  });
  const teams = o.teams.map((t) => {
    const members = people.filter((p) => p.teamId === t.id);
    const budget = teamBudget(o, t.id, now), used = round(m.team(t.id));
    return { id: t.id, name: t.name, lead: t.leadId ? person(o, t.leadId)?.email || null : null, members: members.length, budgetUsd: budget, spentUsd: used, pct: budget > 0 ? used / budget : null, overBudgetMembers: members.filter((p) => p.pct >= 1).length };
  });
  const total = { people: people.length, budgetUsd: round(people.reduce((s, p) => s + p.budgetUsd, 0)), spentUsd: round(m.allPeople()), fallbacksThisMonth: m.fallbacks() };
  return {
    enabled: o.enabled, settings: { ...o.settings }, roles: o.roles, teams,
    // Privacy mode: the company sees team totals, never one person's spend.
    people: o.settings.privacyMode ? people.map(({ spentUsd, pct, ...rest }) => rest) : people,
    exceptions: o.exceptions.slice(-200).reverse().map((x) => ({ ...x, person: o.people.find((p) => p.id === x.personId)?.email || "?", term: describeTerm(x) })),
    providerKeys: Object.keys(o.providerKeys || {}), total
  };
}

// ------------------------------------------------------------ company provider keys (encrypted at rest)

const keyFor = (config) => createHash("sha256").update("wastezero-secrets:" + (config.signingSecret || config.adminKey || "")).digest();

export function sealSecret(config, plain) {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", keyFor(config), iv);
  const data = Buffer.concat([c.update(String(plain), "utf8"), c.final()]);
  return { iv: iv.toString("base64"), tag: c.getAuthTag().toString("base64"), data: data.toString("base64"), hint: `${String(plain).slice(0, 6)}…${String(plain).slice(-4)}` };
}

export function openSecret(config, sealed) {
  try {
    const d = createDecipheriv("aes-256-gcm", keyFor(config), Buffer.from(sealed.iv, "base64"));
    d.setAuthTag(Buffer.from(sealed.tag, "base64"));
    return Buffer.concat([d.update(Buffer.from(sealed.data, "base64")), d.final()]).toString("utf8");
  } catch { return null; }
}

/** The company's stored provider keys, decrypted, for requests that don't bring their own. */
export function storedProviderKeys(config, tenant) {
  const sealed = tenant.org?.providerKeys;
  if (!sealed || !Object.keys(sealed).length) return null;
  const out = {};
  for (const [name, s] of Object.entries(sealed)) { const k = openSecret(config, s); if (k) out[name] = k; }
  return out;
}

// ------------------------------------------------------------ employee links

export function meLink(ctx, tenant, p, ttlSec = 7 * 86400) {
  return `${ctx.config.publicBaseUrl}/me?token=${encodeURIComponent(signToken(ctx.config, { k: "me", t: tenant.id, p: p.id }, ttlSec))}`;
}

export function personFromToken(ctx, token) {
  const v = verifyToken(ctx.config, token);
  if (v?.k !== "me") return null;
  const tenant = ctx.tenants.get(v.t);
  const p = tenant?.org?.enabled ? person(tenant.org, v.p) : null;
  return p ? { tenant, person: p } : null;
}

export function exceptionFromToken(ctx, token) {
  const v = verifyToken(ctx.config, token);
  if (v?.k !== "tx") return null;
  const tenant = ctx.tenants.get(v.t);
  const x = tenant?.org?.exceptions?.find((e) => e.id === v.x);
  return x ? { tenant, exception: x, approver: v.a } : null;
}

export { isEmail, newId, round };
