import { randomBytes } from "node:crypto";
import { round, escapeHtml } from "./util.js";

/**
 * Savings basis (state this in the customer contract):
 * for every successful request WasteZero changed, savings = cost of the tokens at the
 * model the customer requested - cost actually incurred. A reused answer costs 0.
 * Routed requests use the cheaper model's token counts for both sides, because the
 * original model was never called; tokenisers differ slightly between models.
 * Losses net against gains, and the fee is never below zero.
 */
export function computeInvoice({ events, tenant, period, usage = null }) {
  const rows = events.filter((e) => e.tenantId === tenant.id && e.timestamp?.startsWith(period) && e.status >= 200 && e.status < 300);
  let actualCostUsd = 0, baselineCostUsd = 0, savingsUsd = 0, optimizedCalls = 0, unpricedOptimizedCalls = 0, wzKeyCostUsd = 0;
  const byOptimization = {};
  const seatSet = new Set();
  for (const e of rows) {
    actualCostUsd += e.actualCostUsd ?? 0;
    baselineCostUsd += e.baselineCostUsd ?? e.actualCostUsd ?? 0;
    if (e.keySource === "wastezero") wzKeyCostUsd += e.actualCostUsd ?? 0;
    if (e.personId) seatSet.add(e.personId);
    if (!e.optimization) continue;
    optimizedCalls++;
    if (e.savingsUsd == null) { unpricedOptimizedCalls++; continue; }
    savingsUsd += e.savingsUsd;
    const b = byOptimization[e.optimization] ||= { calls: 0, savingsUsd: 0 };
    b.calls++;
    b.savingsUsd += e.savingsUsd;
  }
  for (const b of Object.values(byOptimization)) b.savingsUsd = round(b.savingsUsd, 6);
  const feePct = tenant.policy.revenueSharePct;
  const feeUsd = round(Math.max(0, savingsUsd) * feePct / 100, 2);
  const baseFeeUsd = round(tenant.policy.monthlyBaseFeeUsd || 0, 2);
  // AI usage that ran on WasteZero's own provider keys is passed through at cost (+ any markup).
  const usageUsd = usage?.billUsage ? round(wzKeyCostUsd * (1 + (usage.usageMarkupPct || 0) / 100), 2) : 0;
  // Teams: billed only for employees who actually used AI this month.
  const seats = usage?.teamsSeatUsd > 0 ? seatSet.size : 0;
  const seatsUsd = round(seats * (usage?.teamsSeatUsd || 0), 2);
  return {
    tenantId: tenant.id, tenantName: tenant.name, period,
    calls: rows.length, optimizedCalls, unpricedOptimizedCalls,
    actualCostUsd: round(actualCostUsd, 6), baselineCostUsd: round(baselineCostUsd, 6),
    savingsUsd: round(savingsUsd, 6), byOptimization,
    feePct, feeUsd, baseFeeUsd, usageUsd, seats, seatPriceUsd: seats ? usage.teamsSeatUsd : 0, seatsUsd, totalUsd: round(feeUsd + baseFeeUsd + usageUsd + seatsUsd, 2)
  };
}

/**
 * Compare WasteZero's recorded spend with what the provider actually billed.
 * The provider figure may include traffic that never passed through WasteZero, so a
 * gap is flagged for a human rather than "corrected" automatically.
 */
export function reconcile({ invoice, providerBilledUsd, tolerancePct }) {
  const recorded = invoice.actualCostUsd;
  const variancePct = providerBilledUsd > 0 ? Math.abs(providerBilledUsd - recorded) / providerBilledUsd * 100 : (recorded > 0 ? 100 : 0);
  return { providerBilledUsd: round(providerBilledUsd, 6), recordedCostUsd: recorded, variancePct: round(variancePct, 2), withinTolerance: variancePct <= tolerancePct, tolerancePct };
}

/** draft → (reconciled within tolerance) ready | (outside tolerance) needs_review. Payment collection is outside this release. */
export function issueInvoice(computed, reconciliation = null) {
  return {
    id: "inv_" + randomBytes(6).toString("hex"),
    ...computed,
    reconciliation,
    status: !reconciliation ? "draft" : reconciliation.withinTolerance ? "ready" : "needs_review",
    issuedAt: new Date().toISOString()
  };
}

/** Latest invoice record per customer+period (the log is append-only). */
export function latestInvoices(records) {
  const latest = new Map();
  for (const r of records) latest.set(`${r.tenantId}:${r.period}`, r);
  return [...latest.values()];
}

const usd = (n, dp = 2) => "$" + Number(n).toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp });

export function renderInvoiceHtml(inv, { payUrl = "" } = {}) {
  const rows = Object.entries(inv.byOptimization).map(([k, v]) =>
    `<tr><td>${escapeHtml(k === "cache" ? "Reused answers" : k === "route" ? "Cheaper-model routing" : k)}</td><td>${v.calls.toLocaleString()}</td><td>${usd(v.savingsUsd, 4)}</td></tr>`).join("");
  const rec = inv.reconciliation
    ? `Checked against provider bill of ${usd(inv.reconciliation.providerBilledUsd)} (variance ${inv.reconciliation.variancePct}%).`
    : "Not yet checked against the provider bill.";
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>WasteZero invoice ${escapeHtml(inv.period)}</title>
<style>body{font:15px/1.5 system-ui,sans-serif;max-width:720px;margin:40px auto;padding:0 20px;color:#1a1a1a}
table{width:100%;border-collapse:collapse;margin:16px 0}td,th{padding:8px;border-bottom:1px solid #ddd;text-align:left}
th{font-weight:600}.total{font-size:20px;font-weight:700}.muted{color:#666;font-size:13px}.status{display:inline-block;padding:2px 8px;border-radius:4px;background:#eee}</style></head>
<body><h1>WasteZero</h1><p><strong>Invoice</strong> ${escapeHtml(inv.id)} <span class="status">${escapeHtml(inv.status)}</span><br>
Customer: ${escapeHtml(inv.tenantName)}<br>Period: ${escapeHtml(inv.period)}</p>
<table><tr><th>Saving</th><th>Requests</th><th>Saved</th></tr>${rows || '<tr><td colspan="3">No optimised requests this period</td></tr>'}</table>
<p>Without WasteZero: ${usd(inv.baselineCostUsd, 4)} · Actual: ${usd(inv.actualCostUsd, 4)} · <strong>Saved: ${usd(inv.savingsUsd, 4)}</strong></p>
<p>Savings share (${inv.feePct}% of savings): ${usd(inv.feeUsd)}${inv.baseFeeUsd ? `<br>Monthly subscription: ${usd(inv.baseFeeUsd)}` : ""}${inv.usageUsd ? `<br>AI usage on WasteZero's provider keys, at cost: ${usd(inv.usageUsd)}` : ""}${inv.seatsUsd ? `<br>Team budgets: ${inv.seats} active employee(s) × ${usd(inv.seatPriceUsd)}: ${usd(inv.seatsUsd)}` : ""}</p>
<p class="total">Total due: ${usd(inv.totalUsd ?? inv.feeUsd)}</p>${inv.payment?.status === "paid" ? `<p><strong>Paid</strong> ${escapeHtml(inv.payment.paidAt || "")}</p>` : ""}
${payUrl ? `<p><a href="${escapeHtml(payUrl)}">Add or update the card to pay this invoice</a></p>` : ""}
<p class="muted">${escapeHtml(rec)} Savings are measured per request: the cost at the model you requested minus the cost actually incurred. Reused answers cost nothing. ${inv.unpricedOptimizedCalls ? `${inv.unpricedOptimizedCalls} optimised requests had no configured price and are excluded.` : ""}</p>
</body></html>`;
}
