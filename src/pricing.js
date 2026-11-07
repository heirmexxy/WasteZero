// Providers answer with dated snapshot names ("gpt-4o-mini-2024-07-18") even when the
// caller asked for "gpt-4o-mini". Only accept a date/version suffix so that "gpt-4o"
// prices can never be applied to "gpt-4o-mini".
const SNAPSHOT_SUFFIX = /^-(\d{4}-\d{2}-\d{2}|\d{4})$/;

export function resolveRate(model, rates) {
  if (!model || !rates) return null;
  if (rates[model]) return { key: model, rate: rates[model] };
  for (const key of Object.keys(rates)) {
    if (model.startsWith(key) && SNAPSHOT_SUFFIX.test(model.slice(key.length))) return { key, rate: rates[key] };
  }
  return null;
}

/** Token counts from an OpenAI-style usage object. Cached tokens are part of prompt_tokens. */
export function tokensFromUsage(usage) {
  const prompt = Math.max(0, Number(usage?.prompt_tokens) || 0);
  const cached = Math.min(prompt, Math.max(0, Number(usage?.prompt_tokens_details?.cached_tokens) || 0));
  const completion = Math.max(0, Number(usage?.completion_tokens) || 0);
  return { prompt, cached, completion };
}

/** USD cost of the given token counts at `model`'s configured rate, or null when unpriced. */
export function costForTokens(model, { prompt = 0, cached = 0, completion = 0 }, rates) {
  const found = resolveRate(model, rates);
  if (!found) return null;
  const { rate } = found;
  const cachedRate = rate.cachedInput ?? rate.input;
  const cost = ((prompt - cached) * rate.input + cached * cachedRate + completion * rate.output) / 1_000_000;
  return Number(cost.toFixed(10));
}

export const estimateCost = (model, usage, rates) => costForTokens(model, tokensFromUsage(usage), rates);
