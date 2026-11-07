import { analyze } from "./analyzer.js";
import { resolveRate } from "./pricing.js";
import { median, round, combineSavings } from "./util.js";

const usd = (n) => round(n, 2);
const ok = (e) => e.status >= 200 && e.status < 300 && !e.blocked;
const BATCHY_TAG = /(batch|nightly|backfill|offline|report|cron|job|digest|eval|summar)/i;

/**
 * Waste in a customer's own proxied traffic, in dollars per month. Each finding is either
 * "measured" (seen request by request) or "estimated" (depends on an assumption stated in the detail).
 */
export function wasteReport({ events, tenant, config, rules, now = Date.now(), windowDays = 30 }) {
  const since = new Date(now - windowDays * 86400_000).toISOString();
  const recent = events.filter((e) => e.tenantId === tenant.id && e.timestamp >= since);
  const good = recent.filter(ok);
  const first = good[0]?.timestamp;
  const days = first ? Math.max(1, Math.min(windowDays, (now - Date.parse(first)) / 86400_000)) : windowDays;
  const monthly = (x) => usd(x * 30 / days);
  const spend = good.reduce((a, e) => a + (e.actualCostUsd || 0), 0);
  const findings = [];
  const p = tenant.policy;

  // 1 and 2. Identical requests: rapid bursts look like loops or retries; the rest could be reused.
  const lastSeen = new Map();
  let loopCost = 0, loopCount = 0, repeatCost = 0, repeatCount = 0, reusableCost = 0;
  for (const e of [...good].filter((e) => e.fingerprint && e.optimization !== "cache").sort((a, b) => a.timestamp.localeCompare(b.timestamp))) {
    const prev = lastSeen.get(e.fingerprint);
    lastSeen.set(e.fingerprint, Date.parse(e.timestamp));
    if (prev == null) continue;
    const c = e.actualCostUsd || 0;
    if (Date.parse(e.timestamp) - prev < 60_000) { loopCost += c; loopCount++; }
    else {
      repeatCost += c; repeatCount++;
      if (!e.stream && (e.deterministic || p.cacheNondeterministic || (p.cacheTags || []).includes(e.tag))) reusableCost += c;
    }
  }
  if (loopCount >= 10) findings.push({
    kind: "loops", confidence: "measured", monthlyUsd: monthly(loopCost),
    title: "Identical requests fired in rapid bursts",
    detail: `${loopCount} requests repeated an identical request within a minute. That is usually an agent loop or a retry storm.`,
    fix: p.loopBreaker.action === "block" ? "Loop breaker is on" : "Turn the loop breaker to block (settings: loopBreaker.action)"
  });
  if (repeatCount >= 5) {
    const cacheLive = rules?.forTenant(tenant.id).some((r) => r.type === "cache" && r.state === "active");
    findings.push({
      kind: "repeats", confidence: "measured", monthlyUsd: monthly(repeatCost),
      title: "The same questions are asked again and again",
      detail: `${repeatCount} requests repeated an earlier one exactly. $${monthly(reusableCost)}/month of that can be reused today; the rest uses temperature above 0, so reuse needs your opt-in per feature (settings: cacheTags).`,
      fix: cacheLive ? "Answer reuse is live" : p.allowedOptimizations.includes("cache") ? "Answer reuse is allowed; the operator will switch it on" : "Allow answer reuse (settings: allowedOptimizations)"
    });
  }

  // 3. Expensive models on short tasks (from the analyser's routing proposals).
  for (const prop of analyze({ events, tenant, config, now }).proposals.filter((x) => x.type === "route")) {
    findings.push({
      kind: "model_mix", confidence: "estimated", monthlyUsd: usd(prop.estMonthlySavingsUsd),
      title: `${prop.match.model}${prop.match.tag ? ` in "${prop.match.tag}"` : ""} is answering short tasks`,
      detail: `Median answer is ${prop.evidence.medianOutputTokens} tokens. This is the saving if every one of these requests moved to ${prop.target}; shadow testing measures how many actually can.`,
      fix: `Route to ${prop.target} after shadow testing`
    });
  }

  // 4. Long prompts that the provider's cache is not catching.
  const byModel = new Map();
  for (const e of good) {
    if ((e.promptTokens || 0) < 1024) continue;
    const key = resolveRate(e.servedModel || e.requestedModel, config.modelRates)?.key;
    if (!key) continue;
    const m = byModel.get(key) || { prompt: 0, cached: 0, n: 0 };
    m.prompt += e.promptTokens; m.cached += e.cachedTokens || 0; m.n++;
    byModel.set(key, m);
  }
  for (const [model, m] of byModel) {
    const rate = config.modelRates[model];
    const cachedRate = rate.cachedInput ?? rate.input;
    const share = m.cached / m.prompt;
    if (m.n < 20 || share >= 0.3 || cachedRate >= rate.input) continue;
    const saving = 0.5 * (m.prompt - m.cached) * (rate.input - cachedRate) / 1_000_000;
    findings.push({
      kind: "prompt_caching", confidence: "estimated", monthlyUsd: monthly(saving),
      title: `Long ${model} prompts are mostly missing the provider's cache`,
      detail: `${m.n} requests with prompts over 1,024 tokens; only ${Math.round(share * 100)}% of those tokens were cached. Put the fixed parts first and the changing parts (user message, dates, IDs) last. Estimate assumes half of the uncached tokens become cacheable.`,
      fix: "Reorder prompts: fixed instructions first"
    });
  }

  // 5. Answers cut off at the length limit: paid for, usually unusable or retried.
  const cut = good.filter((e) => e.finishReason === "length");
  if (cut.length >= 5) findings.push({
    kind: "truncated", confidence: "measured", monthlyUsd: monthly(cut.reduce((a, e) => a + (e.actualCostUsd || 0), 0)),
    title: "Answers cut off at the length limit",
    detail: `${cut.length} answers stopped because they hit max_tokens. They were paid for in full and are usually retried. Raise the limit for these features or ask for shorter answers.`,
    fix: "Adjust max_tokens or the prompt for these features"
  });

  // 6. Features that look like background work: the batch API is half price.
  const batchy = good.filter((e) => e.tag && BATCHY_TAG.test(e.tag) && !e.stream);
  if (batchy.length >= 10) findings.push({
    kind: "batch", confidence: "estimated", monthlyUsd: monthly(batchy.reduce((a, e) => a + (e.actualCostUsd || 0), 0) * 0.5),
    title: "Background work running at full price",
    detail: `Features ${[...new Set(batchy.map((e) => e.tag))].map((t) => `"${t}"`).join(", ")} look like work that can wait. The batch API costs half, with results within 24 hours.`,
    fix: "Send these features through the batch API"
  });

  // 7. Hourly spending spikes.
  const hours = new Map();
  for (const e of good) hours.set(e.timestamp.slice(0, 13), (hours.get(e.timestamp.slice(0, 13)) || 0) + (e.actualCostUsd || 0));
  if (hours.size >= 12) {
    const normal = median([...hours.values()]);
    const spikes = [...hours.entries()].filter(([, v]) => v > 5 * Math.max(normal, 0.01) && v - normal > 1);
    if (spikes.length) findings.push({
      kind: "spikes", confidence: "measured", monthlyUsd: monthly(spikes.reduce((a, [, v]) => a + v - normal, 0)),
      title: `${spikes.length} hour${spikes.length > 1 ? "s" : ""} of runaway spending`,
      detail: `Hours more than 5× normal ($${normal.toFixed(2)}/hour): ${spikes.slice(0, 5).map(([h, v]) => `${h}:00 UTC ($${v.toFixed(2)})`).join(", ")}${spikes.length > 5 ? " and more" : ""}.`,
      fix: p.spikeAlert.action === "pause" ? "Spike pausing is on" : "Set spike alerts to pause, and add a daily budget"
    });
  }

  findings.sort((a, b) => b.monthlyUsd - a.monthlyUsd);
  const saved = good.reduce((a, e) => a + (e.savingsUsd || 0), 0);
  return {
    windowDays: round(days, 1),
    requests: recent.length,
    blockedRequests: recent.filter((e) => e.blocked).length,
    monthlySpendUsd: monthly(spend),
    monthlyWasteUsd: usd(combineSavings(monthly(spend), findings.map((f) => f.monthlyUsd))),   // overlap removed
    savedSoFarUsd: usd(saved),
    findings
  };
}
