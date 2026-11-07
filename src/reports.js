import { round } from "./util.js";

const bucket = () => ({ calls: 0, inputTokens: 0, outputTokens: 0, actualCostUsd: 0, baselineCostUsd: 0, savingsUsd: 0, unpricedCalls: 0, errors: 0 });

function addTo(b, e) {
  b.calls++;
  b.inputTokens += e.promptTokens || 0;
  b.outputTokens += e.completionTokens || 0;
  if (!(e.status >= 200 && e.status < 300)) b.errors++;
  if (e.actualCostUsd == null) { b.unpricedCalls++; return; }
  b.actualCostUsd += e.actualCostUsd;
  b.baselineCostUsd += e.baselineCostUsd ?? e.actualCostUsd;
  b.savingsUsd += e.savingsUsd || 0;
}

const finish = (b) => ({ ...b, actualCostUsd: round(b.actualCostUsd), baselineCostUsd: round(b.baselineCostUsd), savingsUsd: round(b.savingsUsd) });

/** Spend, what it would have cost without WasteZero, and savings, by model, tag and optimisation. */
export function summarize(events) {
  const total = bucket();
  const byModel = {}, byTag = {}, byOptimization = {};
  for (const e of events) {
    addTo(total, e);
    addTo(byModel[e.requestedModel || e.model || "unknown"] ||= bucket(), e);
    addTo(byTag[e.tag || "(untagged)"] ||= bucket(), e);
    if (e.optimization) addTo(byOptimization[e.optimization] ||= bucket(), e);
  }
  const map = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, finish(v)]));
  return { ...finish(total), byModel: map(byModel), byTag: map(byTag), byOptimization: map(byOptimization) };
}

export function inWindow(events, { from, to, tenantId } = {}) {
  return events.filter((e) => (!tenantId || e.tenantId === tenantId) &&
    (!from || e.timestamp >= from) && (!to || e.timestamp < to));
}
