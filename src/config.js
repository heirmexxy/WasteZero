import { loadProviders } from "./providers.js";
import { loadOffers } from "./offers.js";

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
    for (const field of ["cachedInput", "cacheWriteInput"]) {
      if (rate[field] !== undefined && (!Number.isFinite(rate[field]) || rate[field] < 0)) {
        throw new Error(`MODEL_RATES_JSON.${model}.${field} must be a non-negative number`);
      }
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
  const { providers, defaultProvider } = loadProviders(env);
  const config = {
    host: env.HOST || "127.0.0.1",
    trustProxy: env.TRUST_PROXY === "true",
    port: number(env, "PORT", 8787, { min: 1, max: 65535 }),
    adminKey: env.WASTEZERO_ADMIN_KEY || "",
    bootstrapTenantKey: env.WASTEZERO_API_KEY || "",
    providers,
    defaultProvider,
    offers: loadOffers(env, providers),
    // WasteZero's own key on the default provider (quality grading, prospecting).
    upstreamKey: providers[defaultProvider].serverKey,
    upstreamBaseUrl: providers[defaultProvider].openaiBaseUrl,
    openaiAdminBaseUrl: (env.OPENAI_ADMIN_BASE_URL || "https://api.openai.com/v1").replace(/\/+$/, ""),
    timeoutMs: number(env, "REQUEST_TIMEOUT_MS", 45000, { min: 1000 }),
    maxBodyBytes: number(env, "MAX_BODY_BYTES", 1048576, { min: 1024 }),
    dataDir: env.DATA_DIR || "./data",
    modelRates,
    downgradeMap: validateDowngrades(json(env, "DOWNGRADE_MAP_JSON", {}), modelRates),
    judgeModel: env.JUDGE_MODEL || "gpt-4o-mini",
    cacheMaxEntries: number(env, "CACHE_MAX_ENTRIES", 5000, { min: 0 }),
    operatorIntervalMs: number(env, "OPERATOR_INTERVAL_MS", 900000, { min: 0 }),
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
  config.operatorName = env.OPERATOR_NAME || "";
  config.contactEmail = env.CONTACT_EMAIL || "";

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
    retryHours: number(env, "BILLING_RETRY_HOURS", 72, { min: 1 }),
    // When customer traffic runs on WasteZero's own provider keys, bill that usage on the invoice.
    billUsage: bool("BILL_USAGE", true),
    usageMarkupPct: number(env, "USAGE_MARKUP_PCT", 0, { min: 0, max: 100, integer: false }),
    // WasteZero for Teams: starting fee per employee who used AI that month. Change it in the admin console (Settings).
    teamsSeatUsd: number(env, "TEAMS_SEAT_PRICE_USD", 5, { min: 0, max: 1000, integer: false })
  };
  if (!["none", "stripe", "paystack"].includes(config.billing.provider)) throw new Error("PAYMENT_PROVIDER must be none, stripe or paystack");
  if (config.billing.provider === "stripe" && !config.billing.stripeSecretKey) throw new Error("STRIPE_SECRET_KEY is required when PAYMENT_PROVIDER=stripe");
  if (config.billing.provider === "paystack" && !config.billing.paystackSecretKey) throw new Error("PAYSTACK_SECRET_KEY is required when PAYMENT_PROVIDER=paystack");

  // AI co-workers.
  config.agents = {
    enabled: bool("AGENTS_ENABLED", true),
    model: env.AGENT_MODEL || config.judgeModel,
    dailyBudgetUsd: number(env, "AGENT_DAILY_BUDGET_USD", 5, { min: 0, max: 10000, integer: false }),
    founderEmail: env.FOUNDER_EMAIL || "",
    adminEmail: (env.ADMIN_EMAIL || env.FOUNDER_EMAIL || "").trim().toLowerCase(),
    briefHourUtc: number(env, "BRIEF_HOUR_UTC", 6, { min: 0, max: 23 }),
    inboxSecret: env.INBOX_SECRET || "",
    inboxAutoReply: bool("INBOX_AUTO_REPLY", false),
    reliabilityIntervalMs: number(env, "RELIABILITY_INTERVAL_MS", 300000, { min: 0 })
  };

  // Telegram alerts with Pause / Resume buttons.
  config.telegram = {
    botToken: env.TELEGRAM_BOT_TOKEN || "",
    botUsername: (env.TELEGRAM_BOT_USERNAME || "").replace(/^@/, ""),
    webhookSecret: env.TELEGRAM_WEBHOOK_SECRET || "",
    adminChatId: env.TELEGRAM_ADMIN_CHAT_ID || "",
    apiBase: (env.TELEGRAM_API_BASE || "https://api.telegram.org").replace(/\/+$/, "")
  };

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
    sources: list("PROSPECT_SOURCES", ["hiring", "yc", "github", "hackernews", "producthunt"]),
    perSourceLimit: number(env, "PROSPECT_PER_SOURCE", 25, { min: 1, max: 500 }),
    hiringQueries: list("PROSPECT_HIRING_QUERIES", ["LLM", "OpenAI", "Anthropic", "GPT", "AI engineer"]),
    ycApiBase: (env.YC_API_BASE || "https://yc-oss.github.io/api").replace(/\/+$/, ""),
    ycTags: list("PROSPECT_YC_TAGS", ["generative-ai", "artificial-intelligence", "ai-assistant", "aiops"]),
    githubApiBase: (env.GITHUB_API_BASE || "https://api.github.com").replace(/\/+$/, ""),
    githubToken: env.GITHUB_TOKEN || "",
    githubTopics: list("PROSPECT_GITHUB_TOPICS", ["llm", "openai", "rag", "ai-agents"]),
    productHuntApiBase: (env.PRODUCTHUNT_API_BASE || "https://api.producthunt.com").replace(/\/+$/, ""),
    productHuntToken: env.PRODUCTHUNT_TOKEN || "",
    productHuntTopic: env.PRODUCTHUNT_TOPIC || "artificial-intelligence",
    hunterApiBase: (env.HUNTER_API_BASE || "https://api.hunter.io").replace(/\/+$/, ""),
    hunterApiKey: env.HUNTER_API_KEY || "",
    model: env.PROSPECT_MODEL || config.judgeModel,
    minFit: number(env, "PROSPECT_MIN_FIT", 7, { min: 0, max: 10 }),
    autoSend: bool("OUTREACH_AUTO_SEND", false),
    dailyCap: number(env, "OUTREACH_DAILY_CAP", 20, { min: 0, max: 1000 }),
    followUpDays: number(env, "OUTREACH_FOLLOWUP_DAYS", 5, { min: 1 }),
    batchSize: number(env, "PROSPECT_BATCH_SIZE", 20, { min: 1, max: 200 }),
    discoverEveryHours: number(env, "PROSPECT_DISCOVER_EVERY_HOURS", 24, { min: 1 })
  };

  for (const [alias, list] of Object.entries(config.offers)) {
    for (const o of list) if (!modelRates[o.model]) throw new Error(`MODEL_OFFERS_JSON.${alias}: add a price for ${o.model} to MODEL_RATES_JSON`);
  }
  if (config.adminKey && config.adminKey.length < 24) throw new Error("WASTEZERO_ADMIN_KEY must be at least 24 characters");
  if (config.adminKey && config.adminKey === config.bootstrapTenantKey) throw new Error("WASTEZERO_ADMIN_KEY must differ from WASTEZERO_API_KEY");
  return config;
}
