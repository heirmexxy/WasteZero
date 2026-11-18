/**
 * Which AI provider a request goes to, and how to talk to it.
 *
 * format "openai"    : speaks OpenAI chat completions (OpenAI, Gemini's OpenAI endpoint, Kimi, DeepSeek, OpenRouter, Groq...)
 * format "anthropic" : speaks Anthropic Messages natively (/v1/messages); also has an OpenAI-compatible endpoint
 *
 * A request's provider is chosen by, in order:
 *   1. the X-WasteZero-Provider header
 *   2. the model name's prefix (claude- → anthropic, kimi- → moonshot, ...)
 *   3. a model name with a slash ("meta-llama/llama-3") → openrouter
 *   4. DEFAULT_PROVIDER
 */
export const BUILT_IN = {
  openai: { format: "openai", baseUrl: "https://api.openai.com/v1", keyEnv: "OPENAI_API_KEY", baseEnv: "OPENAI_BASE_URL",
    match: ["gpt-", "chatgpt-", "o1", "o3", "o4", "ft:gpt", "codex-"] },
  anthropic: { format: "anthropic", baseUrl: "https://api.anthropic.com", keyEnv: "ANTHROPIC_API_KEY", baseEnv: "ANTHROPIC_BASE_URL",
    match: ["claude-"],
    // Anthropic bills cache reads at 0.1x and 5-minute cache writes at 1.25x the input price.
    // Used only when MODEL_RATES_JSON gives no cachedInput / cacheWriteInput for a model.
    pricing: { cacheRead: 0.1, cacheWrite: 1.25 } },
  gemini: { format: "openai", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", keyEnv: "GEMINI_API_KEY", baseEnv: "GEMINI_BASE_URL",
    match: ["gemini-", "gemma-"] },
  moonshot: { format: "openai", baseUrl: "https://api.moonshot.ai/v1", keyEnv: "MOONSHOT_API_KEY", baseEnv: "MOONSHOT_BASE_URL",
    match: ["kimi-", "moonshot-"] },
  deepseek: { format: "openai", baseUrl: "https://api.deepseek.com", keyEnv: "DEEPSEEK_API_KEY", baseEnv: "DEEPSEEK_BASE_URL",
    match: ["deepseek-"] },
  openrouter: { format: "openai", baseUrl: "https://openrouter.ai/api/v1", keyEnv: "OPENROUTER_API_KEY", baseEnv: "OPENROUTER_BASE_URL",
    match: [] }
};

const clean = (u) => String(u).replace(/\/+$/, "");

export function loadProviders(env) {
  let extra = {};
  if (env.PROVIDERS_JSON) {
    try { extra = JSON.parse(env.PROVIDERS_JSON); } catch { throw new Error("PROVIDERS_JSON must contain valid JSON"); }
  }
  const providers = {};
  for (const [name, def] of Object.entries({ ...BUILT_IN, ...extra })) {
    const p = { ...(BUILT_IN[name] || {}), ...def };
    if (!["openai", "anthropic"].includes(p.format)) throw new Error(`Provider ${name}: format must be openai or anthropic`);
    if (!p.baseUrl) throw new Error(`Provider ${name}: baseUrl is required`);
    if (!Array.isArray(p.match || [])) throw new Error(`Provider ${name}: match must be a list of model-name prefixes`);
    const baseUrl = clean((p.baseEnv && env[p.baseEnv]) || p.baseUrl);
    providers[name] = {
      name, format: p.format, baseUrl,
      // Where OpenAI-format calls go (chat completions, model lists, quality tests).
      openaiBaseUrl: p.format === "anthropic" ? `${baseUrl}/v1` : baseUrl,
      serverKey: (p.keyEnv && env[p.keyEnv]) || p.apiKey || "",
      match: (p.match || []).map((m) => String(m).toLowerCase()),
      pricing: p.pricing || {}
    };
  }
  const defaultProvider = env.DEFAULT_PROVIDER || "openai";
  if (!providers[defaultProvider]) throw new Error(`DEFAULT_PROVIDER "${defaultProvider}" is not a configured provider`);
  return { providers, defaultProvider };
}

/** The provider for a request. Returns { provider } or { error } for an unknown provider header. */
export function resolveProvider(config, { model, header }) {
  const { providers, defaultProvider } = config;
  if (header) {
    const p = providers[String(header).toLowerCase()];
    return p ? { provider: p } : { error: `Unknown provider "${header}". Configured: ${Object.keys(providers).join(", ")}` };
  }
  const m = String(model || "").toLowerCase();
  let best = null, bestLen = 0;
  for (const p of Object.values(providers)) {
    for (const prefix of p.match) if (m.startsWith(prefix) && prefix.length > bestLen) { best = p; bestLen = prefix.length; }
  }
  if (best) return { provider: best };
  if (m.includes("/") && providers.openrouter) return { provider: providers.openrouter };
  return { provider: providers[defaultProvider] };
}

/** The key to call the provider with: the customer's own (preferred) or WasteZero's. */
export function providerKey(req, provider) {
  const own = String(req.headers["x-upstream-authorization"] || "").replace(/^Bearer\s+/i, "").trim();
  return { key: own || provider.serverKey, source: own ? "customer" : "wastezero" };
}

/** Request headers for a provider call. */
export function providerHeaders(provider, key, req = null) {
  if (provider.format === "anthropic") {
    const h = { "x-api-key": key, "anthropic-version": req?.headers["anthropic-version"] || "2023-06-01", "content-type": "application/json" };
    if (req?.headers["anthropic-beta"]) h["anthropic-beta"] = req.headers["anthropic-beta"];
    return h;
  }
  return { authorization: `Bearer ${key}`, "content-type": "application/json" };
}

/** OpenAI-format headers even for Anthropic (its OpenAI-compatible endpoint takes a bearer key). */
export const openaiHeaders = (key) => ({ authorization: `Bearer ${key}`, "content-type": "application/json" });
