import { isPrivateAddress } from "./prospecting.js";
import dns from "node:dns/promises";
import { median } from "./util.js";

/**
 * Runaway-spend protection, checked on every request before it reaches the provider.
 *   - budget caps: per customer (daily, monthly), per feature tag (daily), per end user (daily)
 *   - loop breaker: the same request repeated too often in a short window
 *   - spike alert: this hour's spend far above the customer's normal hourly spend
 * Each can alert only, or block/pause, as the customer chooses in their policy.
 * Spend is known only after a response, so a cap can be exceeded by the requests already in flight.
 */

const dayOf = (iso) => iso.slice(0, 10);
const monthOf = (iso) => iso.slice(0, 7);
const hourOf = (iso) => iso.slice(0, 13);

export class SpendMeter {
  constructor() { this.t = new Map(); }
  state(tenantId) {
    let s = this.t.get(tenantId);
    if (!s) { s = { day: "", dayUsd: 0, tags: new Map(), users: new Map(), month: "", monthUsd: 0, hours: new Map() }; this.t.set(tenantId, s); }
    return s;
  }
  add(event) {
    const usd = event.actualCostUsd;
    if (!usd || !event.tenantId || !event.timestamp) return;
    const s = this.state(event.tenantId);
    const day = dayOf(event.timestamp), month = monthOf(event.timestamp), hour = hourOf(event.timestamp);
    const today = dayOf(new Date().toISOString());
    if (month === monthOf(today)) {
      if (s.month !== month) { s.month = month; s.monthUsd = 0; }
      s.monthUsd += usd;
    }
    if (day === today) {
      if (s.day !== day) { s.day = day; s.dayUsd = 0; s.tags = new Map(); s.users = new Map(); }
      s.dayUsd += usd;
      if (event.tag) s.tags.set(event.tag, (s.tags.get(event.tag) || 0) + usd);
      if (event.endUser) s.users.set(event.endUser, (s.users.get(event.endUser) || 0) + usd);
    }
    s.hours.set(hour, (s.hours.get(hour) || 0) + usd);
    if (s.hours.size > 60) for (const k of [...s.hours.keys()].sort().slice(0, s.hours.size - 60)) s.hours.delete(k);
  }
  load(events) {
    const since = new Date(Date.now() - 40 * 86400_000).toISOString();
    for (const e of events) if (e.timestamp >= since) this.add(e);
  }
  today(tenantId) {
    const s = this.state(tenantId);
    const today = dayOf(new Date().toISOString());
    const month = monthOf(today);
    return {
      dayUsd: s.day === today ? s.dayUsd : 0,
      monthUsd: s.month === month ? s.monthUsd : 0,
      tag: (t) => (s.day === today && t ? s.tags.get(t) || 0 : 0),
      user: (u) => (s.day === today && u ? s.users.get(u) || 0 : 0)
    };
  }
  /** Spend in the current hour, and the median of the active hours among the previous 24. */
  hourly(tenantId, now = new Date()) {
    const s = this.state(tenantId);
    const current = s.hours.get(hourOf(now.toISOString())) || 0;
    const prev = [];
    for (let i = 1; i <= 24; i++) prev.push(s.hours.get(hourOf(new Date(now.getTime() - i * 3600_000).toISOString())) || 0);
    // "Normal" is the median of hours that had any traffic, so quiet nights don't make every busy hour look like a spike.
    const active = prev.filter((x) => x > 0);
    return { current, median: median(active), filled: active.length };
  }
}

/** Counts identical requests per customer inside a sliding window. Bounded in memory. */
export class LoopDetector {
  constructor(maxKeys = 50000) { this.seen = new Map(); this.max = maxKeys; }
  hit(tenantId, fp, windowSec, now = Date.now()) {
    const k = `${tenantId}:${fp}`;
    const list = (this.seen.get(k) || []).filter((t) => now - t < windowSec * 1000);
    list.push(now);
    this.seen.delete(k);
    this.seen.set(k, list.slice(-1000));
    while (this.seen.size > this.max) this.seen.delete(this.seen.keys().next().value);
    return list.length;
  }
}

const blocked = (status, code, message) => ({ status, code, message });

/** Decide whether a request may go ahead. Returns null, or the error to send. Fires alerts as a side effect. */
export function checkRequest(ctx, tenant, { tag, endUser, fp }) {
  const p = tenant.policy;
  if (tenant.paused) {
    return blocked(429, "wastezero_paused", `Paused by WasteZero: ${tenant.paused.reason}. Resume with POST /v1/wastezero/resume.`);
  }

  const spend = ctx.meter.today(tenant.id);
  const b = p.budgets;
  const caps = [
    ["customer_daily", b.dailyUsd, spend.dayUsd, "Daily budget"],
    ["customer_monthly", b.monthlyUsd, spend.monthUsd, "Monthly budget"],
    [`tag_daily:${tag}`, tag ? b.perTagDailyUsd[tag] || 0 : 0, spend.tag(tag), `Daily budget for feature "${tag}"`],
    [`user_daily:${endUser}`, endUser ? b.perUserDailyUsd : 0, spend.user(endUser), `Daily budget per end user (${endUser})`]
  ];
  for (const [scope, cap, used, label] of caps) {
    if (!(cap > 0) || used < cap) continue;
    alertOnce(ctx, tenant, `budget:${scope}:${new Date().toISOString().slice(0, scope.includes("monthly") ? 7 : 10)}`,
      `${label} of $${cap} reached ($${used.toFixed(2)} spent).${p.budgetAction === "block" ? " Further requests are blocked until it resets." : ""}`);
    if (p.budgetAction === "block") return blocked(429, "budget_exceeded", `${label} of $${cap} reached. Requests are blocked until it resets or the budget is raised.`);
  }

  const lb = p.loopBreaker;
  if (lb.action !== "off" && fp) {
    const n = ctx.loops.hit(tenant.id, fp, lb.windowSec);
    if (n > lb.maxRepeats) {
      alertOnce(ctx, tenant, `loop:${fp}:${Math.floor(Date.now() / (lb.windowSec * 1000))}`,
        `Possible runaway loop${tag ? ` in "${tag}"` : ""}: the same request was sent ${n} times in ${lb.windowSec}s.${lb.action === "block" ? " Repeats are being blocked." : ""}`);
      if (lb.action === "block") return blocked(429, "loop_detected", `The same request was sent more than ${lb.maxRepeats} times in ${lb.windowSec}s. Blocked to stop a runaway loop.`);
    }
  }
  return null;
}

/**
 * Count a request's spend and look for a spike. Synchronous, so a pause takes effect before
 * the next request is handled; saving and alerting happen in the background.
 */
export function meterAndCheck(ctx, event) {
  ctx.meter.add(event);
  const tenant = ctx.tenants.get(event.tenantId);
  if (tenant) spikeCheck(ctx, tenant, event);
}

function spikeCheck(ctx, tenant, event) {
  const sa = tenant.policy.spikeAlert;
  if (sa.action === "off" || !event.actualCostUsd) return;
  const { current, median: normal, filled } = ctx.meter.hourly(tenant.id);
  if (filled < 6 || current < sa.minHourlyUsd) return;   // not enough history to call it a spike
  if (current <= sa.factor * Math.max(normal, 1e-6)) return;
  const hour = new Date().toISOString().slice(0, 13);
  const msg = `Spending spike: $${current.toFixed(2)} this hour against a normal $${normal.toFixed(2)}/hour (${(current / Math.max(normal, 1e-6)).toFixed(0)}×).`;
  if (sa.action === "pause" && !tenant.paused) {
    tenant.paused = { at: new Date().toISOString(), reason: msg };
    ctx.tenants.doc.save().catch((e) => ctx.log.error("could not save pause:", e.message));
    alertOnce(ctx, tenant, `spike:${hour}`, `${msg} Traffic is paused. Resume with POST /v1/wastezero/resume.`);
  } else {
    alertOnce(ctx, tenant, `spike:${hour}`, msg);
  }
}

// ------------------------------------------------------------ alerts

const sent = new Set();

/** Send an alert to the customer (email and/or their webhook) and to the operator's audit log, at most once per key. */
export function alertOnce(ctx, tenant, key, message) {
  const k = `${tenant.id}:${key}`;
  if (sent.has(k)) return;
  sent.add(k);
  if (sent.size > 100000) sent.clear();
  deliver(ctx, tenant, message).catch((e) => ctx.log.error("alert failed:", e.message));
}

async function deliver(ctx, tenant, message) {
  const { note } = await import("./operator.js");
  await note(ctx, { level: "escalation", tenantId: tenant.id, action: "customer_alert", message: `${tenant.name}: ${message}` });
  const to = tenant.policy.alertEmail || tenant.billing?.email;
  if (to) await ctx.mailer.send({ kind: "alert", to, subject: `WasteZero alert: ${message.split(":")[0]}`, text: message, html: `<p>${message.replace(/[<>&]/g, "")}</p>` });
  if (tenant.policy.alertWebhookUrl && await isPublicHttps(ctx, tenant.policy.alertWebhookUrl)) {
    await ctx.fetch(tenant.policy.alertWebhookUrl, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: `[WasteZero] ${message}` }), redirect: "error", signal: AbortSignal.timeout(10000)
    }).catch(() => {});
  }
}

/** Customer-supplied webhook URLs must be HTTPS on a public address. */
export async function isPublicHttps(ctx, url) {
  try {
    const u = new URL(url);
    if (u.protocol !== "https:") return false;
    const lookup = ctx.lookup || ((h) => dns.lookup(h));
    const { address } = await lookup(u.hostname);
    return !isPrivateAddress(address);
  } catch { return false; }
}
