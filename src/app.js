import http from "node:http";
import path from "node:path";
import { timingSafeEqual } from "node:crypto";
import { writeFile, rm } from "node:fs/promises";
import { Tenants } from "./tenants.js";
import { Rules } from "./rules.js";
import { JsonlLog } from "./store.js";
import { ResponseCache } from "./cache.js";
import { plan } from "./optimizer.js";
import { estimateCost, tokensFromUsage, costForTokens } from "./pricing.js";
import { runEvaluation, EvalBudget } from "./evaluator.js";
import { summarize, inWindow, statementCsv } from "./reports.js";
import { analyze } from "./analyzer.js";
import { computeInvoice, reconcile, issueInvoice, latestInvoices, renderInvoiceHtml } from "./billing.js";
import { runOperator, note, killSwitchPath, isHalted } from "./operator.js";
import { fingerprint, sanitizeTag, isDeterministic, httpError, isPeriod } from "./util.js";
import { createMailer } from "./email.js";
import { createPayments } from "./payments.js";
import { collect, cardSetupUrl } from "./collections.js";
import { Prospects, runProspecting, importDomains, draftEmail } from "./prospecting.js";
import { handlePublic, PUBLIC_PATHS } from "./public.js";
import { SpendMeter, LoopDetector, checkRequest, meterAndCheck } from "./guard.js";
import { teamsGate, storedProviderKeys } from "./teams.js";
import { shieldRequest } from "./shield.js";
import { Breaker } from "./breaker.js";
import { Settings, billingFor } from "./settings.js";
import { TEAMS_PATHS, handleTeamsPages } from "./teams-http.js";
import { ACCOUNT_PATHS, handleAccounts, isAdminSession, fromDashboard } from "./accounts.js";
import { handleApp } from "./dashboard.js";
import { handleConsole, adminOverview } from "./console.js";
import { PAGE_PATHS, handlePages } from "./pages.js";
import { handleTelegram, setupTelegramWebhook } from "./telegram.js";
import { ProviderHealth, rankOffers, customerKeysFrom } from "./offers.js";
import { Company, runAgents, receiveInbound, approveTask, teamStatus, writeBrief, reliability } from "./agents.js";
import { handleContact, CONTACT_PATHS } from "./contact.js";
import { setPublicBase } from "./ui.js";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const BRAND_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "brand");
const BRAND_TYPES = { ".svg": "image/svg+xml", ".png": "image/png", ".md": "text/markdown; charset=utf-8" };
import { CUSTOMER_EDITABLE, DEFAULT_POLICY } from "./tenants.js";
import { wasteReport } from "./waste.js";
import { handleSite, SITE_PATHS } from "./site.js";
import { sha256 } from "./util.js";
import { resolveProvider, providerKey, providerHeaders, openaiHeaders } from "./providers.js";
import { PrefixTracker, addCacheBreakpoints, toOpenAIShape, finishReasonOf, anthropicErrorBody } from "./anthropic.js";

export const VERSION = "0.7.0";

// Provider headers worth passing back: request IDs for support, rate-limit headers for client back-off.
const PASSTHROUGH = /^(x-request-id|request-id|openai-|x-ratelimit-|anthropic-ratelimit-|retry-after)/i;

function send(res, status, body, headers = {}) {
  if (res.headersSent || res.destroyed) return;
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers });
  res.end(JSON.stringify(body));
}
/** OpenAI-shaped error, so SDKs show the message. */
function oaiError(res, status, code, message, headers = {}) {
  send(res, status, { error: { message, type: status === 429 ? "rate_limit_error" : "invalid_request_error", code } }, headers);
}
function sendHtml(res, html) {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  res.end(html);
}

function readJson(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0, settled = false;
    const fail = (e) => { if (!settled) { settled = true; reject(e); } };
    req.on("data", (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > maxBytes) fail(httpError(413, "Request body too large"));
      else chunks.push(chunk);
    });
    req.on("end", () => {
      if (settled) return;
      settled = true;
      const text = Buffer.concat(chunks).toString("utf8");
      try { resolve(text ? JSON.parse(text) : {}); }
      catch { reject(httpError(400, "Body must be valid JSON")); }
    });
    req.on("error", fail);
  });
}

function bearer(req) {
  const header = req.headers.authorization || "";
  return header.startsWith("Bearer ") ? header.slice(7).trim() : "";
}
/** Customer key: OpenAI-style SDKs send Authorization: Bearer, the Anthropic SDK sends x-api-key. */
const customerApiKey = (req) => bearer(req) || String(req.headers["x-api-key"] || "").trim();
function safeEqual(a, b) {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
function passthroughHeaders(headers) {
  const out = {};
  headers.forEach((value, key) => { if (PASSTHROUGH.test(key)) out[key] = value; });
  return out;
}

export async function createApp(config, { fetch: fetchImpl = globalThis.fetch, logger = console, random = Math.random, lookup = null } = {}) {
  const file = (name) => path.join(config.dataDir, name);
  setPublicBase(config.publicBaseUrl);
  const ctx = {
    config, fetch: fetchImpl, log: logger, random, lookup,
    tenants: new Tenants(file("tenants.json"), { bootstrapKey: config.bootstrapTenantKey }),
    rules: new Rules(file("rules.json")),
    events: new JsonlLog(file("events.jsonl")),
    evals: new JsonlLog(file("evals.jsonl")),
    audit: new JsonlLog(file("audit.jsonl")),
    invoices: new JsonlLog(file("invoices.jsonl")),
    outbox: new JsonlLog(file("outbox.jsonl")),
    prospects: new Prospects(file("prospects.json")),
    audits: new JsonlLog(file("audits.jsonl")),
    inbox: new JsonlLog(file("inbox.jsonl")),
    company: new Company(config.dataDir),
    budget: new EvalBudget(),
    meter: new SpendMeter(),
    loops: new LoopDetector(),
    cache: new ResponseCache({ maxEntries: config.cacheMaxEntries }),
    prefixes: new PrefixTracker(),
    health: new ProviderHealth(),
    breaker: new Breaker()
  };
  ctx.settings = new Settings(file("settings.json"), config);
  await ctx.tenants.init();
  await ctx.rules.init();
  await ctx.prospects.init();
  await ctx.company.init();
  await ctx.settings.init();
  // WasteZero's own account: its agents and grader call AI through WasteZero itself.
  const perAgent = Object.fromEntries(["agent-chief_of_staff", "agent-inbox", "agent-prospector", "agent-onboarding"].map((t) => [t, Math.max(0.5, config.agents.dailyBudgetUsd / 4)]));
  ctx.internalKey = (await ctx.tenants.ensureInternal({ dailyBudgetUsd: config.agents.dailyBudgetUsd, perAgentDailyUsd: perAgent })).apiKey;
  ctx.mailer = createMailer(ctx);
  ctx.payments = createPayments(ctx);
  ctx.budget.load(await ctx.evals.all());
  ctx.meter.load(await ctx.events.all());

  /**
   * Non-streaming OpenAI-format call with WasteZero's own key, to whichever provider serves the model.
   * Used for quality testing and grading.
   */
  ctx.callModel = async (body, { tag = "grader", purpose = "eval" } = {}) => {
    // Dogfooding: WasteZero's own AI calls go through WasteZero, on its internal account.
    if (ctx.selfUrl && ctx.internalKey) {
      try {
        const r = await ctx.fetch(`${ctx.selfUrl}/v1/chat/completions`, {
          method: "POST",
          headers: { authorization: `Bearer ${ctx.internalKey}`, "content-type": "application/json", "x-wastezero-tag": tag, "x-wastezero-purpose": purpose },
          body: JSON.stringify({ ...body, stream: false }), signal: AbortSignal.timeout(config.timeoutMs + 5000)
        });
        const data = await r.json().catch(() => null);
        if (r.status !== 502 && r.status !== 503) return { ok: r.ok && !!data, status: r.status, data };
      } catch { /* fall through to a direct call */ }
    }
    const { provider } = resolveProvider(config, { model: body.model });
    if (!provider?.serverKey) return { ok: false, status: 0 };
    try {
      const r = await ctx.fetch(`${provider.openaiBaseUrl}/chat/completions`, {
        method: "POST",
        headers: openaiHeaders(provider.serverKey),
        body: JSON.stringify(body), signal: AbortSignal.timeout(config.timeoutMs)
      });
      const data = await r.json().catch(() => null);
      return { ok: r.ok && !!data, status: r.status, data };
    } catch { return { ok: false, status: 0 }; }
  };

  const server = http.createServer((req, res) => {
    handle(ctx, req, res).catch((error) => {
      ctx.log.error("request failed:", error);
      if (!res.headersSent) send(res, error.status || 500, { error: error.status ? error.message : "Internal error" });
      else res.destroy();
    });
  });
  return { server, ctx, runOperator: (opts) => runOperator(ctx, opts), setupTelegram: () => setupTelegramWebhook(ctx),
    runReliability: () => reliability(ctx), runAgents: (opts = {}) => runAgents(ctx, { agents: {}, escalations: [] }, opts) };
}

async function handle(ctx, req, res) {
  const url = new URL(req.url, "http://localhost");
  const p = url.pathname;

  if (req.method === "GET" && p === "/health") return send(res, 200, { ok: true, service: "wastezero", version: VERSION });
  if (req.method === "GET" && (p.startsWith("/brand/") || p === "/favicon.ico")) {
    const name = p === "/favicon.ico" ? "favicon.svg" : path.basename(p);
    const type = BRAND_TYPES[path.extname(name)];
    if (!type) return send(res, 404, { error: "Not found" });
    try {
      const data = await readFile(path.join(BRAND_DIR, name));
      res.writeHead(200, { "content-type": type, "cache-control": "public, max-age=86400" });
      return res.end(data);
    } catch { return send(res, 404, { error: "Not found" }); }
  }
  if (PAGE_PATHS.has(p) && handlePages(ctx.config, req, res, url)) return;
  if (p === "/webhooks/telegram" && req.method === "POST") return handleTelegram(ctx, req, res);
  if (CONTACT_PATHS.has(p)) {
    const handled = await handleContact(ctx, req, res, url);
    if (handled !== null || res.headersSent) return;
  }
  if (TEAMS_PATHS.has(p)) {
    const handled = await handleTeamsPages(ctx, req, res, url);
    if (handled !== null || res.headersSent) return;
  }
  if (ACCOUNT_PATHS.has(p)) {
    const handled = await handleAccounts(ctx, req, res, url);
    if (handled !== null || res.headersSent) return;
  }
  if (p === "/app" || p.startsWith("/app/")) {
    const handled = await handleApp(ctx, req, res, url);
    if (handled !== null || res.headersSent) return;
  }
  if (p === "/console" || p === "/console/") return handleConsole(ctx, req, res, url);
  if (SITE_PATHS.has(p) || p.startsWith("/audit/")) {
    const handled = await handleSite(ctx, req, res, url);
    if (handled !== null || res.headersSent) return;
  }
  if (PUBLIC_PATHS.has(p)) {
    const handled = await handlePublic(ctx, req, res, url);
    if (handled !== null || res.headersSent) return;
  }

  if (p.startsWith("/admin/")) {
    // The admin API takes the admin key, or the admin console's sign-in cookie (changes need the console header).
    const keyOk = ctx.config.adminKey && safeEqual(bearer(req), ctx.config.adminKey);
    const consoleOk = isAdminSession(ctx, req) && (req.method === "GET" || fromDashboard(req));
    if (!keyOk && !consoleOk) return send(res, 401, { error: "Unauthorized" });
    return handleAdmin(ctx, req, res, url);
  }

  const found = ctx.tenants.lookup(customerApiKey(req));
  const tenant = found?.tenant || null;
  if (found?.key?.personId) req.wzPersonId = found.key.personId;
  if (found?.key?.id) req.wzKeyId = found.key.id;
  // WasteZero for Teams: a company's stored provider keys, so employees' tools need only their WasteZero key.
  if (tenant?.org?.providerKeys && Object.keys(tenant.org.providerKeys).length) req.wzStoredKeys = storedProviderKeys(ctx.config, tenant);
  if (!tenant) {
    if (p === "/v1/messages") return send(res, 401, anthropicErrorBody(401, "Missing or unknown WasteZero API key"));
    return oaiError(res, 401, "invalid_api_key", "Missing or unknown WasteZero API key");
  }
  if (req.method === "POST" && p === "/v1/messages") return handleMessages(ctx, req, res, tenant);

  if (req.method === "POST" && p === "/v1/chat/completions") return handleChat(ctx, req, res, tenant);
  if (req.method === "GET" && (p === "/v1/models" || p.startsWith("/v1/models/"))) return passThroughGet(ctx, req, res, p.slice(3));
  if (p.startsWith("/v1/wastezero/")) return handleCustomer(ctx, req, res, url, tenant);
  return oaiError(res, 404, "unsupported_endpoint", `WasteZero does not support ${req.method} ${p} yet. Supported: POST /v1/chat/completions, GET /v1/models.`);
}

/** Read-only provider endpoints that SDKs and tools call on start-up (model lists). */
async function passThroughGet(ctx, req, res, providerPath) {
  const { provider, error } = resolveProvider(ctx.config, { header: req.headers["x-wastezero-provider"] });
  if (error) return oaiError(res, 400, "unknown_provider", error);
  const { key } = providerKey(req, provider);
  if (!key) return oaiError(res, 503, "no_provider_key", `No ${provider.name} key: send X-Upstream-Authorization with your ${provider.name} key`);
  try {
    const r = await ctx.fetch(`${provider.openaiBaseUrl}${providerPath}`, { headers: openaiHeaders(key), signal: AbortSignal.timeout(ctx.config.timeoutMs) });
    const text = await r.text();
    res.writeHead(r.status, { "content-type": r.headers.get("content-type") || "application/json", ...passthroughHeaders(r.headers) });
    res.end(text);
  } catch {
    oaiError(res, 502, "upstream_failed", "Upstream request failed");
  }
}

// ---------------------------------------------------------------- customer self-service

function customerSettings(ctx, tenant) {
  const spend = ctx.meter.today(tenant.id);
  return {
    settings: Object.fromEntries(CUSTOMER_EDITABLE.map((k) => [k, tenant.policy[k]])),
    paused: tenant.paused || null,
    spend: { todayUsd: Number(spend.dayUsd.toFixed(6)), thisMonthUsd: Number(spend.monthUsd.toFixed(6)) }
  };
}

async function handleCustomer(ctx, req, res, url, tenant) {
  const p = url.pathname, m = req.method;
  if (m === "GET" && p === "/v1/wastezero/summary") return send(res, 200, await customerSummary(ctx, tenant));
  if (m === "GET" && p === "/v1/wastezero/settings") return send(res, 200, customerSettings(ctx, tenant));
  if (m === "PATCH" && p === "/v1/wastezero/settings") {
    const b = await readJson(req, 65536);
    const changes = Object.fromEntries(Object.entries(b).filter(([k]) => CUSTOMER_EDITABLE.includes(k)));
    const refused = Object.keys(b).filter((k) => !CUSTOMER_EDITABLE.includes(k));
    if (refused.length) return oaiError(res, 400, "not_editable", `These settings can't be changed here: ${refused.join(", ")}`);
    try { await ctx.tenants.update(tenant.id, { policy: changes }); }
    catch (error) { return oaiError(res, 400, "invalid_setting", error.message); }
    if (!ctx.tenants.get(tenant.id).policy.allowedOptimizations.includes("cache")) ctx.cache.clearTenant(tenant.id);
    await note(ctx, { actor: "customer", level: "info", tenantId: tenant.id, action: "settings_updated", message: `${tenant.name} changed: ${Object.keys(changes).join(", ")}` });
    return send(res, 200, customerSettings(ctx, ctx.tenants.get(tenant.id)));
  }
  if (m === "POST" && p === "/v1/wastezero/resume") {
    await ctx.tenants.setPaused(tenant.id, null);
    await note(ctx, { actor: "customer", level: "info", tenantId: tenant.id, action: "resumed", message: `${tenant.name} resumed traffic` });
    return send(res, 200, customerSettings(ctx, ctx.tenants.get(tenant.id)));
  }
  if (m === "GET" && p === "/v1/wastezero/waste-report") {
    return send(res, 200, wasteReport({ events: await ctx.events.all(), tenant, config: ctx.config, rules: ctx.rules }));
  }
  if (m === "GET" && p === "/v1/wastezero/statement") {
    const period = url.searchParams.get("period") || new Date().toISOString().slice(0, 7);
    if (!isPeriod(period)) return oaiError(res, 400, "invalid_period", "period must be YYYY-MM");
    return sendCsv(res, `wastezero-${period}.csv`, statementCsv(await ctx.events.all(), tenant.id, period));
  }
  return oaiError(res, 404, "not_found", "Not found");
}

function sendCsv(res, filename, csv) {
  res.writeHead(200, { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="${filename}"`, "cache-control": "no-store" });
  res.end(csv);
}

// ---------------------------------------------------------------- proxy

async function record(ctx, event, { metered = false } = {}) {
  // Count the spend synchronously, so budgets see it before the next request is handled.
  if (!metered) {
    try { meterAndCheck(ctx, event); } catch (error) { ctx.log.error("spend check failed:", error.message); }
  }
  try { await ctx.events.add(event); }
  catch (error) { ctx.log.error("could not record usage event:", error.message); }
}

/**
 * Cost of a request, what it would have cost without WasteZero, and the saving.
 * Routed: baseline prices the same tokens at the model the customer asked for.
 * Prompt caching added by WasteZero: baseline prices every input token at the full rate.
 */
function costs(ctx, base, servedModel, usage, routed, ok, { format = "openai", provider = null, promptCached = false } = {}) {
  const rates = ctx.config.modelRates;
  const defaults = provider?.pricing || {};
  const t = tokensFromUsage(usage, format);
  const actual = costForTokens(servedModel, t, rates, defaults);
  const changed = routed || promptCached;
  const baselineTokens = promptCached ? { ...t, cached: 0, cacheWrite: 0 } : t;
  const baseline = changed ? costForTokens(routed ? base.requestedModel : servedModel, baselineTokens, rates, defaults) : actual;
  return {
    promptTokens: t.prompt, cachedTokens: t.cached, cacheWriteTokens: t.cacheWrite, completionTokens: t.completion,
    totalTokens: Number(usage?.total_tokens) || t.prompt + t.completion,
    actualCostUsd: actual, baselineCostUsd: baseline,
    savingsUsd: changed && ok ? (actual != null && baseline != null ? Number((baseline - actual).toFixed(10)) : null) : 0
  };
}

/**
 * WasteZero's own quality grader and test calls must run on exactly the model asked for:
 * a cheaper grader would make the quality tests unreliable. Everything else of its own is optimised.
 */
function protectGrader(tenant, req, decision) {
  if (tenant.internal && req.headers["x-wastezero-purpose"] === "eval") {
    decision.routeRule = null;
    decision.effectiveModel = decision.requestedModel;
    decision.evaluation = null;
  }
  return decision;
}

/** Routing only within the same provider: the customer's key and request format belong to it. */
function keepRoutingOnProvider(ctx, decision, provider, req) {
  const header = req.headers["x-wastezero-provider"];
  const sameProvider = (model) => resolveProvider(ctx.config, { model, header }).provider === provider;
  if (decision.routeRule && !sameProvider(decision.routeRule.target)) {
    decision.routeRule = null;
    decision.effectiveModel = decision.requestedModel;
  }
  if (decision.evaluation && !sameProvider(decision.evaluation.rule.target)) decision.evaluation = null;
  return decision;
}

async function handleChat(ctx, req, res, tenant) {
  const { config } = ctx;
  const receivedAt = Date.now();
  let body;
  try { body = await readJson(req, config.maxBodyBytes); }
  catch (error) {
    if (error.status === 413) { oaiError(res, 413, "request_too_large", error.message, { connection: "close" }); req.resume(); return; }
    return oaiError(res, error.status || 400, "invalid_json", error.message);
  }
  if (!body || typeof body !== "object" || Array.isArray(body) || typeof body.model !== "string" || !Array.isArray(body.messages)) {
    return oaiError(res, 400, "invalid_request", "Expected a chat-completions JSON body with model and messages");
  }
  const teamBlock = teamsGate(ctx, tenant, req, body);
  if (teamBlock) return oaiError(res, teamBlock.status, teamBlock.code, teamBlock.message);
  const shield = shieldRequest(ctx, tenant, req, body);
  if (shield) return oaiError(res, shield.status, shield.code, shield.message);

  if (config.offers[body.model]) return handleOffer(ctx, req, res, tenant, body, receivedAt);

  const { provider, error: providerError } = resolveProvider(config, { model: body.model, header: req.headers["x-wastezero-provider"] });
  if (providerError) return oaiError(res, 400, "unknown_provider", providerError);
  // Bring-your-own-key: the customer's provider key, so the provider bills them directly.
  const { key: upstreamKey, source: keySource } = providerKey(req, provider);
  if (!upstreamKey) return oaiError(res, 503, "no_provider_key", `No ${provider.name} key: send X-Upstream-Authorization with your ${provider.name} key`);

  const tag = sanitizeTag(req.headers["x-wastezero-tag"]);
  // End users are stored as a short one-way hash, never the raw ID.
  const rawUser = req.headers["x-wastezero-user"] || (typeof body.user === "string" ? body.user : "");
  const endUser = rawUser ? sha256(`${tenant.id}:${rawUser}`).slice(0, 16) : null;
  const fp = fingerprint(body);
  const base = {
    timestamp: new Date().toISOString(), tenantId: tenant.id, provider: provider.name, format: "openai", tag, endUser, requestedModel: body.model,
    endUserLabel: tenant.policy.storeEndUserIds && rawUser ? String(rawUser).slice(0, 64) : null, plan: sanitizeTag(req.headers["x-wastezero-plan"]),
    ...(req.wzTeam || {}), fingerprint: fp, deterministic: isDeterministic(body), stream: body.stream === true,
    maxTokens: Number(body.max_completion_tokens ?? body.max_tokens) || null
  };

  // Runaway-spend protection runs before anything is sent to the provider.
  const block = checkRequest(ctx, tenant, { tag, endUser, fp });
  if (block) {
    oaiError(res, block.status, block.code, block.message);
    await record(ctx, { ...base, servedModel: null, promptTokens: 0, cachedTokens: 0, completionTokens: 0, totalTokens: 0,
      actualCostUsd: 0, baselineCostUsd: 0, savingsUsd: 0, optimization: null, blocked: block.code, status: block.status, latencyMs: Date.now() - receivedAt });
    return;
  }
  const decision = protectGrader(tenant, req, keepRoutingOnProvider(ctx, plan({ tenant, body, tag, rules: ctx.rules, evalBudgetLeftUsd: ctx.budget.left(tenant), random: ctx.random }), provider, req));

  // Reuse a stored answer to an identical request.
  if (decision.cacheRule) {
    const hit = ctx.cache.get(tenant.id, fp);
    if (hit) {
      send(res, 200, hit.data, { "x-wastezero-cache": "hit" });
      const baseline = estimateCost(body.model, hit.data.usage, config.modelRates, "openai", provider.pricing);
      const t = tokensFromUsage(hit.data.usage);
      await record(ctx, { ...base, servedModel: hit.data.model, promptTokens: t.prompt, cachedTokens: t.cached, completionTokens: t.completion,
        totalTokens: t.prompt + t.completion, actualCostUsd: 0, baselineCostUsd: baseline, savingsUsd: baseline,
        optimization: "cache", ruleId: decision.cacheRule.id, status: 200, latencyMs: 0, keySource });
      return;
    }
  }

  const forwarded = { ...body, model: decision.effectiveModel };
  const meta = { ...base, optimization: decision.routeRule ? "route" : null, ruleId: decision.routeRule?.id ?? null, keySource };
  const extraHeaders = decision.routeRule ? { "x-wastezero-routed-from": body.model } : {};
  if (body.stream === true) return streamChat(ctx, req, res, { forwarded, body, meta, decision, upstreamKey, extraHeaders, receivedAt, provider });

  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  res.on("close", () => { if (!res.writableFinished) controller.abort(); });
  let upstream, raw;
  try {
    upstream = await ctx.fetch(`${provider.openaiBaseUrl}/chat/completions`, {
      method: "POST",
      headers: openaiHeaders(upstreamKey),
      body: JSON.stringify(forwarded), signal: controller.signal
    });
    raw = await upstream.text();
  } catch (error) {
    const status = error.name === "AbortError" ? 504 : 502;
    send(res, status, { error: status === 504 ? "Upstream request timed out" : "Upstream request failed" });
    await record(ctx, { ...meta, servedModel: decision.effectiveModel, ...costs(ctx, meta, decision.effectiveModel, {}, false, false, { provider }), status, latencyMs: Date.now() - started });
    return;
  } finally { clearTimeout(timer); }

  const upstreamMs = Date.now() - started;
  let data = null;
  try { data = JSON.parse(raw); } catch { /* handled below */ }
  const ok = upstream.ok && data !== null;
  const status = data === null && upstream.ok ? 502 : upstream.status;
  const overheadMs = Math.max(0, Date.now() - receivedAt - upstreamMs);
  const servedModel = data?.model || decision.effectiveModel;
  const event = { ...meta, servedModel, ...costs(ctx, meta, servedModel, data?.usage, !!decision.routeRule, ok, { provider }), status,
    finishReason: data?.choices?.[0]?.finish_reason ?? null, latencyMs: Date.now() - started, overheadMs };
  if (ok && decision.cacheRule) ctx.cache.set(tenant.id, fp, { data }, tenant.policy.cacheTtlSec);
  try { meterAndCheck(ctx, event); } catch (error) { ctx.log.error("spend check failed:", error.message); }
  // Answer the customer first; bookkeeping must never turn a paid answer into an error.
  send(res, status, data ?? { error: { message: "Provider returned a non-JSON response" } }, { ...passthroughHeaders(upstream.headers), ...extraHeaders, "x-wastezero-overhead-ms": String(overheadMs) });
  await record(ctx, event, { metered: true });
  if (ok && decision.evaluation) {
    runEvaluation(ctx, { tenant, rule: decision.evaluation.rule, mode: decision.evaluation.mode, body, primary: data })
      .catch((error) => ctx.log.error("evaluation failed:", error.message));
  }
}

/**
 * A model sold by several providers (MODEL_OFFERS_JSON): try the cheapest healthy provider first and
 * move to the next on an outage, rate limit or server error. Saving = reference offer price − actual.
 */
async function handleOffer(ctx, req, res, tenant, body, receivedAt) {
  const { config } = ctx;
  const offers = rankOffers(config, body.model, { customerKeys: customerKeysFrom(req), health: ctx.health });
  if (!offers.length) return oaiError(res, 503, "no_provider_key", `No key for any provider of ${body.model}: send X-Upstream-Keys with your keys, e.g. {"groq":"gsk_..."}`);
  const tag = sanitizeTag(req.headers["x-wastezero-tag"]);
  const rawUser = req.headers["x-wastezero-user"] || (typeof body.user === "string" ? body.user : "");
  const endUser = rawUser ? sha256(`${tenant.id}:${rawUser}`).slice(0, 16) : null;
  const fp = fingerprint(body);
  const base = {
    timestamp: new Date().toISOString(), tenantId: tenant.id, format: "openai", tag, endUser, requestedModel: body.model,
    endUserLabel: tenant.policy.storeEndUserIds && rawUser ? String(rawUser).slice(0, 64) : null, plan: sanitizeTag(req.headers["x-wastezero-plan"]),
    ...(req.wzTeam || {}), fingerprint: fp, deterministic: isDeterministic(body), stream: body.stream === true, maxTokens: Number(body.max_completion_tokens ?? body.max_tokens) || null
  };
  const block = checkRequest(ctx, tenant, { tag, endUser, fp });
  if (block) {
    oaiError(res, block.status, block.code, block.message);
    await record(ctx, { ...base, servedModel: null, promptTokens: 0, cachedTokens: 0, completionTokens: 0, totalTokens: 0,
      actualCostUsd: 0, baselineCostUsd: 0, savingsUsd: 0, optimization: null, blocked: block.code, status: block.status, latencyMs: Date.now() - receivedAt });
    return;
  }
  const reference = config.offers[body.model][0];

  if (body.stream === true) {
    // Streams can't be retried once started, so they go to the best healthy offer.
    const o = offers[0];
    const meta = { ...base, provider: o.provider.name, keySource: o.keySource, optimization: null, ruleId: null, offerReference: reference.model };
    return streamChat(ctx, req, res, { forwarded: { ...body, model: o.model }, body, meta, decision: { effectiveModel: o.model, routeRule: null },
      upstreamKey: o.key, extraHeaders: { "x-wastezero-provider": o.provider.name }, receivedAt, provider: o.provider });
  }

  const started = Date.now();
  let served = null, upstream = null, raw = "", tried = [];
  for (const o of offers) {
    tried.push(o.provider.name);
    try {
      const r = await ctx.fetch(`${o.provider.openaiBaseUrl}/chat/completions`, {
        method: "POST", headers: openaiHeaders(o.key), body: JSON.stringify({ ...body, model: o.model }), signal: AbortSignal.timeout(config.timeoutMs)
      });
      const text = await r.text();
      if (r.status === 429 || r.status >= 500) { ctx.health.fail(o.provider.name); upstream = r; raw = text; continue; }
      ctx.health.ok(o.provider.name);
      served = o; upstream = r; raw = text;
      break;
    } catch { ctx.health.fail(o.provider.name); }
  }
  const upstreamMs = Date.now() - started;
  if (!upstream) {
    oaiError(res, 502, "all_providers_failed", `Every provider for ${body.model} failed (${tried.join(", ")})`);
    await record(ctx, { ...base, provider: tried.at(-1), servedModel: null, promptTokens: 0, cachedTokens: 0, completionTokens: 0, totalTokens: 0,
      actualCostUsd: 0, baselineCostUsd: 0, savingsUsd: 0, optimization: null, status: 502, latencyMs: upstreamMs });
    return;
  }
  const o = served || offers.at(-1);
  let data = null;
  try { data = JSON.parse(raw); } catch { /* handled below */ }
  const ok = !!served && upstream.ok && data !== null;
  const t = tokensFromUsage(data?.usage);
  const actual = costForTokens(o.model, t, config.modelRates, o.provider.pricing);
  const baselineCost = costForTokens(reference.model, t, config.modelRates, config.providers[reference.provider].pricing);
  const savings = ok && !o.reference && actual != null && baselineCost != null ? Number((baselineCost - actual).toFixed(10)) : 0;
  const overheadMs = Math.max(0, Date.now() - receivedAt - upstreamMs);
  const event = { ...base, provider: o.provider.name, keySource: o.keySource, servedModel: data?.model || o.model, offerReference: reference.model,
    promptTokens: t.prompt, cachedTokens: t.cached, completionTokens: t.completion, totalTokens: t.prompt + t.completion,
    actualCostUsd: actual, baselineCostUsd: o.reference ? actual : baselineCost, savingsUsd: savings,
    optimization: ok && !o.reference ? "offer" : null, failovers: tried.length - 1,
    status: ok ? upstream.status : (data === null && upstream.ok ? 502 : upstream.status), finishReason: data?.choices?.[0]?.finish_reason ?? null,
    latencyMs: upstreamMs, overheadMs };
  try { meterAndCheck(ctx, event); } catch (error) { ctx.log.error("spend check failed:", error.message); }
  send(res, event.status, data ?? { error: { message: "Provider returned a non-JSON response" } }, {
    ...passthroughHeaders(upstream.headers), "x-wastezero-provider": o.provider.name, "x-wastezero-overhead-ms": String(overheadMs),
    ...(tried.length > 1 ? { "x-wastezero-failover": tried.join(">") } : {})
  });
  await record(ctx, event, { metered: true });
}

async function streamChat(ctx, req, res, { forwarded, body, meta, decision, upstreamKey, extraHeaders, receivedAt, provider }) {
  const { config } = ctx;
  const clientWantsUsage = body.stream_options?.include_usage === true;
  forwarded.stream_options = { ...(body.stream_options || {}), include_usage: true };

  const started = Date.now();
  const controller = new AbortController();
  let timer;
  const arm = () => { clearTimeout(timer); timer = setTimeout(() => controller.abort(), config.timeoutMs); };  // idle timeout
  arm();
  res.on("close", () => { if (!res.writableFinished) controller.abort(); });

  let finishReason = null;
  const finish = (status, usage, servedModel) => record(ctx, {
    ...meta, servedModel: servedModel || decision.effectiveModel, finishReason, overheadMs: Math.max(0, started - receivedAt),
    ...costs(ctx, meta, servedModel || decision.effectiveModel, usage, !!decision.routeRule, status >= 200 && status < 300 && !!usage, { provider }),
    status, latencyMs: Date.now() - started
  });

  let upstream;
  try {
    upstream = await ctx.fetch(`${provider.openaiBaseUrl}/chat/completions`, {
      method: "POST",
      headers: openaiHeaders(upstreamKey),
      body: JSON.stringify(forwarded), signal: controller.signal
    });
  } catch (error) {
    clearTimeout(timer);
    const status = error.name === "AbortError" ? 504 : 502;
    send(res, status, { error: status === 504 ? "Upstream request timed out" : "Upstream request failed" });
    return finish(status, null, null);
  }

  const contentType = upstream.headers.get("content-type") || "";
  if (!upstream.ok || !contentType.includes("text/event-stream")) {
    const raw = await upstream.text().catch(() => "");
    clearTimeout(timer);
    if (!res.headersSent) { res.writeHead(upstream.status, { "content-type": contentType || "application/json", ...passthroughHeaders(upstream.headers), ...extraHeaders }); res.end(raw); }
    return finish(upstream.status, null, null);
  }

  res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache", connection: "keep-alive", ...passthroughHeaders(upstream.headers), ...extraHeaders });
  let usage = null, servedModel = null, buffer = "", status = 200;
  const decoder = new TextDecoder();
  const forward = (event) => {
    const payload = event.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trimStart()).join("\n");
    if (payload && payload !== "[DONE]") {
      try {
        const chunk = JSON.parse(payload);
        if (chunk.model) servedModel = chunk.model;
        if (chunk.choices?.[0]?.finish_reason) finishReason = chunk.choices[0].finish_reason;
        if (chunk.usage) {
          usage = chunk.usage;
          // We asked for the usage chunk for our own accounting; hide it if the client did not.
          if (!clientWantsUsage && (!chunk.choices || chunk.choices.length === 0)) return;
        }
      } catch { /* forward unparsed events untouched */ }
    }
    res.write(event + "\n\n");
  };
  try {
    for await (const piece of upstream.body) {
      arm();
      buffer = (buffer + decoder.decode(piece, { stream: true })).replace(/\r\n/g, "\n");
      let i;
      while ((i = buffer.indexOf("\n\n")) !== -1) {
        forward(buffer.slice(0, i));
        buffer = buffer.slice(i + 2);
      }
    }
    if (buffer.trim()) forward(buffer);
    res.end();
  } catch (error) {
    status = error.name === "AbortError" ? 504 : 502;
    res.destroy();
  } finally { clearTimeout(timer); }
  return finish(status, usage, servedModel);
}

// ---------------------------------------------------------------- Anthropic Messages (native)

function anthropicError(res, status, message, headers = {}) {
  send(res, status, anthropicErrorBody(status, message), headers);
}

/**
 * POST /v1/messages in Anthropic's own format, so apps using the Anthropic SDK only change their base URL.
 * Same protection, reuse, routing and accounting as chat completions, plus automatic prompt caching.
 */
async function handleMessages(ctx, req, res, tenant) {
  const { config } = ctx;
  const receivedAt = Date.now();
  let body;
  try { body = await readJson(req, config.maxBodyBytes); }
  catch (error) {
    if (error.status === 413) { anthropicError(res, 413, error.message, { connection: "close" }); req.resume(); return; }
    return anthropicError(res, error.status || 400, error.message);
  }
  if (!body || typeof body !== "object" || Array.isArray(body) || typeof body.model !== "string" || !Array.isArray(body.messages)) {
    return anthropicError(res, 400, "Expected a Messages API JSON body with model and messages");
  }
  const teamBlock = teamsGate(ctx, tenant, req, body);
  if (teamBlock) return anthropicError(res, teamBlock.status, teamBlock.message);
  const shield = shieldRequest(ctx, tenant, req, body);
  if (shield) return anthropicError(res, shield.status, shield.message);

  const header = req.headers["x-wastezero-provider"];
  let { provider, error: providerError } = resolveProvider(config, { model: body.model, header });
  if (providerError) return anthropicError(res, 400, providerError);
  if (provider.format !== "anthropic") {
    if (header) return anthropicError(res, 400, `Provider ${provider.name} does not speak the Messages API; use /v1/chat/completions`);
    provider = config.providers.anthropic;
    if (provider?.format !== "anthropic") return anthropicError(res, 400, "No Anthropic provider is configured");
  }
  const { key: upstreamKey, source: keySource } = providerKey(req, provider);
  if (!upstreamKey) return anthropicError(res, 503, `No ${provider.name} key: send X-Upstream-Authorization with your ${provider.name} key`);

  const tag = sanitizeTag(req.headers["x-wastezero-tag"]);
  const rawUser = req.headers["x-wastezero-user"] || (typeof body.metadata?.user_id === "string" ? body.metadata.user_id : "");
  const endUser = rawUser ? sha256(`${tenant.id}:${rawUser}`).slice(0, 16) : null;
  const fp = fingerprint({ ...body, _wzFormat: "anthropic" });
  const base = {
    timestamp: new Date().toISOString(), tenantId: tenant.id, provider: provider.name, format: "anthropic", tag, endUser,
    endUserLabel: tenant.policy.storeEndUserIds && rawUser ? String(rawUser).slice(0, 64) : null, plan: sanitizeTag(req.headers["x-wastezero-plan"]),
    requestedModel: body.model, ...(req.wzTeam || {}), fingerprint: fp, deterministic: isDeterministic(body), stream: body.stream === true,
    maxTokens: Number(body.max_tokens) || null
  };

  const block = checkRequest(ctx, tenant, { tag, endUser, fp });
  if (block) {
    anthropicError(res, block.status, block.message);
    await record(ctx, { ...base, servedModel: null, promptTokens: 0, cachedTokens: 0, completionTokens: 0, totalTokens: 0,
      actualCostUsd: 0, baselineCostUsd: 0, savingsUsd: 0, optimization: null, blocked: block.code, status: block.status, latencyMs: Date.now() - receivedAt });
    return;
  }
  const decision = keepRoutingOnProvider(ctx, plan({ tenant, body, tag, rules: ctx.rules, evalBudgetLeftUsd: ctx.budget.left(tenant), random: ctx.random }), provider, req);

  if (decision.cacheRule) {
    const hit = ctx.cache.get(tenant.id, fp);
    if (hit) {
      send(res, 200, hit.data, { "x-wastezero-cache": "hit" });
      const baseline = estimateCost(body.model, hit.data.usage, config.modelRates, "anthropic", provider.pricing);
      const t = tokensFromUsage(hit.data.usage, "anthropic");
      await record(ctx, { ...base, servedModel: hit.data.model, promptTokens: t.prompt, cachedTokens: t.cached, completionTokens: t.completion,
        totalTokens: t.prompt + t.completion, actualCostUsd: 0, baselineCostUsd: baseline, savingsUsd: baseline,
        optimization: "cache", ruleId: decision.cacheRule.id, status: 200, latencyMs: 0, keySource });
      return;
    }
  }

  // Automatic prompt caching, when the customer allows it.
  let forwarded = { ...body, model: decision.effectiveModel };
  let promptCached = false;
  if (tenant.policy.allowedOptimizations.includes("prompt_cache")) {
    const r = addCacheBreakpoints(forwarded, { tenantId: tenant.id, tracker: ctx.prefixes });
    if (r.added) { forwarded = r.body; promptCached = true; }
  }

  const meta = { ...base, optimization: decision.routeRule ? "route" : promptCached ? "prompt_cache" : null,
    promptCacheAdded: promptCached, ruleId: decision.routeRule?.id ?? null, keySource };
  const extraHeaders = {
    ...(decision.routeRule ? { "x-wastezero-routed-from": body.model } : {}),
    ...(promptCached ? { "x-wastezero-prompt-cache": "added" } : {})
  };
  const url = `${provider.baseUrl}/v1/messages`;
  const headers = providerHeaders(provider, upstreamKey, req);
  if (body.stream === true) return streamMessages(ctx, req, res, { url, headers, forwarded, meta, decision, extraHeaders, receivedAt, provider, promptCached });

  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  res.on("close", () => { if (!res.writableFinished) controller.abort(); });
  let upstream, raw;
  try {
    upstream = await ctx.fetch(url, { method: "POST", headers, body: JSON.stringify(forwarded), signal: controller.signal });
    raw = await upstream.text();
  } catch (error) {
    const status = error.name === "AbortError" ? 504 : 502;
    anthropicError(res, status, status === 504 ? "Upstream request timed out" : "Upstream request failed");
    await record(ctx, { ...meta, servedModel: decision.effectiveModel, ...costs(ctx, meta, decision.effectiveModel, {}, false, false, { format: "anthropic", provider }), status, latencyMs: Date.now() - started });
    return;
  } finally { clearTimeout(timer); }

  const upstreamMs = Date.now() - started;
  let data = null;
  try { data = JSON.parse(raw); } catch { /* handled below */ }
  const ok = upstream.ok && data !== null;
  const status = data === null && upstream.ok ? 502 : upstream.status;
  const overheadMs = Math.max(0, Date.now() - receivedAt - upstreamMs);
  const servedModel = data?.model || decision.effectiveModel;
  const event = { ...meta, servedModel, ...costs(ctx, meta, servedModel, data?.usage, !!decision.routeRule, ok, { format: "anthropic", provider, promptCached }), status,
    finishReason: finishReasonOf(data?.stop_reason), latencyMs: Date.now() - started, overheadMs };
  if (ok && decision.cacheRule) ctx.cache.set(tenant.id, fp, { data }, tenant.policy.cacheTtlSec);
  try { meterAndCheck(ctx, event); } catch (error) { ctx.log.error("spend check failed:", error.message); }
  send(res, status, data ?? anthropicErrorBody(502, "Provider returned a non-JSON response"), { ...passthroughHeaders(upstream.headers), ...extraHeaders, "x-wastezero-overhead-ms": String(overheadMs) });
  await record(ctx, event, { metered: true });
  if (ok && decision.evaluation) {
    runEvaluation(ctx, { tenant, rule: decision.evaluation.rule, mode: decision.evaluation.mode, body, primary: toOpenAIShape(data),
      callOther: (b) => callAnthropic(ctx, provider, b) })
      .catch((error) => ctx.log.error("evaluation failed:", error.message));
  }
}

/** Native Anthropic call with WasteZero's own key, answer converted for comparison. Used by quality tests. */
async function callAnthropic(ctx, provider, body) {
  if (!provider.serverKey) return { ok: false, status: 0 };
  try {
    const r = await ctx.fetch(`${provider.baseUrl}/v1/messages`, {
      method: "POST", headers: providerHeaders(provider, provider.serverKey),
      body: JSON.stringify({ ...body, stream: false }), signal: AbortSignal.timeout(ctx.config.timeoutMs)
    });
    const data = await r.json().catch(() => null);
    return { ok: r.ok && !!data, status: r.status, data: data ? toOpenAIShape(data) : null };
  } catch { return { ok: false, status: 0 }; }
}

async function streamMessages(ctx, req, res, { url, headers, forwarded, meta, decision, extraHeaders, receivedAt, provider, promptCached }) {
  const { config } = ctx;
  const started = Date.now();
  const controller = new AbortController();
  let timer;
  const arm = () => { clearTimeout(timer); timer = setTimeout(() => controller.abort(), config.timeoutMs); };
  arm();
  res.on("close", () => { if (!res.writableFinished) controller.abort(); });

  const usage = {};
  let servedModel = null, stopReason = null, sawUsage = false;
  const finish = (status) => record(ctx, {
    ...meta, servedModel: servedModel || decision.effectiveModel, finishReason: finishReasonOf(stopReason), overheadMs: Math.max(0, started - receivedAt),
    ...costs(ctx, meta, servedModel || decision.effectiveModel, sawUsage ? usage : null, !!decision.routeRule,
      status >= 200 && status < 300 && sawUsage, { format: "anthropic", provider, promptCached }),
    status, latencyMs: Date.now() - started
  });

  let upstream;
  try {
    upstream = await ctx.fetch(url, { method: "POST", headers, body: JSON.stringify(forwarded), signal: controller.signal });
  } catch (error) {
    clearTimeout(timer);
    const status = error.name === "AbortError" ? 504 : 502;
    anthropicError(res, status, status === 504 ? "Upstream request timed out" : "Upstream request failed");
    return finish(status);
  }
  const contentType = upstream.headers.get("content-type") || "";
  if (!upstream.ok || !contentType.includes("text/event-stream")) {
    const raw = await upstream.text().catch(() => "");
    clearTimeout(timer);
    if (!res.headersSent) { res.writeHead(upstream.status, { "content-type": contentType || "application/json", ...passthroughHeaders(upstream.headers), ...extraHeaders }); res.end(raw); }
    return finish(upstream.status);
  }

  res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache", connection: "keep-alive", ...passthroughHeaders(upstream.headers), ...extraHeaders });
  let buffer = "", status = 200;
  const decoder = new TextDecoder();
  const read = (event) => {
    const payload = event.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trimStart()).join("\n");
    if (!payload) return;
    try {
      const j = JSON.parse(payload);
      if (j.type === "message_start" && j.message) {
        servedModel = j.message.model || servedModel;
        if (j.message.usage) { Object.assign(usage, j.message.usage); sawUsage = true; }
      } else if (j.type === "message_delta") {
        if (j.usage) { Object.assign(usage, j.usage); sawUsage = true; }
        if (j.delta?.stop_reason) stopReason = j.delta.stop_reason;
      }
    } catch { /* forward untouched */ }
  };
  try {
    for await (const piece of upstream.body) {
      arm();
      const text = decoder.decode(piece, { stream: true });
      res.write(text);                       // pass every byte through unchanged
      buffer = (buffer + text).replace(/\r\n/g, "\n");
      let i;
      while ((i = buffer.indexOf("\n\n")) !== -1) { read(buffer.slice(0, i)); buffer = buffer.slice(i + 2); }
    }
    if (buffer.trim()) read(buffer);
    res.end();
  } catch (error) {
    status = error.name === "AbortError" ? 504 : 502;
    res.destroy();
  } finally { clearTimeout(timer); }
  return finish(status);
}

// ---------------------------------------------------------------- reporting

async function customerSummary(ctx, tenant) {
  const events = inWindow(await ctx.events.all(), { tenantId: tenant.id });
  const month = new Date().toISOString().slice(0, 7);
  return {
    customer: { id: tenant.id, name: tenant.name, revenueSharePct: tenant.policy.revenueSharePct, allowedOptimizations: tenant.policy.allowedOptimizations },
    thisMonth: summarize(events.filter((e) => e.timestamp.startsWith(month))),
    allTime: summarize(events),
    rules: ctx.rules.forTenant(tenant.id).map(({ id, type, match, target, state, estMonthlySavingsUsd, stats }) =>
      ({ id, type, match, target, state, estMonthlySavingsUsd, quality: { shadow: stats.shadow.n ? `${stats.shadow.passed}/${stats.shadow.n}` : null, live: stats.audit.n ? `${stats.audit.passed}/${stats.audit.n}` : null } }))
  };
}

// ---------------------------------------------------------------- admin

async function handleAdmin(ctx, req, res, url) {
  const p = url.pathname;
  const m = req.method;
  const q = (k) => url.searchParams.get(k);
  const body = () => readJson(req, 65536);
  const tenantOr404 = (id) => { const t = ctx.tenants.get(id); if (!t) throw httpError(404, "Customer not found"); return t; };

  let match;
  if (m === "GET" && p === "/admin/overview") return send(res, 200, await adminOverview(ctx));
  if (m === "GET" && p === "/admin/settings") {
    return send(res, 200, { ...ctx.settings.view(), reference: { revenueSharePct: DEFAULT_POLICY.revenueSharePct, billUsage: ctx.config.billing.billUsage, usageMarkupPct: ctx.config.billing.usageMarkupPct },
      teamsCustomers: ctx.tenants.listCustomers().filter((t) => t.org?.enabled).length });
  }
  if (m === "PATCH" && p === "/admin/settings") {
    const b = await body();
    if (!("teamsSeatUsd" in b)) throw httpError(400, "Nothing to change: send teamsSeatUsd");
    let entry;
    try { entry = await ctx.settings.setSeatPrice(b.teamsSeatUsd, { when: b.when || "next_month" }); } catch (e) { throw httpError(400, e.message); }
    await note(ctx, { actor: "admin", action: "teams_seat_price", message: `WasteZero for Teams seat price set to $${entry.usd} per active employee/month from ${entry.effectiveFrom} (was $${entry.from})` });
    // Tell companies using Teams before a change reaches their invoice (only when asked).
    let notified = 0;
    if (b.notifyCustomers && entry.usd !== entry.from) {
      for (const t of ctx.tenants.listCustomers().filter((x) => x.org?.enabled && x.billing?.email)) {
        await ctx.mailer.send({ kind: "price-change", to: t.billing.email, subject: `WasteZero for Teams: price change from ${entry.effectiveFrom}`,
          text: `From ${entry.effectiveFrom}, WasteZero for Teams costs $${entry.usd} per employee per month (was $${entry.from}). You're only charged for employees who used AI through WasteZero that month, and your savings share is unchanged.\n\nQuestions? Just reply to this email.` });
        notified++;
      }
    }
    return send(res, 200, { ...ctx.settings.view(), notified });
  }
  if (m === "GET" && p === "/admin/team") return send(res, 200, await teamStatus(ctx));
  if (m === "POST" && p === "/admin/agents/run") {
    const b = await body();
    return send(res, 200, await runAgents(ctx, { agents: {}, escalations: [] }, { only: b.agent || null }));
  }
  if (m === "POST" && p === "/admin/brief") {
    const brief = await writeBrief(ctx);
    ctx.company.m.briefs = [...ctx.company.m.briefs, brief].slice(-60);
    await ctx.company.memory.save();
    return send(res, 200, { brief });
  }
  match = p.match(/^\/admin\/tasks\/([\w-]+)\/(approve|decline|done)$/);
  if (m === "POST" && match) {
    const b = await body();
    try {
      if (match[2] === "approve") return send(res, 200, { task: await approveTask(ctx, match[1], { edits: b.edits || null }) });
      const t = await ctx.company.updateTask(match[1], { status: match[2] === "decline" ? "declined" : "done" });
      if (!t) throw httpError(404, "Task not found");
      await note(ctx, { actor: "admin", level: "info", action: `task_${match[2]}`, message: `${match[2] === "decline" ? "Declined" : "Done"}: ${t.title}` });
      return send(res, 200, { task: t });
    } catch (error) { throw error.status ? error : httpError(400, error.message); }
  }
  if (m === "GET" && p === "/admin/tenants") return send(res, 200, { tenants: ctx.tenants.listPublic() });
  if (m === "POST" && p === "/admin/tenants") {
    const b = await body();
    try {
      const created = await ctx.tenants.create({ name: b.name, policy: b.policy, email: b.email || "", website: b.website || "" });
      await note(ctx, { actor: "admin", level: "info", tenantId: created.tenant.id, action: "tenant_created", message: `Customer ${created.tenant.name} created` });
      return send(res, 201, { ...created, note: "Store apiKey now; it is not shown again." });
    } catch (error) { throw httpError(400, error.message); }
  }
  match = p.match(/^\/admin\/tenants\/([\w-]+)$/);
  if (m === "PATCH" && match) {
    const b = await body();
    try {
      const updated = await ctx.tenants.update(match[1], b);
      if (!updated) throw httpError(404, "Customer not found");
      if (!updated.policy.allowedOptimizations.includes("cache")) ctx.cache.clearTenant(updated.id);
      await note(ctx, { actor: "admin", level: "info", tenantId: updated.id, action: "tenant_updated", message: `Updated: ${Object.keys(b).join(", ")}` });
      return send(res, 200, { tenant: updated });
    } catch (error) { throw error.status ? error : httpError(400, error.message); }
  }
  match = p.match(/^\/admin\/tenants\/([\w-]+)\/(pause|resume)$/);
  if (m === "POST" && match) {
    const t = tenantOr404(match[1]);
    const b = match[2] === "pause" ? await body() : {};
    await ctx.tenants.setPaused(t.id, match[2] === "pause" ? { at: new Date().toISOString(), reason: b.reason || "paused by WasteZero admin" } : null);
    await note(ctx, { actor: "admin", level: "info", tenantId: t.id, action: match[2], message: b.reason || match[2] });
    return send(res, 200, { tenant: ctx.tenants.publicView(ctx.tenants.get(t.id)) });
  }
  if (m === "GET" && p === "/admin/waste-report") {
    const t = tenantOr404(q("tenant"));
    return send(res, 200, wasteReport({ events: await ctx.events.all(), tenant: t, config: ctx.config, rules: ctx.rules }));
  }
  match = p.match(/^\/admin\/tenants\/([\w-]+)\/rotate-key$/);
  if (m === "POST" && match) {
    const apiKey = await ctx.tenants.rotateKey(match[1]);
    if (!apiKey) throw httpError(404, "Customer not found");
    await note(ctx, { actor: "admin", level: "info", tenantId: match[1], action: "key_rotated", message: "API key rotated" });
    return send(res, 200, { apiKey, note: "Store apiKey now; it is not shown again." });
  }

  if (m === "GET" && p === "/admin/summary") {
    const events = inWindow(await ctx.events.all(), { tenantId: q("tenant"), from: q("from"), to: q("to") });
    return send(res, 200, summarize(events));
  }
  if (m === "GET" && p === "/admin/events") {
    const limit = Math.min(500, Math.max(1, Number(q("limit")) || 50));
    const tenantId = q("tenant");
    return send(res, 200, { events: await ctx.events.query((e) => !tenantId || e.tenantId === tenantId, limit) });
  }
  if (m === "GET" && p === "/admin/analysis") {
    const tenant = tenantOr404(q("tenant"));
    return send(res, 200, analyze({ events: await ctx.events.all(), tenant, config: ctx.config }));
  }

  if (m === "GET" && p === "/admin/rules") {
    const tenantId = q("tenant"), state = q("state");
    return send(res, 200, { rules: ctx.rules.list((r) => (!tenantId || r.tenantId === tenantId) && (!state || r.state === state)) });
  }
  if (m === "POST" && p === "/admin/rules") {
    const b = await body();
    tenantOr404(b.tenantId);
    try {
      const rule = await ctx.rules.add({ tenantId: b.tenantId, type: b.type, match: b.match, target: b.target, evidence: { source: "admin" } }, "admin");
      await note(ctx, { actor: "admin", level: "info", tenantId: b.tenantId, ruleId: rule.id, action: "proposed", message: b.reason || "Created by admin" });
      return send(res, 201, { rule });
    } catch (error) { throw httpError(400, error.message); }
  }
  match = p.match(/^\/admin\/rules\/([\w-]+)\/transition$/);
  if (m === "POST" && match) {
    const b = await body();
    const rule = await ctx.rules.transition(match[1], b.to, { actor: "admin", reason: b.reason || "admin decision" });
    if (rule.type === "cache" && rule.state !== "active") ctx.cache.clearTenant(rule.tenantId);
    await note(ctx, { actor: "admin", level: "info", tenantId: rule.tenantId, ruleId: rule.id, action: `rule:${b.to}`, message: b.reason || "admin decision" });
    return send(res, 200, { rule });
  }

  if (m === "POST" && p === "/admin/operator/run") return send(res, 200, await runOperator(ctx));
  if (m === "GET" && p === "/admin/operator/status") return send(res, 200, { halted: isHalted(ctx.config), enabled: ctx.config.operatorEnabled, intervalMs: ctx.config.operatorIntervalMs });
  if (m === "POST" && p === "/admin/operator/kill") {
    await writeFile(killSwitchPath(ctx.config), new Date().toISOString());
    await note(ctx, { actor: "admin", level: "escalation", action: "kill_switch_on", message: "Kill switch set: operator halted. Live rules keep running; pause them individually to stop optimisation." });
    return send(res, 200, { halted: true });
  }
  if (m === "POST" && p === "/admin/operator/resume") {
    await rm(killSwitchPath(ctx.config), { force: true });
    await note(ctx, { actor: "admin", level: "info", action: "kill_switch_off", message: "Kill switch cleared" });
    return send(res, 200, { halted: isHalted(ctx.config) });
  }
  if (m === "GET" && p === "/admin/audit") {
    const limit = Math.min(500, Math.max(1, Number(q("limit")) || 100));
    return send(res, 200, { audit: await ctx.audit.query(() => true, limit) });
  }

  if (m === "GET" && p === "/admin/invoices") {
    const tenantId = q("tenant"), period = q("period");
    if (tenantId && period) {
      if (!isPeriod(period)) throw httpError(400, "period must be YYYY-MM");
      const tenant = tenantOr404(tenantId);
      const issued = latestInvoices(await ctx.invoices.all()).find((i) => i.tenantId === tenantId && i.period === period);
      const invoice = issued || { id: "preview", ...computeInvoice({ events: await ctx.events.all(), tenant, period, usage: billingFor(ctx, period) }), reconciliation: null, status: "preview" };
      return q("format") === "html" ? sendHtml(res, renderInvoiceHtml(invoice, { payUrl: tenant.billing?.status === "card_on_file" ? "" : cardSetupUrl(ctx, tenant) })) : send(res, 200, { invoice });
    }
    return send(res, 200, { invoices: latestInvoices(await ctx.invoices.all()).filter((i) => !tenantId || i.tenantId === tenantId) });
  }
  if (m === "POST" && p === "/admin/reconcile") {
    const b = await body();
    const tenant = tenantOr404(b.tenantId);
    if (!isPeriod(b.period)) throw httpError(400, "period must be YYYY-MM");
    if (!Number.isFinite(b.providerBilledUsd) || b.providerBilledUsd < 0) throw httpError(400, "providerBilledUsd must be a non-negative number");
    const current = latestInvoices(await ctx.invoices.all()).find((i) => i.tenantId === tenant.id && i.period === b.period);
    if (current && ["paid", "charging", "pending"].includes(current.status)) throw httpError(409, `Invoice ${current.id} is ${current.status}; it cannot be reissued`);
    const computed = computeInvoice({ events: await ctx.events.all(), tenant, period: b.period, usage: billingFor(ctx, b.period) });
    const rec = reconcile({ invoice: computed, providerBilledUsd: b.providerBilledUsd, tolerancePct: ctx.config.reconcileTolerancePct });
    const invoice = issueInvoice(computed, rec);
    await ctx.invoices.add(invoice);
    await note(ctx, { actor: "admin", level: rec.withinTolerance ? "info" : "escalation", tenantId: tenant.id, action: "reconciled",
      message: `Invoice ${invoice.id} ${b.period}: provider $${rec.providerBilledUsd} vs recorded $${rec.recordedCostUsd} (${rec.variancePct}%) → ${invoice.status}` });
    return send(res, 200, { invoice });
  }

  // Billing
  match = p.match(/^\/admin\/tenants\/([\w-]+)\/card-link$/);
  if (m === "POST" && match) {
    const tenant = tenantOr404(match[1]);
    const url = cardSetupUrl(ctx, tenant);
    if (!url) throw httpError(409, "Set PUBLIC_BASE_URL and PAYMENT_PROVIDER to create card links");
    return send(res, 200, { url });
  }
  if (m === "POST" && p === "/admin/billing/collect") {
    const report = { escalations: [], collections: [] };
    await collect(ctx, report);
    return send(res, 200, report);
  }
  match = p.match(/^\/admin\/invoices\/([\w-]+)\/status$/);
  if (m === "POST" && match) {
    const b = await body();
    if (!["paid", "payment_failed", "void", "ready"].includes(b.status)) throw httpError(400, "status must be paid, payment_failed, void or ready");
    const inv = latestInvoices(await ctx.invoices.all()).find((i) => i.id === match[1]);
    if (!inv) throw httpError(404, "Invoice not found");
    const next = { ...inv, status: b.status, updatedAt: new Date().toISOString(), payment: { ...(inv.payment || {}), ...(b.status === "paid" ? { status: "paid", paidAt: new Date().toISOString() } : {}), attempts: b.status === "ready" ? 0 : inv.payment?.attempts } };
    await ctx.invoices.add(next);
    await note(ctx, { actor: "admin", level: "info", tenantId: inv.tenantId, action: `invoice_${b.status}`, message: b.reason || `Invoice ${inv.id} set to ${b.status}` });
    return send(res, 200, { invoice: next });
  }

  // Finding customers
  if (m === "GET" && p === "/admin/prospects") {
    const state = q("state");
    return send(res, 200, { prospects: ctx.prospects.list(state).map(({ company, ...rest }) => ({ ...rest, company: company ? { title: company.title, description: company.description } : null })), suppression: ctx.prospects.data.suppression, lastDiscovery: ctx.prospects.data.lastDiscovery || null });
  }
  if (m === "POST" && p === "/admin/prospects") {
    const b = await body();
    if (!Array.isArray(b.domains) || !b.domains.length) throw httpError(400, "domains must be a non-empty list");
    const added = await importDomains(ctx, b.domains.slice(0, 500), { type: "import", note: String(b.note || "").slice(0, 200) });
    return send(res, 201, { added: added.map((x) => ({ id: x.id, domain: x.domain })) });
  }
  match = p.match(/^\/admin\/prospects\/([\w-]+)$/);
  if (m === "GET" && match) {
    const pr = ctx.prospects.get(match[1]);
    if (!pr) throw httpError(404, "Prospect not found");
    return send(res, 200, { prospect: pr, draft: pr.contactEmail ? draftEmail(ctx, pr, pr.touches.length ? "followup" : "first") : null });
  }
  match = p.match(/^\/admin\/prospects\/([\w-]+)\/(approve|reject)$/);
  if (m === "POST" && match) {
    const pr = ctx.prospects.get(match[1]);
    if (!pr) throw httpError(404, "Prospect not found");
    if (pr.state !== "drafted") throw httpError(409, `Prospect is ${pr.state}, not drafted`);
    await ctx.prospects.set(pr, match[2] === "approve" ? "approved" : "rejected", {}, "admin");
    return send(res, 200, { prospect: { id: pr.id, state: pr.state } });
  }
  if (m === "POST" && p === "/admin/prospects/approve-all") {
    const drafted = ctx.prospects.list("drafted");
    for (const pr of drafted) await ctx.prospects.set(pr, "approved", {}, "admin approve-all");
    return send(res, 200, { approved: drafted.length });
  }
  if (m === "POST" && p === "/admin/prospects/suppress") {
    const b = await body();
    await ctx.prospects.suppress({ email: b.email, domain: b.domain });
    return send(res, 200, { suppression: ctx.prospects.data.suppression });
  }
  if (m === "POST" && p === "/admin/prospecting/run") {
    const report = { escalations: [] };
    await runProspecting(ctx, report);
    return send(res, 200, report);
  }

  return send(res, 404, { error: "Not found" });
}
