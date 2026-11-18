import { round } from "./util.js";

const ok = (e) => e.status >= 200 && e.status < 300 && !e.blocked;
const daysInMonth = (d) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();

/** Month-to-date spend and where it will land at this rate (after at least one full day). */
export function forecastMonth(monthToDateUsd, now = new Date()) {
  const elapsedDays = (now.getUTCDate() - 1) + now.getUTCHours() / 24 + now.getUTCMinutes() / 1440;
  const days = daysInMonth(now);
  return {
    monthToDateUsd: round(monthToDateUsd, 4),
    projectedUsd: elapsedDays >= 1 ? round(monthToDateUsd / elapsedDays * days, 2) : null,
    daysElapsed: round(elapsedDays, 1), daysInMonth: days
  };
}

/**
 * Profit per end user and per plan, this month: what each of the customer's own users costs in AI,
 * against what that user pays (from planPrices). Shows which users lose money.
 */
export function economics({ events, tenant, now = new Date() }) {
  const month = now.toISOString().slice(0, 7);
  const prices = tenant.policy.planPrices || {};
  const users = new Map();
  let untracked = 0, total = 0;
  for (const e of events) {
    if (e.tenantId !== tenant.id || !e.timestamp?.startsWith(month) || !ok(e)) continue;
    const cost = e.actualCostUsd || 0;
    total += cost;
    if (!e.endUser) { untracked += cost; continue; }
    const u = users.get(e.endUser) || { user: e.endUser, label: null, plan: null, requests: 0, costUsd: 0 };
    u.requests++; u.costUsd += cost;
    if (e.endUserLabel) u.label = e.endUserLabel;
    if (e.plan) u.plan = e.plan;
    users.set(e.endUser, u);
  }
  const list = [...users.values()].map((u) => {
    const price = u.plan != null && prices[u.plan] != null ? prices[u.plan] : null;
    return { ...u, costUsd: round(u.costUsd, 4), priceUsd: price, marginUsd: price != null ? round(price - u.costUsd, 2) : null, losing: price != null && u.costUsd > price };
  }).sort((a, b) => b.costUsd - a.costUsd);

  const plans = new Map();
  for (const u of list) {
    const key = u.plan || "(no plan)";
    const p = plans.get(key) || { plan: key, users: 0, costUsd: 0, losingUsers: 0 };
    p.users++; p.costUsd += u.costUsd; if (u.losing) p.losingUsers++;
    plans.set(key, p);
  }
  const planList = [...plans.values()].map((p) => {
    const price = prices[p.plan] ?? null;
    const avg = p.costUsd / p.users;
    return { ...p, costUsd: round(p.costUsd, 2), avgCostPerUserUsd: round(avg, 4), priceUsd: price, avgMarginPerUserUsd: price != null ? round(price - avg, 2) : null };
  }).sort((a, b) => b.costUsd - a.costUsd);

  return {
    month, totalCostUsd: round(total, 2), untrackedCostUsd: round(untracked, 2),
    users: list.slice(0, 200), userCount: list.length, losingUsers: list.filter((u) => u.losing).length, plans: planList
  };
}
