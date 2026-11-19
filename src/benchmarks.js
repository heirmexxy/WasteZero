import { roiReport } from "./roi.js";

/**
 * Cross-company benchmarks. Each month, for every company that shares (policy.shareBenchmarks,
 * on by default, off on request), a few totals are compared, never prompts or names:
 *   AI spend per active employee, share of spend on top-tier models, share of input served from
 *   cache, savings rate, cost per request, and $ per merged pull request (with the ROI ledger).
 * A benchmark is shown only when at least 5 companies contribute, so no single company can be
 * picked out. WasteZero's own internal account never counts.
 */

export const MIN_COMPANIES = 5;
export const TOP_TIER = /opus|(^|[^\w])o1($|[^\w-])|(^|[^\w])o3($|[^\w-])(?!mini)|gpt-5(?!.*(mini|nano))|gemini-[\d.]+-pro|gpt-4\.5/i;
const round = (n, d = 2) => Math.round(n * 10 ** d) / 10 ** d;

export function companyMetrics(tenant, events, period) {
  let spend = 0, top = 0, prompt = 0, cached = 0, baseline = 0, saved = 0, requests = 0;
  const people = new Set();
  for (const e of events) {
    if (e.tenantId !== tenant.id || !String(e.timestamp).startsWith(period) || !(e.status >= 200 && e.status < 300)) continue;
    const c = e.actualCostUsd || 0;
    spend += c; requests++;
    if (TOP_TIER.test(String(e.servedModel || e.requestedModel || ""))) top += c;
    prompt += e.promptTokens || 0; cached += e.cachedTokens || 0;
    baseline += e.baselineCostUsd || 0; saved += e.savingsUsd || 0;
    if (e.personId && c > 0) people.add(e.personId);
  }
  if (spend < 10 || requests < 50) return null;       // too small to compare fairly
  const roi = tenant.org?.integrations?.github ? roiReport(tenant, events, period).company : null;
  return {
    spendPerEmployeeUsd: people.size >= 3 ? spend / people.size : null,
    topTierSharePct: spend ? top / spend * 100 : null,
    cachedInputPct: prompt ? cached / prompt * 100 : null,
    savingsRatePct: baseline ? saved / baseline * 100 : null,
    costPerRequestUsd: spend / requests,
    usdPerPr: roi?.prs >= 5 ? roi.usdPerPr : null
  };
}

const quantile = (sorted, q) => { const i = (sorted.length - 1) * q, lo = Math.floor(i), hi = Math.ceil(i); return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo); };

export const METRICS = {
  spendPerEmployeeUsd: { label: "AI spend per active employee", unit: "usd", better: "lower" },
  topTierSharePct: { label: "Spend on top-tier models", unit: "pct", better: "lower" },
  cachedInputPct: { label: "Input served from cache", unit: "pct", better: "higher" },
  savingsRatePct: { label: "Savings rate", unit: "pct", better: "higher" },
  costPerRequestUsd: { label: "Cost per request", unit: "usd4", better: "lower" },
  usdPerPr: { label: "AI cost per merged pull request", unit: "usd", better: "lower" }
};

/** Benchmarks for one company: its value against the median and middle half of its peers. */
export function benchmarks(ctx, tenant, events, period = new Date().toISOString().slice(0, 7)) {
  const all = ctx.tenants.listCustomers().filter((t) => t.policy?.shareBenchmarks !== false);
  const values = {};
  for (const t of all) {
    const m = companyMetrics(t, events, period);
    if (!m) continue;
    for (const [k, v] of Object.entries(m)) if (v != null && Number.isFinite(v)) (values[k] ||= []).push(v);
  }
  const mine = companyMetrics(tenant, events, period);
  const rows = [], insights = [];
  for (const [k, meta] of Object.entries(METRICS)) {
    const list = (values[k] || []).sort((a, b) => a - b);
    const you = mine?.[k] ?? null;
    if (list.length < MIN_COMPANIES) { rows.push({ metric: k, ...meta, companies: list.length, you: you != null ? round(you, 4) : null, enough: false }); continue; }
    const median = quantile(list, 0.5);
    const row = { metric: k, ...meta, companies: list.length, enough: true, you: you != null ? round(you, 4) : null, median: round(median, 4), p25: round(quantile(list, 0.25), 4), p75: round(quantile(list, 0.75), 4) };
    if (you != null && median > 0) {
      row.ratio = round(you / median, 2);
      const worse = meta.better === "lower" ? you > median * 1.3 : you < median * 0.7;
      const better = meta.better === "lower" ? you < median * 0.8 : you > median * 1.2;
      row.verdict = worse ? "worse" : better ? "better" : "typical";
      if (worse) insights.push(insight(k, meta, you, median));
    }
    rows.push(row);
  }
  return { period, minCompanies: MIN_COMPANIES, sharing: tenant.policy.shareBenchmarks !== false, contributing: Object.values(values).reduce((a, v) => Math.max(a, v.length), 0), rows, insights };
}

function insight(k, meta, you, median) {
  const x = round(you / median, 1);
  const tips = {
    spendPerEmployeeUsd: "Look at the heaviest users and the models they use; budgets with a cheaper-model fallback usually close most of the gap.",
    topTierSharePct: "Most of this is usually simple work (edits, summaries) on premium models. Approve the cheaper-model routes WasteZero has tested.",
    cachedInputPct: "Reuse of long prompts is low: turn on prompt caching for repeated system prompts and documents.",
    savingsRatePct: "Approve the optimizations waiting in Approvals to catch up.",
    costPerRequestUsd: "Requests are large or use expensive models. Check context size and model choice in the waste report.",
    usdPerPr: "Each merged pull request costs more AI than at peers. Check for agents stuck in loops and premium models on routine changes."
  };
  const cmp = meta.better === "lower" ? `${x}x the median` : `${round(median / you, 1)}x below the median`;
  return `${meta.label}: you're at ${cmp} of peer companies. ${tips[k]}`;
}
