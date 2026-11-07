// Observe-only heuristics. These are prompts for human review, not automated actions.
export function recommendations(events) {
  const groups = new Map();
  for (const event of events) {
    const key = event.model || "unknown";
    const item = groups.get(key) || { model: key, calls: 0, tokens: 0, estimatedCostUsd: 0, unpriced: 0 };
    item.calls++;
    item.tokens += (event.promptTokens || 0) + (event.completionTokens || 0);
    if (event.estimatedCostUsd == null) item.unpriced++;
    else item.estimatedCostUsd += event.estimatedCostUsd;
    groups.set(key, item);
  }
  return [...groups.values()].sort((a,b) => b.estimatedCostUsd - a.estimatedCostUsd).map(item => ({
    ...item,
    recommendation: item.unpriced ? "Configure a verified price for this model before comparing spend." :
      item.tokens > 0 ? "Review representative tasks for possible prompt reduction or a lower-cost model; benchmark quality before changing." :
      "Collect more usage before proposing an optimization."
  }));
}
