import { costForTokens, resolveRate } from "./pricing.js";
import { median, round, combineSavings } from "./util.js";

/**
 * Free audit without the proxy: read a usage export (CSV or JSON) or pull 30 days from the
 * OpenAI organisation usage API, and estimate waste in dollars per month.
 *
 * Usage exports hold totals per model per day, not single requests, so this can see:
 * model mix, unused prompt caching, work that could use the batch discount, and spending spikes.
 * It cannot see repeated requests or loops; those need the proxy. Every finding says which it is.
 */

const BATCH_DISCOUNT = 0.5;

// ------------------------------------------------------------ parsing

export function parseCsv(text) {
  const rows = [];
  let row = [], field = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.some((f) => f !== "")) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((f) => f !== "")) rows.push(row);
  return rows;
}

const ALIASES = {
  date: ["date", "day", "starttime", "timestamp", "bucketstart", "usagedate"],
  model: ["model", "snapshotid", "modelid", "modelname"],
  inputTokens: ["inputtokens", "prompttokens", "ncontexttokenstotal", "contexttokens", "inputtokenstotal"],
  cachedTokens: ["inputcachedtokens", "cachedtokens", "cachedinputtokens", "ncachedcontexttokenstotal"],
  outputTokens: ["outputtokens", "completiontokens", "ngeneratedtokenstotal", "generatedtokens", "outputtokenstotal"],
  requests: ["nummodelrequests", "requests", "nrequests", "requestcount", "numrequests"],
  batch: ["batch", "isbatch"],
  costUsd: ["cost", "costusd", "amount", "amountvalue", "costinusd"]
};
const norm = (h) => String(h).toLowerCase().replace(/[^a-z0-9]/g, "");

function toIsoDate(v) {
  if (v == null || v === "") return null;
  const n = Number(v);
  if (Number.isFinite(n) && n > 1e9) return new Date((n < 1e12 ? n * 1000 : n)).toISOString().slice(0, 10);
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

function normalizeRow(o) {
  const pick = (field) => {
    for (const [k, v] of Object.entries(o)) if (ALIASES[field].includes(norm(k))) return v;
    return undefined;
  };
  const model = pick("model");
  const inputTokens = Number(pick("inputTokens")) || 0;
  const outputTokens = Number(pick("outputTokens")) || 0;
  if (!model || (!inputTokens && !outputTokens)) return null;
  const cached = Math.min(inputTokens, Number(pick("cachedTokens")) || 0);
  const b = pick("batch");
  const cost = pick("costUsd");
  return {
    date: toIsoDate(pick("date")), model: String(model),
    inputTokens, cachedTokens: cached, outputTokens,
    requests: Number(pick("requests")) || 0,
    batch: b === true || String(b).toLowerCase() === "true",
    costUsd: cost === undefined || cost === "" ? null : Number(cost)
  };
}

/** Accepts CSV text, an OpenAI usage API page (or a list of pages), or a JSON list of rows. */
export function parseUsage(content) {
  const text = String(content || "").trim();
  if (!text) throw new Error("The file is empty");
  if (text.startsWith("{") || text.startsWith("[")) {
    let data;
    try { data = JSON.parse(text); } catch { throw new Error("That JSON could not be read"); }
    const pages = Array.isArray(data) && data[0]?.results ? data : Array.isArray(data) ? null : data.data && data.data[0]?.results !== undefined ? data.data : null;
    if (pages) return pages.flatMap((bucket) => (bucket.results || []).map((r) => normalizeRow({ ...r, date: bucket.start_time }))).filter(Boolean);
    const list = Array.isArray(data) ? data : data.data || data.rows || [];
    return list.map(normalizeRow).filter(Boolean);
  }
  const [header, ...rest] = parseCsv(text);
  if (!header) throw new Error("No header row found");
  return rest.map((cells) => normalizeRow(Object.fromEntries(header.map((h, i) => [h, cells[i]])))).filter(Boolean);
}

/** Pull the last `days` days from the OpenAI organisation usage API. The admin key is used for this call only. */
export async function fetchOpenAIUsage(ctx, adminKey, { days = 30, baseUrl = "https://api.openai.com/v1" } = {}) {
  const start = Math.floor(Date.now() / 1000) - days * 86400;
  const rows = [];
  let page = null, styles = ["repeat", "brackets"], style = styles[0];
  for (let i = 0; i < 20; i++) {
    const params = new URLSearchParams({ start_time: String(start), bucket_width: "1d", limit: "31" });
    for (const g of ["model", "batch"]) params.append(style === "repeat" ? "group_by" : "group_by[]", g);
    if (page) params.set("page", page);
    const res = await ctx.fetch(`${baseUrl}/organization/usage/completions?${params}`, {
      headers: { authorization: `Bearer ${adminKey}` }, signal: AbortSignal.timeout(20000)
    });
    if (res.status === 400 && style === "repeat" && i === 0) { style = styles[1]; i--; continue; }
    if (res.status === 401 || res.status === 403) throw new Error("OpenAI rejected the key. Use an organisation admin key with read access to usage.");
    if (!res.ok) throw new Error(`OpenAI usage API returned ${res.status}`);
    const body = await res.json();
    for (const bucket of body.data || []) for (const r of bucket.results || []) {
      const row = normalizeRow({ ...r, date: bucket.start_time });
      if (row) rows.push(row);
    }
    if (!body.has_more || !body.next_page) break;
    page = body.next_page;
  }
  return rows;
}

// ------------------------------------------------------------ report

const usd = (n) => round(n, 2);

/**
 * Estimate waste from aggregated usage. Assumptions are stated on each finding so the reader can judge them.
 * options.routeShare: share of short-answer requests on premium models assumed to pass quality tests (default 0.5)
 * options.batchShare: share of non-batch work assumed not to be urgent (default 0.2)
 */
export function auditReport(rows, config, options = {}) {
  const routeShare = options.routeShare ?? 0.5;
  const batchShare = options.batchShare ?? 0.2;
  const rates = config.modelRates;
  const dates = rows.map((r) => r.date).filter(Boolean).sort();
  const days = dates.length ? Math.max(1, (Date.parse(dates.at(-1)) - Date.parse(dates[0])) / 86400_000 + 1) : 30;
  const monthly = (x) => usd(x * 30 / days);

  const cost = (r) => {
    const c = costForTokens(r.model, { prompt: r.inputTokens, cached: r.cachedTokens, completion: r.outputTokens }, rates);
    if (c == null) return r.costUsd;
    return r.batch ? c * BATCH_DISCOUNT : c;
  };

  const byModel = new Map();
  const unpriced = new Set();
  let total = 0;
  for (const r of rows) {
    const c = cost(r);
    if (c == null) { unpriced.add(r.model); continue; }
    total += c;
    const m = byModel.get(r.model) || { model: r.model, costUsd: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0, requests: 0, batchCostUsd: 0 };
    m.costUsd += c; m.inputTokens += r.inputTokens; m.cachedTokens += r.cachedTokens; m.outputTokens += r.outputTokens; m.requests += r.requests;
    if (r.batch) m.batchCostUsd += c;
    byModel.set(r.model, m);
  }

  const findings = [];
  for (const m of byModel.values()) {
    const key = resolveRate(m.model, rates)?.key;
    const rate = key && rates[key];
    const nonBatch = m.costUsd - m.batchCostUsd;

    // Expensive model on short tasks.
    const target = key && config.downgradeMap?.[key];
    if (target && m.requests > 0 && m.outputTokens / m.requests <= 400) {
      const share = nonBatch / Math.max(m.costUsd, 1e-12);
      const atModel = costForTokens(m.model, { prompt: m.inputTokens, cached: m.cachedTokens, completion: m.outputTokens }, rates) * share;
      const atTarget = costForTokens(target, { prompt: m.inputTokens, cached: m.cachedTokens, completion: m.outputTokens }, rates) * share;
      const saving = (atModel - atTarget) * routeShare;
      if (saving > 0) findings.push({
        kind: "model_mix", confidence: "estimated", model: m.model, monthlyUsd: monthly(saving),
        title: `${m.model} is answering short tasks a cheaper model may handle`,
        detail: `Average answer is ${Math.round(m.outputTokens / m.requests)} tokens. Moving them to ${target} would cut their cost by ${Math.round((1 - atTarget / atModel) * 100)}%. This assumes ${Math.round(routeShare * 100)}% of these requests pass quality tests; WasteZero measures the real share on your traffic before switching anything.`,
        fix: `Route ${m.model} → ${target} after shadow testing`
      });
    }

    // Prompt caching not taking effect on long prompts.
    if (rate && m.requests > 0 && m.inputTokens / m.requests >= 1024) {
      const cachedShare = m.cachedTokens / Math.max(m.inputTokens, 1);
      const reachable = 0.5;
      const cachedRate = rate.cachedInput ?? rate.input;
      if (cachedShare < reachable && cachedRate < rate.input) {
        const saving = (reachable - cachedShare) * m.inputTokens * (rate.input - cachedRate) / 1_000_000;
        if (saving > 0) findings.push({
          kind: "prompt_caching", confidence: "estimated", model: m.model, monthlyUsd: monthly(saving),
          title: `Long prompts to ${m.model} are mostly missing the provider's cache`,
          detail: `Prompts average ${Math.round(m.inputTokens / m.requests).toLocaleString()} tokens but only ${Math.round(cachedShare * 100)}% are cached. Putting the fixed parts (instructions, examples, documents) first and the changing parts last usually lets the provider cache them. Estimate assumes ${reachable * 100}% can be cached.`,
          fix: "Reorder prompts so the fixed part comes first"
        });
      }
    }

    // Work that could use the batch discount.
    if (nonBatch > 0) {
      const saving = nonBatch * batchShare * BATCH_DISCOUNT;
      findings.push({
        kind: "batch", confidence: "estimated", model: m.model, monthlyUsd: monthly(saving),
        title: `Non-urgent ${m.model} work could use the 50% batch discount`,
        detail: `${Math.round(m.batchCostUsd / Math.max(m.costUsd, 1e-12) * 100)}% of this model's spend already uses batch. If ${Math.round(batchShare * 100)}% of the rest is reports, evaluations or back-office jobs that can wait up to 24 hours, it could run at half price.`,
        fix: "Send work that can wait through the batch API"
      });
    }
  }

  // Spending spikes, from daily totals.
  const daily = new Map();
  for (const r of rows) { const c = cost(r); if (c != null && r.date) daily.set(r.date, (daily.get(r.date) || 0) + c); }
  if (daily.size >= 7) {
    const normal = median([...daily.values()]);
    const spikes = [...daily.entries()].filter(([, v]) => v > normal * 3 && v - normal > 1);
    const excess = spikes.reduce((a, [, v]) => a + (v - normal), 0);
    if (spikes.length) findings.push({
      kind: "spikes", confidence: "measured", monthlyUsd: monthly(excess),
      title: `${spikes.length} day${spikes.length > 1 ? "s" : ""} of unusual spending`,
      detail: `On ${spikes.map(([d, v]) => `${d} ($${v.toFixed(2)})`).join(", ")} spend was more than 3× a normal day ($${normal.toFixed(2)}). Runaway loops and retry storms look like this. WasteZero's spike alerts and budget caps stop them as they start.`,
      fix: "Turn on spike alerts and budget caps"
    });
  }

  findings.sort((a, b) => b.monthlyUsd - a.monthlyUsd);
  const opportunity = combineSavings(monthly(total), findings.map((f) => f.monthlyUsd));
  return {
    periodDays: round(days, 1),
    rows: rows.length,
    monthlySpendUsd: monthly(total),
    monthlyOpportunityUsd: usd(opportunity),          // overlap removed
    sumOfFindingsUsd: usd(findings.reduce((a, f) => a + f.monthlyUsd, 0)),
    findings,
    byModel: [...byModel.values()].sort((a, b) => b.costUsd - a.costUsd).map((m) => ({ model: m.model, monthlyUsd: monthly(m.costUsd), requests: m.requests })),
    unpricedModels: [...unpriced],
    notSeen: "Repeated requests, loops and truncated answers only show up per request. Route traffic through WasteZero (observe-only) to measure them."
  };
}
