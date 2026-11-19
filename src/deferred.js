import { randomBytes } from "node:crypto";
import { JsonDoc } from "./store.js";
import { estimateCost, tokensFromUsage } from "./pricing.js";
import { sealSecret, openSecret, storedProviderKeys } from "./teams.js";
import { isPublicHttps } from "./guard.js";

/**
 * Deferred requests: work that can wait (evaluations, overnight reports, backfills, bulk
 * classification) goes through the providers' batch services at about half price.
 *
 *   POST /v1/deferred/chat/completions   (OpenAI format)    → 202 { id, status: "queued" }
 *   POST /v1/deferred/messages           (Anthropic format) → 202 { id, status: "queued" }
 *   GET  /v1/deferred/{id}                                   → { status, result | error }
 *
 * WasteZero collects queued jobs, submits them as one batch per customer, provider and key
 * (Anthropic Message Batches, OpenAI Batch API), polls, and stores each result. Results usually
 * arrive within minutes and at most within 24 hours. Optional X-WasteZero-Callback: an HTTPS URL
 * that receives the result. Providers without a batch service run the job straight away at the
 * normal price. The discount is recorded as "batch" savings.
 */

export const BATCH_DISCOUNT = 0.5;
const BATCH_PROVIDERS = new Set(["anthropic", "openai"]);
const KEEP_DAYS = 7;

export class DeferredJobs {
  constructor(file) { this.doc = new JsonDoc(file, { jobs: [] }); }
  async init() { await this.doc.load(); }
  get jobs() { return this.doc.data.jobs; }
  get(id) { return this.jobs.find((j) => j.id === id) || null; }
  async save() { await this.doc.save(); }
}

const newId = () => `dj_${randomBytes(9).toString("hex")}`;

/** Queue one request. `keyHeader` is the customer's own provider key if they sent one (stored encrypted until used). */
export async function enqueue(ctx, { tenant, provider, format, body, keyHeader, callbackUrl, extra = {}, tag = null }) {
  const job = {
    id: newId(), tenantId: tenant.id, provider: provider.name, format, model: body.model, body: { ...body, stream: undefined },
    key: keyHeader ? sealSecret(ctx.config, keyHeader) : null, status: "queued", createdAt: new Date().toISOString(),
    callbackUrl: callbackUrl || null, tag, personId: extra.personId || null, teamId: extra.teamId || null, firewall: extra.firewall || null
  };
  delete job.body.stream;
  ctx.deferred.jobs.push(job);
  await ctx.deferred.save();
  return job;
}

export function publicJob(j) {
  return { id: j.id, object: "deferred_job", status: j.status, model: j.model, created_at: j.createdAt, completed_at: j.completedAt || null,
    discount: BATCH_PROVIDERS.has(j.provider) ? BATCH_DISCOUNT : 0, result: j.result ?? null, error: j.error ?? null };
}

function keyFor(ctx, tenant, provider, job) {
  if (job.key) { const k = openSecret(ctx.config, job.key); if (k) return { key: k, source: "customer" }; }
  const stored = storedProviderKeys(ctx.config, tenant)?.[provider.name];
  if (stored) return { key: stored, source: "customer" };
  return { key: provider.serverKey, source: "wastezero" };
}

async function call(ctx, url, init) {
  const r = await ctx.fetch(url, { ...init, signal: AbortSignal.timeout(60000) });
  const text = await r.text();
  if (!r.ok) throw new Error(`${r.status} from ${new URL(url).host}: ${text.slice(0, 200)}`);
  return text;
}

const anthropicHeaders = (key) => ({ "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" });
const bearer = (key) => ({ authorization: `Bearer ${key}` });

/** Submit queued jobs: one batch per customer + provider + key. Providers without batches run now. */
export async function submitDeferred(ctx) {
  const queued = ctx.deferred.jobs.filter((j) => j.status === "queued");
  if (!queued.length) return 0;
  const groups = new Map();
  for (const j of queued) {
    const tenant = ctx.tenants.get(j.tenantId);
    const provider = ctx.config.providers[j.provider];
    if (!tenant || !provider) { j.status = "failed"; j.error = "customer or provider no longer exists"; continue; }
    const k = keyFor(ctx, tenant, provider, j);
    if (!k.key) { j.status = "failed"; j.error = `No ${provider.name} key available`; continue; }
    j.keySource = k.source;
    const gk = `${j.tenantId}|${provider.name}|${k.key}`;
    if (!groups.has(gk)) groups.set(gk, { tenant, provider, key: k.key, jobs: [] });
    groups.get(gk).jobs.push(j);
  }
  let n = 0;
  for (const g of groups.values()) {
    for (let i = 0; i < g.jobs.length; i += 1000) {
      const chunk = g.jobs.slice(i, i + 1000);
      try {
        if (!BATCH_PROVIDERS.has(g.provider.name)) { await runDirect(ctx, g, chunk); continue; }
        const batchId = g.provider.name === "anthropic" ? await submitAnthropic(ctx, g, chunk) : await submitOpenAI(ctx, g, chunk);
        for (const j of chunk) { j.status = "submitted"; j.batchId = batchId; j.submittedAt = new Date().toISOString(); }
        n += chunk.length;
      } catch (e) {
        ctx.log.error(`deferred submit (${g.provider.name}) failed:`, e.message);
        for (const j of chunk) { j.attempts = (j.attempts || 0) + 1; if (j.attempts >= 5) { j.status = "failed"; j.error = e.message; } }
      }
    }
  }
  await ctx.deferred.save();
  return n;
}

async function submitAnthropic(ctx, g, jobs) {
  const text = await call(ctx, `${g.provider.baseUrl}/v1/messages/batches`, {
    method: "POST", headers: anthropicHeaders(g.key), body: JSON.stringify({ requests: jobs.map((j) => ({ custom_id: j.id, params: j.body })) })
  });
  return JSON.parse(text).id;
}

async function submitOpenAI(ctx, g, jobs) {
  const jsonl = jobs.map((j) => JSON.stringify({ custom_id: j.id, method: "POST", url: "/v1/chat/completions", body: j.body })).join("\n") + "\n";
  const form = new FormData();
  form.append("purpose", "batch");
  form.append("file", new Blob([jsonl], { type: "application/jsonl" }), "wastezero-batch.jsonl");
  const file = JSON.parse(await call(ctx, `${g.provider.openaiBaseUrl}/files`, { method: "POST", headers: bearer(g.key), body: form }));
  const batch = JSON.parse(await call(ctx, `${g.provider.openaiBaseUrl}/batches`, {
    method: "POST", headers: { ...bearer(g.key), "content-type": "application/json" },
    body: JSON.stringify({ input_file_id: file.id, endpoint: "/v1/chat/completions", completion_window: "24h", metadata: { source: "wastezero" } })
  }));
  return batch.id;
}

async function runDirect(ctx, g, jobs) {
  for (const j of jobs) {
    try {
      const url = g.provider.format === "anthropic" ? `${g.provider.baseUrl}/v1/messages` : `${g.provider.openaiBaseUrl}/chat/completions`;
      const headers = g.provider.format === "anthropic" ? anthropicHeaders(g.key) : { ...bearer(g.key), "content-type": "application/json" };
      const data = JSON.parse(await call(ctx, url, { method: "POST", headers, body: JSON.stringify(j.body) }));
      await finish(ctx, j, data, 0);
    } catch (e) { j.status = "failed"; j.error = e.message; }
  }
}

/** Check submitted batches; store results and record spend and savings. */
export async function pollDeferred(ctx) {
  const byBatch = new Map();
  for (const j of ctx.deferred.jobs) if (j.status === "submitted") (byBatch.get(j.batchId) || byBatch.set(j.batchId, []).get(j.batchId)).push(j);
  let done = 0;
  for (const [batchId, jobs] of byBatch) {
    const tenant = ctx.tenants.get(jobs[0].tenantId);
    const provider = ctx.config.providers[jobs[0].provider];
    if (!tenant || !provider) continue;
    const k = keyFor(ctx, tenant, provider, jobs[0]);
    try {
      const results = provider.name === "anthropic" ? await anthropicResults(ctx, provider, k.key, batchId) : await openaiResults(ctx, provider, k.key, batchId);
      if (!results) continue;                                   // still running
      for (const j of jobs) {
        const r = results.get(j.id);
        if (r?.ok) { await finish(ctx, j, r.data, BATCH_DISCOUNT); done++; }
        else { j.status = "failed"; j.error = r?.error || "missing from the batch results"; j.completedAt = new Date().toISOString(); }
      }
    } catch (e) {
      ctx.log.error("deferred poll failed:", e.message);
      if (jobs.some((j) => Date.parse(j.submittedAt) < Date.now() - 30 * 3600_000)) for (const j of jobs) { j.status = "failed"; j.error = `batch did not finish: ${e.message}`; }
    }
  }
  if (byBatch.size) await ctx.deferred.save();
  return done;
}

const parseLines = (text) => text.split("\n").filter((l) => l.trim()).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);

async function anthropicResults(ctx, provider, key, batchId) {
  const b = JSON.parse(await call(ctx, `${provider.baseUrl}/v1/messages/batches/${encodeURIComponent(batchId)}`, { headers: anthropicHeaders(key) }));
  if (b.processing_status !== "ended") return null;
  const out = new Map();
  for (const row of parseLines(await call(ctx, b.results_url, { headers: anthropicHeaders(key) }))) {
    out.set(row.custom_id, row.result?.type === "succeeded" ? { ok: true, data: row.result.message } : { ok: false, error: row.result?.error?.error?.message || row.result?.type || "failed" });
  }
  return out;
}

async function openaiResults(ctx, provider, key, batchId) {
  const b = JSON.parse(await call(ctx, `${provider.openaiBaseUrl}/batches/${encodeURIComponent(batchId)}`, { headers: bearer(key) }));
  if (["failed", "expired", "cancelled"].includes(b.status)) {
    throw new Error(`batch ${b.status}`);
  }
  if (b.status !== "completed") return null;
  const out = new Map();
  for (const fileId of [b.output_file_id, b.error_file_id].filter(Boolean)) {
    for (const row of parseLines(await call(ctx, `${provider.openaiBaseUrl}/files/${encodeURIComponent(fileId)}/content`, { headers: bearer(key) }))) {
      const ok = row.response?.status_code >= 200 && row.response.status_code < 300;
      out.set(row.custom_id, ok ? { ok: true, data: row.response.body } : { ok: false, error: row.error?.message || row.response?.body?.error?.message || "failed" });
    }
  }
  return out;
}

async function finish(ctx, job, data, discount) {
  const provider = ctx.config.providers[job.provider];
  const full = estimateCost(job.model, data.usage, ctx.config.modelRates, job.format, provider.pricing) ?? 0;
  const actual = full * (1 - discount);
  const t = tokensFromUsage(data.usage, job.format);
  job.status = "completed"; job.completedAt = new Date().toISOString(); job.result = data;
  const event = {
    timestamp: job.completedAt, tenantId: job.tenantId, provider: job.provider, format: job.format, tag: job.tag, requestedModel: job.model,
    servedModel: data.model || job.model, status: 200, deferred: true, jobId: job.id, keySource: job.keySource || "wastezero",
    promptTokens: t.prompt, cachedTokens: t.cached, completionTokens: t.completion, totalTokens: t.prompt + t.completion,
    baselineCostUsd: full, actualCostUsd: actual, savingsUsd: full - actual, optimization: discount ? "batch" : null,
    ...(job.personId ? { personId: job.personId } : {}), ...(job.teamId ? { teamId: job.teamId } : {}), ...(job.firewall ? { firewall: job.firewall } : {})
  };
  await ctx.events.add(event);
  try { const { meterAndCheck } = await import("./guard.js"); meterAndCheck(ctx, event); } catch { /* metering is best effort here */ }
  job.key = null;                                            // the customer's key is not kept after use
  if (job.callbackUrl && await isPublicHttps(ctx, job.callbackUrl)) {
    ctx.fetch(job.callbackUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(publicJob(job)), redirect: "error", signal: AbortSignal.timeout(10000) }).catch(() => {});
  }
}

/** Forget finished jobs after a week (results included). */
export async function pruneDeferred(ctx, now = Date.now()) {
  const before = ctx.deferred.jobs.length;
  ctx.deferred.doc.data.jobs = ctx.deferred.jobs.filter((j) => !["completed", "failed"].includes(j.status) || Date.parse(j.completedAt || j.createdAt) > now - KEEP_DAYS * 86400_000);
  if (ctx.deferred.jobs.length !== before) await ctx.deferred.save();
}

/** Spend that looks like it could wait: tagged background work. Half of it is the possible saving. */
export const BACKGROUND_TAG = /(eval|batch|backfill|nightly|cron|report|offline|bulk|index|embed|classif|enrich|digest|summar.*daily)/i;
export function batchableReport(tenant, events, now = new Date()) {
  const since = now.getTime() - 30 * 86400_000;
  const byTag = new Map();
  let deferredSaved = 0;
  for (const e of events) {
    if (e.tenantId !== tenant.id || Date.parse(e.timestamp) < since) continue;
    if (e.deferred) { deferredSaved += e.savingsUsd || 0; continue; }
    if (!e.tag || !BACKGROUND_TAG.test(e.tag) || !(e.actualCostUsd > 0)) continue;
    const t = byTag.get(e.tag) || { tag: e.tag, requests: 0, costUsd: 0 };
    t.requests++; t.costUsd += e.actualCostUsd; byTag.set(e.tag, t);
  }
  const tags = [...byTag.values()].map((t) => ({ ...t, costUsd: Math.round(t.costUsd * 100) / 100, possibleSavingUsd: Math.round(t.costUsd * BATCH_DISCOUNT * 100) / 100 })).sort((a, b) => b.costUsd - a.costUsd);
  return { tags, possibleMonthlySavingUsd: Math.round(tags.reduce((a, t) => a + t.possibleSavingUsd, 0) * 100) / 100, deferredSavedUsd: Math.round(deferredSaved * 100) / 100 };
}
