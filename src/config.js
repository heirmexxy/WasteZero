function parseJsonEnv(name, fallback) {
  if (!process.env[name]) return fallback;
  try { return JSON.parse(process.env[name]); }
  catch { throw new Error(`${name} must contain valid JSON`); }
}

export const config = {
  port: Number(process.env.PORT || 8787),
  apiKey: process.env.WASTEZERO_API_KEY || "",
  upstreamKey: process.env.OPENAI_API_KEY || "",
  upstreamBaseUrl: (process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/+$/, ""),
  timeoutMs: Number(process.env.REQUEST_TIMEOUT_MS || 45000),
  maxBodyBytes: Number(process.env.MAX_BODY_BYTES || 1048576),
  dataDir: process.env.DATA_DIR || "./data",
  modelRates: parseJsonEnv("MODEL_RATES_JSON", {})
};

if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) {
  throw new Error("PORT must be a valid TCP port");
}
