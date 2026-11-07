export function estimateCost(model, usage, rates) {
  const rate = rates?.[model];
  if (!rate) return null;
  const input = Number(usage?.prompt_tokens || 0);
  const output = Number(usage?.completion_tokens || 0);
  if (![input, output, rate.input, rate.output].every(Number.isFinite)) return null;
  if (input < 0 || output < 0 || rate.input < 0 || rate.output < 0) return null;
  return Number(((input * rate.input + output * rate.output) / 1_000_000).toFixed(10));
}

export function aggregateEvents(events) {
  const byModel = {};
  let calls = 0, inputTokens = 0, outputTokens = 0, estimatedCostUsd = 0;
  let unpricedCalls = 0;
  for (const event of events) {
    calls++;
    inputTokens += event.promptTokens || 0;
    outputTokens += event.completionTokens || 0;
    if (event.estimatedCostUsd == null) unpricedCalls++;
    else estimatedCostUsd += event.estimatedCostUsd;
    const key = event.model || "unknown";
    byModel[key] ||= { calls: 0, inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0, unpricedCalls: 0 };
    const item = byModel[key];
    item.calls++;
    item.inputTokens += event.promptTokens || 0;
    item.outputTokens += event.completionTokens || 0;
    if (event.estimatedCostUsd == null) item.unpricedCalls++;
    else item.estimatedCostUsd += event.estimatedCostUsd;
  }
  return { calls, inputTokens, outputTokens, estimatedCostUsd: Number(estimatedCostUsd.toFixed(8)), unpricedCalls, byModel };
}
