import { stableStringify } from "./util.js";
import { estimateCost } from "./pricing.js";

const JUDGE_SYSTEM = [
  "You are a strict quality reviewer for a cost-saving system.",
  "A production request was answered by a REFERENCE model. A cheaper CANDIDATE model answered the same request.",
  "Decide whether the candidate answer is an acceptable substitute for the reference from the end user's point of view:",
  "same facts, same instructions followed, same required format, no errors or omissions that matter. Wording and style may differ.",
  'Reply only with JSON: {"acceptable": true or false, "score": integer 0-10}'
].join(" ");

const truncate = (s, n) => (s.length > n ? s.slice(0, n) + "\n[...truncated]" : s);

function answerText(choice) {
  const content = choice?.message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((p) => p?.text || "").join("");
  return "";
}

function toolSignature(choice) {
  const calls = choice?.message?.tool_calls;
  if (!Array.isArray(calls) || !calls.length) return null;
  return stableStringify(calls.map((c) => {
    let args = c?.function?.arguments;
    try { args = JSON.parse(args); } catch { /* compare raw */ }
    return { name: c?.function?.name, args };
  }));
}

/**
 * Cheap checks that settle many comparisons without a grader call.
 * Tool calls must match exactly: a different tool or argument is never "close enough".
 */
export function quickCompare(reference, candidate) {
  const ref = reference?.choices?.[0];
  const cand = candidate?.choices?.[0];
  if (!cand) return { decided: true, passed: false, method: "missing" };
  const refTools = toolSignature(ref);
  const candTools = toolSignature(cand);
  if (refTools || candTools) return { decided: true, passed: refTools === candTools, method: "tool_calls" };
  if (cand.finish_reason === "length" && ref?.finish_reason !== "length") return { decided: true, passed: false, method: "truncated" };
  const a = answerText(ref).trim();
  const b = answerText(cand).trim();
  if (!b) return { decided: true, passed: false, method: "empty" };
  if (a === b) return { decided: true, passed: true, method: "identical" };
  return { decided: false };
}

/** Ask a grader model whether the candidate answer can replace the reference. */
export async function judge({ callModel, judgeModel, rates, body, reference, candidate }) {
  const request = truncate(JSON.stringify(body.messages ?? []), 12000);
  const res = await callModel({
    model: judgeModel,
    temperature: 0,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: JUDGE_SYSTEM },
      { role: "user", content: `REQUEST MESSAGES (JSON):\n${request}\n\nREFERENCE ANSWER:\n${truncate(answerText(reference.choices?.[0]), 6000)}\n\nCANDIDATE ANSWER:\n${truncate(answerText(candidate.choices?.[0]), 6000)}` }
    ]
  });
  const costUsd = res.ok ? (estimateCost(res.data?.model || judgeModel, res.data?.usage, rates) ?? 0) : 0;
  if (!res.ok) return { ok: false, costUsd };
  try {
    const verdict = JSON.parse(answerText(res.data.choices?.[0]));
    const score = Number(verdict.score);
    return { ok: true, passed: verdict.acceptable === true && score >= 7, score, costUsd, method: "judge" };
  } catch {
    return { ok: false, costUsd };
  }
}

/**
 * Compare a cheaper option against the original on one real request.
 * shadow: customer got the original; we also ask the candidate.
 * audit : customer got the candidate; we also ask the original.
 * Stores scores and costs only, never the text.
 */
export async function runEvaluation(ctx, { tenant, rule, mode, body, primary }) {
  const { config } = ctx;
  const otherModel = mode === "shadow" ? rule.target : rule.match.model;
  const other = await ctx.callModel({ ...body, model: otherModel, stream: false, stream_options: undefined });
  let spend = other.ok ? (estimateCost(other.data?.model || otherModel, other.data?.usage, config.modelRates) ?? 0) : 0;
  if (!other.ok) {
    ctx.budget.add(tenant.id, spend);
    return { ok: false, reason: "comparison call failed" };
  }
  const reference = mode === "shadow" ? primary : other.data;
  const candidate = mode === "shadow" ? other.data : primary;

  let verdict = quickCompare(reference, candidate);
  if (!verdict.decided) {
    const graded = await judge({ callModel: ctx.callModel, judgeModel: config.judgeModel, rates: config.modelRates, body, reference, candidate });
    spend += graded.costUsd;
    if (!graded.ok) { ctx.budget.add(tenant.id, spend); return { ok: false, reason: "grader failed" }; }
    verdict = graded;
  }

  const referenceCostUsd = estimateCost(reference.model || rule.match.model, reference.usage, config.modelRates);
  const candidateCostUsd = estimateCost(candidate.model || rule.target, candidate.usage, config.modelRates);
  ctx.budget.add(tenant.id, spend);
  await ctx.rules.recordEval(rule.id, mode, { passed: verdict.passed, evalSpendUsd: spend, referenceCostUsd, candidateCostUsd });
  await ctx.evals.add({
    timestamp: new Date().toISOString(), tenantId: tenant.id, ruleId: rule.id, mode,
    passed: verdict.passed, score: verdict.score ?? null, method: verdict.method,
    evalSpendUsd: spend, referenceCostUsd, candidateCostUsd
  });
  return { ok: true, passed: verdict.passed };
}

/** WasteZero's own monthly testing spend per customer, held in memory and rebuilt from the evals log at start-up. */
export class EvalBudget {
  constructor() { this.spent = new Map(); }
  period() { return new Date().toISOString().slice(0, 7); }
  load(records) {
    const period = this.period();
    for (const r of records) if (r.timestamp?.startsWith(period)) this.add(r.tenantId, r.evalSpendUsd || 0);
  }
  add(tenantId, usd) {
    const k = `${tenantId}:${this.period()}`;
    this.spent.set(k, (this.spent.get(k) || 0) + usd);
  }
  spentThisMonth(tenantId) { return this.spent.get(`${tenantId}:${this.period()}`) || 0; }
  left(tenant) { return tenant.policy.maxEvalSpendUsdPerMonth - this.spentThisMonth(tenant.id); }
}
