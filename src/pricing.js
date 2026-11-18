// Providers answer with dated snapshot names ("gpt-4o-mini-2024-07-18", "claude-sonnet-4-5-20250929")
// even when the caller asked for the short name. Only accept a date/version suffix so that "gpt-4o"
// prices can never be applied to "gpt-4o-mini".
const SNAPSHOT_SUFFIX = /^-(\d{4}-\d{2}-\d{2}|\d{8}|\d{4})$/;

export function resolveRate(model, rates) {
  if (!model || !rates) return null;
  if (rates[model]) return { key: model, rate: rates[model] };
  for (const key of Object.keys(rates)) {
    if (model.startsWith(key) && SNAPSHOT_SUFFIX.test(model.slice(key.length))) return { key, rate: rates[key] };
  }
  return null;
}

/**
 * Token counts from a provider's usage object, in one common shape:
 *   prompt     : all input tokens, including cached reads and cache writes
 *   cached     : input tokens read from the provider's prompt cache
 *   cacheWrite : input tokens written to the cache (Anthropic charges extra for these)
 *   completion : output tokens
 */
export function tokensFromUsage(usage, format = "openai") {
  const n = (v) => Math.max(0, Number(v) || 0);
  if (format === "anthropic") {
    const cached = n(usage?.cache_read_input_tokens);
    const cacheWrite = n(usage?.cache_creation_input_tokens);
    return { prompt: n(usage?.input_tokens) + cached + cacheWrite, cached, cacheWrite, completion: n(usage?.output_tokens) };
  }
  const prompt = n(usage?.prompt_tokens);
  const cached = Math.min(prompt, n(usage?.prompt_tokens_details?.cached_tokens));
  return { prompt, cached, cacheWrite: 0, completion: n(usage?.completion_tokens) };
}

/**
 * USD cost of the given token counts at `model`'s configured rate, or null when unpriced.
 * `defaults` are the provider's cache multipliers, used when the model's rate doesn't state them.
 */
export function costForTokens(model, { prompt = 0, cached = 0, cacheWrite = 0, completion = 0 }, rates, defaults = {}) {
  const found = resolveRate(model, rates);
  if (!found) return null;
  const { rate } = found;
  const readRate = rate.cachedInput ?? (defaults.cacheRead != null ? rate.input * defaults.cacheRead : rate.input);
  const writeRate = rate.cacheWriteInput ?? (defaults.cacheWrite != null ? rate.input * defaults.cacheWrite : rate.input);
  const plain = Math.max(0, prompt - cached - cacheWrite);
  const cost = (plain * rate.input + cached * readRate + cacheWrite * writeRate + completion * rate.output) / 1_000_000;
  return Number(cost.toFixed(10));
}

export const estimateCost = (model, usage, rates, format = "openai", defaults = {}) =>
  costForTokens(model, tokensFromUsage(usage, format), rates, defaults);
