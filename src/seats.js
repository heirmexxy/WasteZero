import { orgOf } from "./teams.js";

/**
 * Subscription seat or pay-per-use, per person.
 *
 * For each employee, last 30 days of pay-per-use spend through WasteZero, by provider, compared
 * with the subscription seats the company could buy instead. A seat is recommended when the person
 * spends clearly more than its price (25% margin) but within what the seat realistically covers;
 * heavier and automated use stays pay-per-use. People who hold a seat AND run up pay-per-use
 * spend are flagged (paying twice). All figures are estimates: seat usage limits are set by the
 * provider and change, so each company can edit the plan list (policy.seatPlans).
 */

export const DEFAULT_SEAT_PLANS = [
  { name: "Claude Team Premium seat (monthly billing)", provider: "anthropic", priceUsd: 125, coversUsd: 450 },
  { name: "Claude Team Premium seat (annual billing)", provider: "anthropic", priceUsd: 100, coversUsd: 450 }
];

const round = (n) => Math.round(n * 100) / 100;

export function seatAdvice(tenant, events, now = new Date()) {
  const o = orgOf(tenant);
  const plans = tenant.policy.seatPlans?.length ? tenant.policy.seatPlans : DEFAULT_SEAT_PLANS;
  const since = now.getTime() - 30 * 86400_000;
  const spend = new Map();
  for (const e of events) {
    if (e.tenantId !== tenant.id || !e.personId || !(e.actualCostUsd > 0) || Date.parse(e.timestamp) < since) continue;
    if (e.keySource === "wastezero" && e.status >= 400) continue;
    const prov = e.provider || (String(e.requestedModel || e.model || "").startsWith("claude") ? "anthropic" : "openai");
    const m = spend.get(e.personId) || {};
    m[prov] = (m[prov] || 0) + e.actualCostUsd;
    spend.set(e.personId, m);
  }
  const people = [];
  let totalSaving = 0;
  for (const p of o.people.filter((x) => x.active !== false)) {
    const byProv = spend.get(p.id) || {};
    const total = Object.values(byProv).reduce((a, b) => a + b, 0);
    let best = null;
    for (const plan of plans) {
      const s = byProv[plan.provider] || 0;
      if (s > plan.priceUsd * 1.25 && s <= plan.coversUsd) {
        const saving = s - plan.priceUsd;
        if (!best || saving > best.monthlySavingUsd) best = { action: "seat", plan: plan.name, monthlySavingUsd: round(saving), spendUsd: round(s) };
      }
    }
    let rec;
    if (p.seat && total > 20) rec = { action: "check", note: `Holds a seat (${p.seat}) and also spent $${round(total)} pay-per-use: paying twice. Point their tools at the seat, or drop the seat.`, monthlySavingUsd: 0 };
    else if (best) { rec = best; totalSaving += best.monthlySavingUsd; }
    else if (total > 0) {
      const top = plans.filter((pl) => (byProv[pl.provider] || 0) > pl.coversUsd);
      rec = { action: "pay-per-use", note: top.length ? "Heavy use beyond what a seat covers: keep pay-per-use (budgets and routing apply)." : "Spends less than a seat costs: keep pay-per-use.", monthlySavingUsd: 0 };
    } else rec = { action: "none", note: p.seat ? `Holds a seat (${p.seat}); no pay-per-use spend seen.` : "No AI spend through WasteZero in 30 days.", monthlySavingUsd: 0 };
    people.push({ id: p.id, email: p.email, name: p.name || "", seat: p.seat || null, spend30dUsd: round(total), byProvider: Object.fromEntries(Object.entries(byProv).map(([k, v]) => [k, round(v)])), ...rec });
  }
  people.sort((a, b) => b.monthlySavingUsd - a.monthlySavingUsd || b.spend30dUsd - a.spend30dUsd);
  return {
    plans, totalMonthlySavingUsd: round(totalSaving), moveToSeat: people.filter((p) => p.action === "seat").length, payingTwice: people.filter((p) => p.action === "check").length,
    people: o.settings.privacyMode ? [] : people,
    note: "Estimates from the last 30 days. Seat usage limits are set by each provider and change; edit the plan list to match your contract."
  };
}
