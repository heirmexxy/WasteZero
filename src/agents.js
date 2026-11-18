import { randomBytes } from "node:crypto";
import { statfs, stat } from "node:fs/promises";
import path from "node:path";
import { JsonDoc } from "./store.js";
import { note } from "./operator.js";
import { summarize } from "./reports.js";
import { wasteReport } from "./waste.js";
import { latestInvoices } from "./billing.js";
import { runProspecting } from "./prospecting.js";
import { median, round, escapeHtml } from "./util.js";

/**
 * WasteZero's AI co-workers. They share a task board and company memory, log every decision to the
 * audit log, and make their AI calls through WasteZero itself (internal account, with budgets).
 *
 *   Chief of Staff  sets weekly goals, writes the founder's daily brief, keeps the board moving
 *   Prospector      finds and qualifies companies, drafts outreach (prospecting.js)
 *   Onboarding      helps new signups send their first request, then nudges them toward savings
 *   Inbox           triages inbound email and contact-form messages, drafts replies
 *   Reliability     watches providers, delay, disk and the public site; opens and closes incidents
 *   Optimisation / Finance: the operator (operator.js) and collections (collections.js)
 *
 * Permission levels:
 *   automatic      research, drafts, reports, reminders and onboarding emails to existing customers,
 *                  unsubscribes, health checks
 *   needs approval sending replies written by AI, first outreach (unless OUTREACH_AUTO_SEND),
 *                  anything touching money, contracts, or that can't be undone
 */

export const AGENTS = {
  chief_of_staff: { name: "Chief of Staff", role: "Weekly goals, daily brief, keeps work moving" },
  prospector: { name: "Prospector", role: "Finds companies building with AI and drafts outreach" },
  onboarding: { name: "Onboarding", role: "Gets new signups to their first request and first saving" },
  inbox: { name: "Inbox", role: "Triages incoming email and contact messages, drafts replies" },
  reliability: { name: "Reliability", role: "Watches providers, delay, disk and the site; raises incidents" },
  operator: { name: "Optimisation & Finance", role: "Finds waste, tests and ships fixes, invoices and collects" }
};

const DAY = 86400_000;
const isoWeek = (d) => {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const y0 = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  return `${t.getUTCFullYear()}-W${String(Math.ceil(((t - y0) / DAY + 1) / 7)).padStart(2, "0")}`;
};

// ------------------------------------------------------------ shared board and memory

export class Company {
  constructor(dataDir) {
    this.memory = new JsonDoc(path.join(dataDir, "company.json"), { goals: null, goalsHistory: [], briefs: [], agents: {}, onboarding: {}, incidents: [] });
    this.board = new JsonDoc(path.join(dataDir, "tasks.json"), { tasks: [] });
  }
  async init() { await this.memory.load(); await this.board.load(); }
  get m() { return this.memory.data; }
  get tasks() { return this.board.data.tasks; }

  async addTask({ owner, title, detail = "", priority = "normal", tenantId = null, kind = "task", approval = null, dedupe = null }) {
    if (dedupe && this.tasks.some((t) => t.dedupe === dedupe && !["done", "declined"].includes(t.status))) return null;
    const now = new Date().toISOString();
    const task = { id: "task_" + randomBytes(5).toString("hex"), owner, title: String(title).slice(0, 200), detail: String(detail).slice(0, 6000),
      priority, tenantId, kind, dedupe, status: approval ? "needs_approval" : "todo", approval, createdAt: now, updatedAt: now };
    this.tasks.push(task);
    // Keep the board bounded: drop finished tasks older than 30 days.
    this.board.data.tasks = this.tasks.filter((t) => !["done", "declined"].includes(t.status) || Date.parse(t.updatedAt) > Date.now() - 30 * DAY).slice(-3000);
    await this.board.save();
    return task;
  }
  async updateTask(id, patch) {
    const t = this.tasks.find((x) => x.id === id);
    if (!t) return null;
    Object.assign(t, patch, { updatedAt: new Date().toISOString() });
    await this.board.save();
    return t;
  }
  async ran(agent, summary, error = null) {
    const a = this.m.agents[agent] || { runs: 0, errors: 0 };
    a.runs++; a.lastRunAt = new Date().toISOString(); a.lastSummary = summary; if (error) { a.errors++; a.lastError = error; }
    this.m.agents[agent] = a;
    await this.memory.save();
  }
}

/** An AI call by an agent: through WasteZero itself, tagged by agent, under the internal budgets. */
async function think(ctx, agent, system, user, { json = false, maxTokens = 700 } = {}) {
  const res = await ctx.callModel({
    model: ctx.config.agents.model, temperature: 0.2, max_tokens: maxTokens,
    ...(json ? { response_format: { type: "json_object" } } : {}),
    messages: [{ role: "system", content: system }, { role: "user", content: user }]
  }, { tag: `agent-${agent}`, purpose: "agent" });
  if (!res.ok) return null;
  const text = res.data?.choices?.[0]?.message?.content;
  if (!text) return null;
  if (!json) return text.trim();
  try { return JSON.parse(text); } catch { return null; }
}

async function log(ctx, agent, message, level = "info", extra = {}) {
  return note(ctx, { actor: `agent:${agent}`, level, action: extra.action || agent, message, ...extra });
}

// ------------------------------------------------------------ facts everyone reads

async function companyFacts(ctx, now = new Date()) {
  const events = await ctx.events.all();
  const customers = ctx.tenants.listCustomers();
  const internal = ctx.tenants.list().find((t) => t.internal);
  const since = (ms) => new Date(now.getTime() - ms).toISOString();
  const day = events.filter((e) => e.timestamp >= since(DAY));
  const week = events.filter((e) => e.timestamp >= since(7 * DAY));
  const custDay = summarize(day.filter((e) => e.tenantId !== internal?.id));
  const custWeek = summarize(week.filter((e) => e.tenantId !== internal?.id));
  const ownDay = summarize(day.filter((e) => e.tenantId === internal?.id));
  const firstSeen = new Map();
  for (const e of events) if (!firstSeen.has(e.tenantId)) firstSeen.set(e.tenantId, e.timestamp);
  const fee = (list) => customers.reduce((sum, t) => sum + Math.max(0, list.filter((e) => e.tenantId === t.id).reduce((a, e) => a + (e.savingsUsd || 0), 0)) * t.policy.revenueSharePct / 100, 0);
  const prospects = ctx.prospects.list();
  const touchedSince = (ms) => prospects.reduce((n, p) => n + p.touches.filter((x) => x.at >= since(ms)).length, 0);
  const audits = await ctx.audit.query((a) => a.timestamp >= since(7 * DAY), 2000);
  const invoices = latestInvoices(await ctx.invoices.all());
  return {
    customers: customers.length,
    signupsLastDay: customers.filter((t) => t.createdAt >= since(DAY)).length,
    signupsLastWeek: customers.filter((t) => t.createdAt >= since(7 * DAY)).length,
    activatedLastWeek: customers.filter((t) => (firstSeen.get(t.id) || "") >= since(7 * DAY)).length,
    waitingForFirstRequest: customers.filter((t) => !firstSeen.has(t.id)).length,
    lastDay: { requests: custDay.calls, spendUsd: custDay.actualCostUsd, savingsUsd: custDay.savingsUsd, feesUsd: round(fee(day), 2) },
    lastWeek: { requests: custWeek.calls, spendUsd: custWeek.actualCostUsd, savingsUsd: custWeek.savingsUsd, feesUsd: round(fee(week), 2) },
    outreachSentLastDay: touchedSince(DAY), outreachSentLastWeek: touchedSince(7 * DAY),
    repliesLastWeek: prospects.filter((p) => p.repliedAt && p.repliedAt >= since(7 * DAY)).length,
    auditsLastWeek: audits.filter((a) => a.action === "audit").length,
    waitingForYou: {
      tasks: ctx.company.tasks.filter((t) => t.status === "needs_approval").length,
      outreachDrafts: ctx.prospects.list("drafted").length,
      invoicesToReconcile: invoices.filter((i) => ["draft", "needs_review"].includes(i.status)).length,
      unpaidInvoices: invoices.filter((i) => ["payment_failed", "awaiting_card"].includes(i.status)).length
    },
    openIncidents: ctx.company.m.incidents.filter((i) => !i.closedAt).map((i) => i.title),
    ownAiUse: { requests: ownDay.calls, spendUsd: ownDay.actualCostUsd, savedUsd: ownDay.savingsUsd, blocked: day.filter((e) => e.tenantId === internal?.id && e.blocked).length }
  };
}

// ------------------------------------------------------------ Chief of Staff

const COS_SYSTEM = [
  "You are the Chief of Staff of WasteZero, a company that cuts its customers' AI model costs and is paid a share of verified savings.",
  "Write for the founder: plain English, short sentences, no hype. Use ONLY the numbers in the facts given; never invent or estimate numbers.",
  "If a number is zero, say so plainly. Focus on what moves revenue: activated customers, verified savings, and approvals waiting on the founder."
].join(" ");

function goalsFromBaseline(f, cfg) {
  const grow = (x, min, factor = 1.2) => Math.max(min, Math.ceil(x * factor));
  return {
    signups: grow(f.signupsLastWeek, 3),
    activations: grow(f.activatedLastWeek, 2),
    outreach: Math.min(cfg.prospecting.dailyCap * 5, grow(f.outreachSentLastWeek, 20)),
    feesUsd: round(Math.max(f.lastWeek.feesUsd * 1.15, f.lastWeek.feesUsd + 10), 2),
    approvalsWaitingMax: 5
  };
}

async function chiefOfStaff(ctx, report, now) {
  const mem = ctx.company.m;
  const facts = await companyFacts(ctx, now);
  const out = [];

  // Weekly goals, set once per ISO week.
  const week = isoWeek(now);
  if (mem.goals?.week !== week) {
    if (mem.goals) mem.goalsHistory = [...mem.goalsHistory, { ...mem.goals, result: { signups: facts.signupsLastWeek, activations: facts.activatedLastWeek, outreach: facts.outreachSentLastWeek, feesUsd: facts.lastWeek.feesUsd } }].slice(-26);
    const targets = goalsFromBaseline(facts, ctx.config);
    const why = await think(ctx, "chief_of_staff", COS_SYSTEM,
      `Last week's facts: ${JSON.stringify(facts)}\nThis week's targets: ${JSON.stringify(targets)}\nIn 3 short bullet points, say what the team should focus on this week to hit these targets.`, { maxTokens: 300 });
    mem.goals = { week, setAt: now.toISOString(), targets, focus: why || "Get signups to their first request, turn waste reports into approved savings, and keep outreach flowing." };
    await ctx.company.memory.save();
    out.push(`set goals for ${week}`);
    await log(ctx, "chief_of_staff", `Goals for ${week}: ${targets.signups} signups, ${targets.activations} activations, ${targets.outreach} outreach emails, $${targets.feesUsd} fees`, "info", { action: "goals_set" });
  }

  // Keep the board moving: anything waiting on the founder for more than 2 days gets raised once.
  for (const t of ctx.company.tasks.filter((x) => x.status === "needs_approval" && Date.parse(x.createdAt) < now.getTime() - 2 * DAY && !x.chased)) {
    t.chased = now.toISOString();
    await log(ctx, "chief_of_staff", `Waiting on you for 2+ days: ${t.title}`, "escalation", { action: "chase" });
  }
  await ctx.company.board.save();

  // Daily brief, once a day after BRIEF_HOUR_UTC.
  const today = now.toISOString().slice(0, 10);
  if (now.getUTCHours() >= ctx.config.agents.briefHourUtc && mem.briefs.at(-1)?.date !== today) {
    const brief = await writeBrief(ctx, facts, now);
    mem.briefs = [...mem.briefs, brief].slice(-60);
    await ctx.company.memory.save();
    await deliverBrief(ctx, brief);
    out.push("sent the daily brief");
  }
  report.agents.chief_of_staff = out.join("; ") || "nothing due";
}

export async function writeBrief(ctx, facts = null, now = new Date()) {
  facts ||= await companyFacts(ctx, now);
  const goals = ctx.company.m.goals;
  const progress = goals ? {
    signups: `${facts.signupsLastWeek}/${goals.targets.signups}`, activations: `${facts.activatedLastWeek}/${goals.targets.activations}`,
    outreach: `${facts.outreachSentLastWeek}/${goals.targets.outreach}`, fees: `$${facts.lastWeek.feesUsd}/$${goals.targets.feesUsd}`
  } : null;
  const w = facts.waitingForYou;
  const prose = await think(ctx, "chief_of_staff", COS_SYSTEM,
    `Facts (last 24h and last 7 days): ${JSON.stringify(facts)}\nWeekly goals and progress (last 7 days / target): ${JSON.stringify(progress)}\nWrite the founder's morning brief: 4-6 sentences on how the business is doing, then "Today's priorities:" with exactly 3 numbered items. Mention approvals waiting on the founder first if there are any.`, { maxTokens: 450 });
  const fallback = [
    `Last 24h: ${facts.lastDay.requests} customer requests, $${facts.lastDay.spendUsd} AI spend through WasteZero, $${facts.lastDay.savingsUsd} saved, $${facts.lastDay.feesUsd} earned.`,
    `${facts.signupsLastDay} new signup(s); ${facts.waitingForFirstRequest} customer(s) still waiting to send their first request.`,
    `${facts.outreachSentLastDay} outreach email(s) sent; ${facts.repliesLastWeek} reply(ies) this week.`,
    facts.openIncidents.length ? `Open incidents: ${facts.openIncidents.join("; ")}.` : "No open incidents.",
    "Today's priorities:",
    `1. Clear what's waiting on you: ${w.tasks} approval(s), ${w.outreachDrafts} outreach draft(s), ${w.invoicesToReconcile} invoice(s) to reconcile.`,
    `2. Help the ${facts.waitingForFirstRequest} waiting customer(s) send their first request.`,
    "3. Turn waste reports into approved savings."
  ].join("\n");
  return { date: now.toISOString().slice(0, 10), at: now.toISOString(), text: prose || fallback, writtenBy: prose ? "ai" : "template", facts, progress };
}

async function deliverBrief(ctx, brief) {
  const f = brief.facts;
  const table = [
    ["Customers", f.customers], ["New signups (24h)", f.signupsLastDay], ["Requests (24h)", f.lastDay.requests],
    ["AI spend (24h)", `$${f.lastDay.spendUsd}`], ["Saved for customers (24h)", `$${f.lastDay.savingsUsd}`], ["Fees earned (24h)", `$${f.lastDay.feesUsd}`],
    ["Waiting on you", `${f.waitingForYou.tasks} approvals, ${f.waitingForYou.outreachDrafts} outreach drafts, ${f.waitingForYou.invoicesToReconcile} invoices`],
    ["WasteZero's own AI use (24h)", `$${f.ownAiUse.spendUsd} spent, $${f.ownAiUse.savedUsd} saved`]
  ];
  const html = `<p>${escapeHtml(brief.text).replace(/\n/g, "<br>")}</p><table cellpadding="6" style="border-collapse:collapse;font-size:14px">${table.map(([k, v]) => `<tr><td style="color:#666">${escapeHtml(k)}</td><td><strong>${escapeHtml(String(v))}</strong></td></tr>`).join("")}</table>
<p><a href="${escapeHtml(ctx.config.publicBaseUrl)}/console#team">Open the console</a></p>`;
  if (ctx.config.agents.founderEmail) {
    await ctx.mailer.send({ kind: "brief", to: ctx.config.agents.founderEmail, subject: `WasteZero daily brief · ${brief.date}`, text: `${brief.text}\n\n${table.map(([k, v]) => `${k}: ${v}`).join("\n")}`, html });
  }
  if (ctx.config.telegram?.adminChatId && ctx.config.telegram.botToken) {
    const { tgSend } = await import("./telegram.js");
    await tgSend(ctx, ctx.config.telegram.adminChatId, `WasteZero daily brief · ${brief.date}\n\n${brief.text}`);
  }
  await log(ctx, "chief_of_staff", `Daily brief for ${brief.date} sent`, "info", { action: "brief" });
}

// ------------------------------------------------------------ Onboarding

async function onboarding(ctx, report, now) {
  const base = ctx.config.publicBaseUrl;
  const events = await ctx.events.all();
  const state = ctx.company.m.onboarding;
  let sent = 0;
  for (const t of ctx.tenants.listCustomers()) {
    const to = t.billing?.email;
    if (!to) continue;
    const s = state[t.id] ||= {};
    const mine = events.filter((e) => e.tenantId === t.id);
    const age = now.getTime() - Date.parse(t.createdAt);
    const send = async (key, subject, text) => {
      const r = await ctx.mailer.send({ kind: `onboarding_${key}`, to, subject, text, html: `<p>${escapeHtml(text).replace(/\n/g, "<br>").replace(/(https?:\/\/\S+)/g, '<a href="$1">$1</a>')}</p>` });
      if (r.ok) { s[key] = now.toISOString(); sent++; await log(ctx, "onboarding", `${t.name}: sent "${subject}"`, "info", { tenantId: t.id, action: `onboarding_${key}` }); }
    };

    if (!mine.length) {
      if (age > DAY && !s.nudge1) await send("nudge1", "Your first request through WasteZero",
        `Hi ${t.name} team,\n\nYour WasteZero account is ready but hasn't seen a request yet. It's a one-line change: point your SDK's base URL at ${base}/v1 and use a key from your dashboard. Nothing about your traffic changes; WasteZero only watches until you approve savings.\n\nSetup steps: ${base}/app#setup\nDocs: ${base}/docs\n\nReply to this email if anything gets in the way.`);
      else if (age > 3 * DAY && s.nudge1 && !s.nudge2) await send("nudge2", "Need a hand connecting WasteZero?",
        `Hi ${t.name} team,\n\nJust checking in: still no traffic through WasteZero. If you'd rather start with zero code, run the free audit with a usage export: ${base}/audit\n\nOr reply with your stack (Python, Node, n8n…) and we'll send the exact snippet.`);
      else if (age > 7 * DAY && !s.founderTask) {
        await ctx.company.addTask({ owner: "founder", title: `Reach out personally to ${t.name}: signed up a week ago, no traffic yet`, detail: `Email: ${to}`, tenantId: t.id, dedupe: `onb-call-${t.id}` });
        s.founderTask = now.toISOString();
      }
      continue;
    }
    if (!s.welcomed) {
      await send("welcomed", "You're live on WasteZero",
        `Hi ${t.name} team,\n\nYour first requests just came through (${mine.length} so far). Two things that pay off quickly:\n1. Add X-WasteZero-Tag (feature name) and X-WasteZero-User to see spend per feature and per customer.\n2. Set a daily budget and turn the loop breaker to "block" so a runaway agent can't surprise you.\n\nYour dashboard: ${base}/app`);
      continue;
    }
    if (mine.length >= 200 && !t.policy.allowedOptimizations.length && (!s.wasteMail || now.getTime() - Date.parse(s.wasteMail) > 7 * DAY)) {
      const w = wasteReport({ events, tenant: t, config: ctx.config, rules: ctx.rules, now: now.getTime() });
      if (w.monthlyWasteUsd >= 5) await send("wasteMail", `We found $${w.monthlyWasteUsd.toFixed(0)}/month of AI waste`,
        `Hi ${t.name} team,\n\nFrom your real traffic, WasteZero estimates $${w.monthlyWasteUsd.toFixed(2)} a month of avoidable spend. The biggest item: ${w.findings[0]?.title || "see your dashboard"}.\n\nNothing changes without your approval, and cheaper models are tested on your own requests first. Review it here: ${base}/app#approvals`);
    }
    const pending = ctx.rules.forTenant(t.id).filter((r) => r.state === "proposed" && now.getTime() - Date.parse(r.createdAt) > 3 * DAY);
    if (pending.length && (!s.approvalReminder || now.getTime() - Date.parse(s.approvalReminder) > 7 * DAY)) {
      const total = pending.reduce((a, r) => a + (r.estMonthlySavingsUsd || 0), 0);
      await send("approvalReminder", `${pending.length} saving${pending.length > 1 ? "s" : ""} waiting for your approval`,
        `Hi ${t.name} team,\n\n${pending.length} proposed change(s), worth about $${total.toFixed(2)}/month together, are waiting in your dashboard: ${base}/app#approvals`);
    }
  }
  await ctx.company.memory.save();
  report.agents.onboarding = `${sent} email(s)`;
}

// ------------------------------------------------------------ Inbox

const INBOX_SYSTEM = [
  "You triage emails sent to WasteZero (an AI cost-reduction service paid as a share of verified savings, default 20%, free audit, observe-only start).",
  'Reply only with JSON: {"category": one of "unsubscribe","interested","not_interested","support","billing","bug","sales","spam","other", "summary": one sentence, "urgent": true|false,',
  '"reply": a short, friendly reply in plain text signed "WasteZero", or "" if none is needed. Only state facts from this description; for anything else say the team will follow up.}'
].join(" ");

export async function receiveInbound(ctx, msg) {
  const item = { id: "msg_" + randomBytes(5).toString("hex"), at: new Date().toISOString(), from: String(msg.from || "").slice(0, 200).toLowerCase(),
    name: String(msg.name || "").slice(0, 120), subject: String(msg.subject || "").slice(0, 300), text: String(msg.text || "").slice(0, 8000), source: msg.source || "email", status: "new" };
  await ctx.inbox.add(item);
  await triage(ctx, item);
  return item;
}

const emailOf = (from) => (String(from).match(/[^\s<>"]+@[^\s<>"]+/) || [""])[0].toLowerCase();

async function triage(ctx, item) {
  const from = emailOf(item.from);
  let v = await think(ctx, "inbox", INBOX_SYSTEM, `From: ${item.from}\nSubject: ${item.subject}\n\n${item.text.slice(0, 4000)}`, { json: true, maxTokens: 500 });
  if (!v) {
    const t = `${item.subject} ${item.text}`.toLowerCase();
    v = { category: /unsubscribe|remove me|stop emailing/.test(t) ? "unsubscribe" : /invoice|charge|card|refund|bill/.test(t) ? "billing" : /error|bug|broken|500|doesn't work|not working/.test(t) ? "bug" : "other",
      summary: item.subject || item.text.slice(0, 120), urgent: false, reply: "" };
  }
  const prospect = from && ctx.prospects.list().find((p) => p.contactEmail === from || from.endsWith("@" + p.domain));
  if (prospect && !prospect.repliedAt) await ctx.prospects.set(prospect, ["interested", "not_interested", "unsubscribe"].includes(v.category) ? (v.category === "interested" ? "replied" : prospect.state) : prospect.state, { repliedAt: item.at });

  if (v.category === "unsubscribe" || v.category === "not_interested") {
    if (from) await ctx.prospects.suppress({ email: from, domain: prospect?.domain });
    await log(ctx, "inbox", `${from} asked not to be contacted; suppressed`, "info", { action: "inbox_unsubscribe" });
    return;
  }
  if (v.category === "spam") { await log(ctx, "inbox", `Ignored spam from ${from}`, "info", { action: "inbox_spam" }); return; }

  const tenant = from ? ctx.tenants.findByEmail(from) : null;
  const subject = item.subject ? (/^re:/i.test(item.subject) ? item.subject : `Re: ${item.subject}`) : "Re: your message to WasteZero";
  const title = `${v.urgent ? "URGENT · " : ""}${v.category}: ${v.summary}`.slice(0, 200);
  const detail = `From: ${item.from}${tenant ? ` (customer: ${tenant.name})` : prospect ? ` (prospect: ${prospect.domain})` : ""}\nSubject: ${item.subject}\n\n${item.text.slice(0, 3000)}`;
  if (v.reply && from) {
    const draft = { to: from, subject, text: v.reply };
    if (ctx.config.agents.inboxAutoReply && ["interested", "sales", "support"].includes(v.category) && !v.urgent) {
      await ctx.mailer.send({ kind: "inbox_reply", ...draft, html: `<p>${escapeHtml(v.reply).replace(/\n/g, "<br>")}</p>` });
      await ctx.company.addTask({ owner: "inbox", title: `Answered: ${title}`, detail: `${detail}\n\n--- reply sent ---\n${v.reply}`, tenantId: tenant?.id || null, kind: "inbox" }).then((t) => t && ctx.company.updateTask(t.id, { status: "done" }));
      await log(ctx, "inbox", `Replied to ${from} (${v.category})`, "info", { action: "inbox_replied" });
    } else {
      await ctx.company.addTask({ owner: "inbox", title, detail, tenantId: tenant?.id || null, kind: "inbox", priority: v.urgent ? "high" : "normal", approval: { type: "send_email", payload: draft } });
      await log(ctx, "inbox", `Reply drafted for ${from} (${v.category}); waiting for your approval`, v.urgent || v.category === "bug" || v.category === "billing" ? "escalation" : "info", { action: "inbox_draft" });
    }
  } else {
    await ctx.company.addTask({ owner: "founder", title, detail, tenantId: tenant?.id || null, kind: "inbox", priority: v.urgent ? "high" : "normal" });
    await log(ctx, "inbox", `New ${v.category} message from ${from || "unknown"} needs you`, "escalation", { action: "inbox_task" });
  }
}

// ------------------------------------------------------------ Reliability

export async function reliability(ctx, report = { agents: {} }, now = new Date()) {
  const checks = [];
  const events = (await ctx.events.all()).filter((e) => e.timestamp >= new Date(now.getTime() - 15 * 60_000).toISOString());
  const byProvider = new Map();
  for (const e of events) {
    if (!e.provider || e.blocked) continue;
    const p = byProvider.get(e.provider) || { n: 0, failed: 0 };
    p.n++; if (e.status >= 500 || e.status === 0) p.failed++;
    byProvider.set(e.provider, p);
  }
  for (const [name, p] of byProvider) checks.push({ key: `provider:${name}`, ok: !(p.n >= 5 && p.failed / p.n > 0.2), title: `${name} is failing (${p.failed}/${p.n} requests in 15 min)` });

  const overhead = (await ctx.events.all()).slice(-500).map((e) => e.overheadMs).filter(Number.isFinite).sort((a, b) => a - b);
  const p95 = overhead.length >= 50 ? overhead[Math.floor(overhead.length * 0.95)] : 0;
  checks.push({ key: "overhead", ok: p95 <= 250, title: `WasteZero is adding ${p95} ms (p95) to requests` });

  try {
    const fsInfo = await statfs(ctx.config.dataDir);
    const free = fsInfo.bavail * fsInfo.bsize, total = fsInfo.blocks * fsInfo.bsize;
    checks.push({ key: "disk", ok: free > 1e9 || free / total > 0.1, title: `Disk nearly full: ${(free / 1e9).toFixed(1)} GB free` });
  } catch { /* statfs not available */ }
  try {
    const size = (await stat(path.join(ctx.config.dataDir, "events.jsonl"))).size;
    checks.push({ key: "eventlog", ok: size < 500e6, title: `Usage log is ${(size / 1e6).toFixed(0)} MB; time to move to a database` });
  } catch { /* no log yet */ }
  const rss = process.memoryUsage().rss;
  checks.push({ key: "memory", ok: rss < 1.5e9, title: `Using ${(rss / 1e9).toFixed(2)} GB of memory` });

  if (String(ctx.config.publicBaseUrl).startsWith("https://")) {
    let ok = false;
    try { ok = (await ctx.fetch(`${ctx.config.publicBaseUrl}/health`, { signal: AbortSignal.timeout(8000) })).ok; } catch { ok = false; }
    checks.push({ key: "public", ok, title: `${ctx.config.publicBaseUrl} is not reachable from the internet (HTTPS, DNS or Traefik)` });
  }

  const incidents = ctx.company.m.incidents;
  let opened = 0, closed = 0;
  for (const c of checks) {
    const open = incidents.find((i) => i.key === c.key && !i.closedAt);
    if (!c.ok && !open) {
      incidents.push({ id: "inc_" + randomBytes(4).toString("hex"), key: c.key, title: c.title, openedAt: now.toISOString() });
      opened++;
      await log(ctx, "reliability", `Incident: ${c.title}`, "escalation", { action: "incident_open" });
    } else if (c.ok && open) {
      open.closedAt = now.toISOString();
      closed++;
      await log(ctx, "reliability", `Resolved: ${open.title}`, "info", { action: "incident_closed" });
    }
  }
  ctx.company.m.incidents = incidents.slice(-200);
  await ctx.company.memory.save();
  report.agents.reliability = `${checks.length} checks, ${opened} opened, ${closed} resolved`;
  return checks;
}

// ------------------------------------------------------------ approvals

/** The founder approves a task: run the action it carries (only low-risk, pre-drafted actions exist). */
export async function approveTask(ctx, id, { edits = null } = {}) {
  const t = ctx.company.tasks.find((x) => x.id === id);
  if (!t) throw Object.assign(new Error("Task not found"), { status: 404 });
  if (t.status !== "needs_approval") throw Object.assign(new Error(`Task is ${t.status}`), { status: 409 });
  const a = t.approval;
  if (a?.type === "send_email") {
    const payload = { ...a.payload, ...(edits || {}) };
    const r = await ctx.mailer.send({ kind: "approved_reply", to: payload.to, subject: payload.subject, text: payload.text, html: `<p>${escapeHtml(payload.text).replace(/\n/g, "<br>")}</p>` });
    if (!r.ok) throw Object.assign(new Error(`Email failed: ${r.error}`), { status: 502 });
    await ctx.company.updateTask(id, { status: "done", approval: { ...a, payload, approvedAt: new Date().toISOString() } });
  } else {
    await ctx.company.updateTask(id, { status: "done" });
  }
  await note(ctx, { actor: "admin", level: "info", action: "task_approved", message: `Approved: ${t.title}` });
  return ctx.company.tasks.find((x) => x.id === id);
}

// ------------------------------------------------------------ the team's run

export async function runAgents(ctx, report, { now = new Date(), only = null } = {}) {
  report.agents ||= {};
  if (!ctx.config.agents.enabled) { report.agents.skipped = "AGENTS_ENABLED=false"; return report; }
  const steps = [
    ["chief_of_staff", () => chiefOfStaff(ctx, report, now)],
    ["onboarding", () => onboarding(ctx, report, now)],
    ["reliability", () => reliability(ctx, report, now)],
    ["prospector", async () => {
      if (!ctx.config.prospecting.enabled) { report.agents.prospector = "off (PROSPECTING_ENABLED=false)"; return; }
      await runProspecting(ctx, report, { now });
      report.agents.prospector = report.prospecting ? `${report.prospecting.sent} sent, ${report.prospecting.drafted} drafted` : "ran";
    }]
  ];
  for (const [name, fn] of steps) {
    if (only && only !== name) continue;
    try { await fn(); await ctx.company.ran(name, report.agents[name] || "ran"); }
    catch (error) {
      report.agents[name] = `error: ${error.message}`;
      await ctx.company.ran(name, "error", error.message);
      await log(ctx, name, `Agent error: ${error.message}`, "escalation", { action: "agent_error" });
    }
  }
  return report;
}

export async function teamStatus(ctx) {
  const m = ctx.company.m;
  return {
    agents: Object.entries(AGENTS).map(([id, a]) => ({ id, ...a, ...(m.agents[id] || {}) })),
    goals: m.goals, goalsHistory: m.goalsHistory.slice(-8), brief: m.briefs.at(-1) || null,
    incidents: m.incidents.slice().reverse().slice(0, 30),
    tasks: ctx.company.tasks.slice().reverse().slice(0, 300),
    facts: await companyFacts(ctx)
  };
}
