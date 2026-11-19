import { alertOnce } from "./guard.js";

/**
 * Prepaid provider credits (commitments). For each: how much is used since it started, the burn
 * rate over the last 14 days, and what is likely to expire unused. Alert when the forecast says
 * more than 10% will go unused, so traffic can be moved onto it in time. Offers for that provider
 * are preferred while it's at risk (see creditBias).
 */

const round = (n) => Math.round(n * 100) / 100;

export function creditsReport(tenant, events, now = new Date()) {
  const out = [];
  for (const c of tenant.policy.credits || []) {
    const start = Date.parse(c.startAt), end = Date.parse(c.expiresAt);
    let used = 0, recent = 0;
    const recentFrom = Math.max(start, now.getTime() - 14 * 86400_000);
    for (const e of events) {
      if (e.tenantId !== tenant.id || !(e.actualCostUsd > 0) || e.keySource === "wastezero") continue;
      if (c.provider && e.provider !== c.provider) continue;
      const t = Date.parse(e.timestamp);
      if (t < start || t > end) continue;
      used += e.actualCostUsd;
      if (t >= recentFrom) recent += e.actualCostUsd;
    }
    const daysLeft = Math.max(0, (end - now.getTime()) / 86400_000);
    const recentDays = Math.max(1, (now.getTime() - recentFrom) / 86400_000);
    const perDay = recent / recentDays;
    const remaining = Math.max(0, c.amountUsd - used);
    const projectedUse = Math.min(remaining, perDay * daysLeft);
    const unused = round(remaining - projectedUse);
    out.push({ ...c, usedUsd: round(used), remainingUsd: round(remaining), perDayUsd: round(perDay), daysLeft: Math.round(daysLeft),
      projectedUnusedUsd: unused, atRisk: daysLeft > 0 && unused > c.amountUsd * 0.1, expired: daysLeft === 0,
      neededPerDayUsd: daysLeft > 0 ? round(remaining / daysLeft) : null });
  }
  return out;
}

/** Daily: warn about credit that will expire unused. */
export function creditsCheck(ctx, tenant, events, now = new Date()) {
  for (const c of creditsReport(tenant, events, now)) {
    if (!c.atRisk) continue;
    alertOnce(ctx, tenant, `credit:${c.id}:${now.toISOString().slice(0, 10)}`,
      `Prepaid credit at risk: ${c.provider || "provider"} credit${c.note ? ` (${c.note})` : ""} has $${c.remainingUsd} left and expires in ${c.daysLeft} days. At the current rate ($${c.perDayUsd}/day) about $${c.projectedUnusedUsd} will expire unused. Use about $${c.neededPerDayUsd}/day to use it all, e.g. by routing more traffic to it.`);
  }
}

/** Providers whose prepaid credit is at risk, to be preferred when several offers can serve a model. */
export function creditBias(tenant, events, now = new Date()) {
  return new Set(creditsReport(tenant, events, now).filter((c) => c.atRisk && c.provider).map((c) => c.provider));
}
