function number(env, name, fallback, { min = 0, max = Infinity, integer = true } = {}) {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) {
    throw new Error(`${name} must be a ${integer ? "whole " : ""}number between ${min} and ${max} (got "${raw}")`);
  }
  return value;
}

function json(env, name, fallback) {
  if (!env[name]) return fallback;
  try { return JSON.parse(env[name]); }
  catch { throw new Error(`${name} must contain valid JSON`); }
}

function validateRates(rates) {
  if (!rates || typeof rates !== "object" || Array.isArray(rates)) throw new Error("MODEL_RATES_JSON must be an object keyed by model");
  for (const [model, rate] of Object.entries(rates)) {
    for (const field of ["input", "output"]) {
      if (!Number.isFinite(rate?.[field]) || rate[field] < 0) throw new Error(`MODEL_RATES_JSON.${model}.${field} must be a non-negative number`);
    }
    if (rate.cachedInput !== undefined && (!Number.isFinite(rate.cachedInput) || rate.cachedInput < 0)) {
      throw new Error(`MODEL_RATES_JSON.${model}.cachedInput must be a non-negative number`);
    }
  }
  return rates;
}

function validateDowngrades(map, rates) {
  if (!map || typeof map !== "object" || Array.isArray(map)) throw new Error("DOWNGRADE_MAP_JSON must be an object");
  for (const [from, to] of Object.entries(map)) {
    if (typeof to !== "string") throw new Error(`DOWNGRADE_MAP_JSON.${from} must be a model name`);
    if (!rates[from] || !rates[to]) throw new Error(`DOWNGRADE_MAP_JSON ${from} -> ${to}: both models need a price in MODEL_RATES_JSON`);
  }
  return map;
}

export function loadConfig(env = process.env) {
  const modelRates = validateRates(json(env, "MODEL_RATES_JSON", {}));
  const config = {
    host: env.HOST || "127.0.0.1",
    trustProxy: env.TRUST_PROXY === "true",
    port: number(env, "PORT", 8787, { min: 1, max: 65535 }),
    adminKey: env.WASTEZERO_ADMIN_KEY || "",
    bootstrapTenantKey: env.WASTEZERO_API_KEY || "",
    upstreamKey: env.OPENAI_API_KEY || "",
    upstreamBaseUrl: (env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/+$/, ""),
    openaiAdminBaseUrl: (env.OPENAI_ADMIN_BASE_URL || "https://api.openai.com/v1").replace(/\/+$/, ""),
    timeoutMs: number(env, "REQUEST_TIMEOUT_MS", 45000, { min: 1000 }),
    maxBodyBytes: number(env, "MAX_BODY_BYTES", 1048576, { min: 1024 }),
    dataDir: env.DATA_DIR || "./data",
    modelRates,
    downgradeMap: validateDowngrades(json(env, "DOWNGRADE_MAP_JSON", {}), modelRates),
    judgeModel: env.JUDGE_MODEL || "gpt-4o-mini",
    cacheMaxEntries: number(env, "CACHE_MAX_ENTRIES", 5000, { min: 0 }),
    operatorIntervalMs: number(env, "OPERATOR_INTERVAL_MS", 0, { min: 0 }),
    operatorEnabled: env.OPERATOR_ENABLED !== "false",
    escalationWebhookUrl: env.ESCALATION_WEBHOOK_URL || "",
    reconcileTolerancePct: number(env, "RECONCILE_TOLERANCE_PCT", 5, { min: 0, max: 100, integer: false })
  };
  const bool = (name, fallback) => (env[name] === undefined || env[name] === "" ? fallback : env[name] === "true");
  const list = (name, fallback) => (env[name] ? env[name].split(",").map((s) => s.trim()).filter(Boolean) : fallback);

  // Public pages: signup, card setup, unsubscribe, payment webhooks.
  config.publicBaseUrl = (env.PUBLIC_BASE_URL || "").replace(/\/+$/, "");
  config.signupEnabled = bool("SIGNUP_ENABLED", Boolean(config.publicBaseUrl));
  config.signingSecret = env.SIGNING_SECRET || "";

  // Card billing.
  config.billing = {
    provider: env.PAYMENT_PROVIDER || "none",
    stripeSecretKey: env.STRIPE_SECRET_KEY || "",
    stripeWebhookSecret: env.STRIPE_WEBHOOK_SECRET || "",
    stripeApiBase: (env.STRIPE_API_BASE || "https://api.stripe.com").replace(/\/+$/, ""),
    paystackSecretKey: env.PAYSTACK_SECRET_KEY || "",
    paystackApiBase: (env.PAYSTACK_API_BASE || "https://api.paystack.co").replace(/\/+$/, ""),
    currency: (env.BILLING_CURRENCY || "usd").toLowerCase(),
    fxRate: number(env, "BILLING_FX_RATE", 1, { min: 0.000001, integer: false }),   // billing currency per 1 USD
    paystackSetupAmountMinor: number(env, "PAYSTACK_SETUP_AMOUNT_MINOR", 10000, { min: 1 }),
    requireReconciliation: bool("BILLING_REQUIRE_RECONCILIATION", true),
    autoCharge: bool("BILLING_AUTO_CHARGE", true),
    maxAttempts: number(env, "BILLING_MAX_ATTEMPTS", 3, { min: 1, max: 10 }),
    retryHours: number(env, "BILLING_RETRY_HOURS", 72, { min: 1 })
  };
  if (!["none", "stripe", "paystack"].includes(config.billing.provider)) throw new Error("PAYMENT_PROVIDER must be none, stripe or paystack");
  if (config.billing.provider === "stripe" && !config.billing.stripeSecretKey) throw new Error("STRIPE_SECRET_KEY is required when PAYMENT_PROVIDER=stripe");
  if (config.billing.provider === "paystack" && !config.billing.paystackSecretKey) throw new Error("PAYSTACK_SECRET_KEY is required when PAYMENT_PROVIDER=paystack");

  // Email (invoices and outreach).
  config.email = {
    provider: env.EMAIL_PROVIDER || "log",
    resendApiKey: env.RESEND_API_KEY || "",
    resendApiBase: (env.RESEND_API_BASE || "https://api.resend.com").replace(/\/+$/, ""),
    from: env.EMAIL_FROM || "",
    replyTo: env.EMAIL_REPLY_TO || "",
    senderName: env.SENDER_NAME || "WasteZero",
    senderAddress: env.SENDER_ADDRESS || ""     // postal address, required by anti-spam law for outreach
  };
  if (!["log", "resend"].includes(config.email.provider)) throw new Error("EMAIL_PROVIDER must be log or resend");
  if (config.email.provider === "resend" && (!config.email.resendApiKey || !config.email.from)) throw new Error("RESEND_API_KEY and EMAIL_FROM are required when EMAIL_PROVIDER=resend");

  // Finding customers.
  config.prospecting = {
    enabled: bool("PROSPECTING_ENABLED", false),
    queries: list("PROSPECT_QUERIES", ["LLM", "GPT", "AI agent", "OpenAI API"]),
    hnApiBase: (env.HN_API_BASE || "https://hn.algolia.com/api/v1").replace(/\/+$/, ""),
    model: env.PROSPECT_MODEL || config.judgeModel,
    minFit: number(env, "PROSPECT_MIN_FIT", 7, { min: 0, max: 10 }),
    autoSend: bool("OUTREACH_AUTO_SEND", false),
    dailyCap: number(env, "OUTREACH_DAILY_CAP", 20, { min: 0, max: 1000 }),
    followUpDays: number(env, "OUTREACH_FOLLOWUP_DAYS", 5, { min: 1 }),
    batchSize: number(env, "PROSPECT_BATCH_SIZE", 10, { min: 1, max: 200 }),
    discoverEveryHours: number(env, "PROSPECT_DISCOVER_EVERY_HOURS", 24, { min: 1 })
  };

  if (config.adminKey && config.adminKey.length < 24)throw new Error("WASTEZERO_ADMIN_KEY must be at least 24 characters");
  if (config.adminKey && config.adminKey === config.bootstrapTenantKey) throw new Error("WASTEZERO_ADMIN_KEY must differ from WASTEZERO_API_KEY");
  return config;
}
