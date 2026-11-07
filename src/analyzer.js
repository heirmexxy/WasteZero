import { costForTokens, resolveRate } from "./pricing.js";
import { median, round } from "./util.js";

export const DEFAULTS = {
  windowDays: 14,
  minDuplicateCalls: 10,
  minDuplicateShare: 0.05,
  minRouteCalls: 50,
  maxMedianOutputTokens: 400,
  minMonthlySavingsUsd: 1
};

const groupKey = (e) => `${e.requestedModel}\u0000${e.tag || ""}`;
const ok = (e) => e.status >= 200 && e.status < 300;

/**
 * Look for waste in one customer's recent traffic.
 * Returns proposals (things WasteZero could fix itself) and findings (for a human).
 */
export function analyze({ events, tenant, config, now = Date.now(), options = {} }) {
  const o = { ...DEFAULTS, ...options };
  const since = new Date(now - o.windowDays * 86400_000).toISOString();
  const recent = events.filter((e) => e.tenantId === tenant.id && e.timestamp >= since && e.requestedModel);
  const days = Math.max(1, Math.min(o.windowDays, (now - Date.parse(recent[0]?.timestamp ?? new Date(now).toISOString())) / 86400_000));
  const monthly = (usd) => round(usd * 30 / days, 4);
  const proposals = [];
  const findings = [];

  const groups = new Map();
  for (const e of recent) {
    const g = groups.get(groupKey(e)) || { model: e.requestedModel, tag: e.tag || null, events: [] };
    g.events.push(e);
    groups.set(groupKey(e), g);
  }

  for (const g of groups.values()) {
    const good = g.events.filter(ok);
    const match = { model: g.model, tag: g.tag };

    // 1. The same request asked again: an answer could be reused.
    const cacheable = good.filter((e) => !e.stream && (e.deterministic || tenant.policy.cacheNondeterministic || (tenant.policy.cacheTags || []).includes(e.tag)) && e.optimization !== "cache");
    const seen = new Set();
    let dupCalls = 0, dupCost = 0;
    for (const e of [...cacheable].sort((a, b) => a.timestamp.localeCompare(b.timestamp))) {
      if (seen.has(e.fingerprint)) { dupCalls++; dupCost += e.actualCostUsd || 0; }
      else seen.add(e.fingerprint);
    }
    if (dupCalls >= o.minDuplicateCalls && dupCalls / Math.max(1, good.length) >= o.minDuplicateShare && monthly(dupCost) >= o.minMonthlySavingsUsd) {
      proposals.push({
        type: "cache", match, target: null, estMonthlySavingsUsd: monthly(dupCost),
        evidence: { windowDays: round(days, 2), calls: good.length, repeatedCalls: dupCalls, repeatedCostUsd: round(dupCost, 6) }
      });
    }

    // 2. An expensive model doing short tasks: a cheaper model may do as well.
    const rateKey = resolveRate(g.model, config.modelRates)?.key;
    const target = rateKey && config.downgradeMap[rateKey];
    if (target && good.length >= o.minRouteCalls) {
      const medianOut = median(good.map((e) => e.completionTokens || 0));
      let current = 0, cheaper = 0;
      for (const e of good) {
        if (e.optimization === "route") continue;
        const tokens = { prompt: e.promptTokens || 0, cached: e.cachedTokens || 0, completion: e.completionTokens || 0 };
        current += costForTokens(g.model, tokens, config.modelRates) ?? 0;
        cheaper += costForTokens(target, tokens, config.modelRates) ?? 0;
      }
      if (medianOut <= o.maxMedianOutputTokens && monthly(current - cheaper) >= o.minMonthlySavingsUsd) {
        proposals.push({
          type: "route", match, target, estMonthlySavingsUsd: monthly(current - cheaper),
          evidence: { windowDays: round(days, 2), calls: good.length, medianOutputTokens: medianOut, currentCostUsd: round(current, 6), atTargetCostUsd: round(cheaper, 6) }
        });
      }
    }

    // 3. Things only a human can sort out.
    if (g.events.some((e) => e.actualCostUsd == null && ok(e))) {
      findings.push({ kind: "unpriced_model", match, detail: `No price configured for ${g.model}; its spend is unknown, not zero.` });
    }
    const errors = g.events.length - good.length;
    if (g.events.length >= 20 && errors / g.events.length > 0.05) {
      findings.push({ kind: "high_error_rate", match, detail: `${errors} of ${g.events.length} requests failed; retries may be wasting spend.` });
    }
  }

  proposals.sort((a, b) => b.estMonthlySavingsUsd - a.estMonthlySavingsUsd);
  return { windowDays: round(days, 2), proposals, findings };
}
