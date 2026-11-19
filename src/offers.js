import { resolveRate } from "./pricing.js";

/**
 * One model name, several providers. Open models (Llama, DeepSeek, Qwen...) are sold by many providers
 * at different prices. A customer asks for an alias (e.g. "llama-3.3-70b"); WasteZero sends it to the
 * cheapest provider that is up, and moves on to the next if one fails.
 *
 * MODEL_OFFERS_JSON: { "llama-3.3-70b": [ { "provider": "groq", "model": "llama-3.3-70b-versatile" }, ... ] }
 * The first offer listed is the reference price; savings are measured against it.
 */
export function loadOffers(env, providers) {
  if (!env.MODEL_OFFERS_JSON) return {};
  let offers;
  try { offers = JSON.parse(env.MODEL_OFFERS_JSON); } catch { throw new Error("MODEL_OFFERS_JSON must contain valid JSON"); }
  for (const [alias, list] of Object.entries(offers)) {
    if (!Array.isArray(list) || !list.length) throw new Error(`MODEL_OFFERS_JSON.${alias} must be a non-empty list`);
    for (const o of list) {
      if (!providers[o.provider]) throw new Error(`MODEL_OFFERS_JSON.${alias}: unknown provider "${o.provider}"`);
      if (providers[o.provider].format !== "openai") throw new Error(`MODEL_OFFERS_JSON.${alias}: provider "${o.provider}" must speak the OpenAI format`);
      if (typeof o.model !== "string" || !o.model) throw new Error(`MODEL_OFFERS_JSON.${alias}: each offer needs a model`);
    }
  }
  return offers;
}

/** Provider health: a provider that just failed is tried last for a minute. */
export class ProviderHealth {
  constructor(coolMs = 60_000) { this.until = new Map(); this.coolMs = coolMs; }
  fail(name, now = Date.now()) { this.until.set(name, now + this.coolMs); }
  ok(name) { this.until.delete(name); }
  healthy(name, now = Date.now()) { return (this.until.get(name) || 0) <= now; }
}

const blended = (rate) => rate.input * 0.75 + rate.output * 0.25;   // typical traffic is input-heavy

/** Offers in the order to try them: healthy and cheapest first; only ones we hold a key for. */
export function rankOffers(config, alias, { customerKeys = {}, health, prefer = null }) {
  const list = config.offers[alias] || [];
  const ranked = list.map((o, i) => {
    const provider = config.providers[o.provider];
    const own = customerKeys[o.provider];
    const key = own || provider.serverKey;
    const rate = resolveRate(o.model, config.modelRates)?.rate;
    return { ...o, provider, key, keySource: own ? "customer" : "wastezero", reference: i === 0, price: rate ? blended(rate) : Infinity, healthy: health.healthy(o.provider) };
  }).filter((o) => o.key);
  // Providers holding prepaid credit that would otherwise expire unused come first among healthy offers.
  const pref = (o) => (prefer?.has(o.provider.name) ? 1 : 0);
  return ranked.sort((a, b) => (b.healthy - a.healthy) || (pref(b) - pref(a)) || (a.price - b.price));
}

/** X-Upstream-Keys: {"groq":"gsk_...","together":"..."}: the customer's own keys per provider. */
export function customerKeysFrom(req) {
  try {
    const v = JSON.parse(String(req.headers["x-upstream-keys"] || "{}"));
    return v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).filter(([, k]) => typeof k === "string" && k)) : {};
  } catch { return {}; }
}
