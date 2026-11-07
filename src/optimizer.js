import { isDeterministic } from "./util.js";

/** Reusable when the caller asked for repeatable output, or the customer opted this feature (or everything) in. */
export function isCacheable(body, policy, tag = null) {
  if (body.stream === true) return false;
  if ((body.n ?? 1) !== 1) return false;
  return isDeterministic(body) || policy.cacheNondeterministic === true || (tag != null && (policy.cacheTags || []).includes(tag));
}

/**
 * Decide what to do with one request. Pure: no I/O, so it is easy to test.
 * Only rules the customer allowed, in the right state, are ever applied.
 */
export function plan({ tenant, body, tag, rules, evalBudgetLeftUsd, random = Math.random }) {
  const policy = tenant.policy;
  const allowed = new Set(policy.allowedOptimizations);
  const result = { requestedModel: body.model, effectiveModel: body.model, routeRule: null, cacheRule: null, evaluation: null };

  if (allowed.has("cache") && isCacheable(body, policy, tag)) {
    result.cacheRule = rules.match(tenant.id, "cache", body.model, tag, "active");
  }

  if (allowed.has("route")) {
    const canEvaluate = body.stream !== true && evalBudgetLeftUsd > 0;
    const active = rules.match(tenant.id, "route", body.model, tag, "active");
    if (active) {
      result.effectiveModel = active.target;
      result.routeRule = active;
      if (canEvaluate && random() < policy.auditSampleRate) result.evaluation = { rule: active, mode: "audit" };
    } else {
      const shadow = rules.match(tenant.id, "route", body.model, tag, "shadow");
      if (shadow && canEvaluate && random() < policy.shadowSampleRate) result.evaluation = { rule: shadow, mode: "shadow" };
    }
  }
  return result;
}
