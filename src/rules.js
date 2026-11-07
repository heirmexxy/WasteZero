import { randomBytes } from "node:crypto";
import { JsonDoc } from "./store.js";

/**
 * An optimisation rule moves through these states:
 *
 *   proposed ──> shadow ──> active ──> rolled_back
 *       │          │          │  ▲
 *       │          └─> rejected  └─ paused
 *       └─> active (cache rules only, or a human admin)
 *
 * proposed : found by the analyser, nothing changes yet
 * shadow   : live traffic untouched; a sample is also sent to the cheaper option and graded
 * active   : live traffic is optimised; a smaller sample is re-checked against the original
 * paused   : switched off by a human, can be resumed
 * rejected / rolled_back : failed quality, can be retested
 */
const TRANSITIONS = {
  proposed: ["shadow", "active", "rejected"],
  shadow: ["active", "rejected", "paused"],
  active: ["paused", "rolled_back"],
  paused: ["active", "rolled_back", "shadow"],
  rolled_back: ["shadow", "proposed"],
  rejected: ["shadow", "proposed"]
};
export const OPEN_STATES = new Set(["proposed", "shadow", "active", "paused"]);
const AUDIT_WINDOW = 50;

const emptyStats = () => ({
  shadow: { n: 0, passed: 0, evalSpendUsd: 0, referenceCostUsd: 0, candidateCostUsd: 0 },
  audit: { n: 0, passed: 0, evalSpendUsd: 0, recent: [] }
});

export class Rules {
  constructor(file) { this.doc = new JsonDoc(file, { rules: [] }); }
  async init() { await this.doc.load(); }

  get(id) { return this.doc.data.rules.find((r) => r.id === id) || null; }
  list(filter = () => true) { return this.doc.data.rules.filter(filter); }
  forTenant(tenantId) { return this.list((r) => r.tenantId === tenantId); }

  /** Most specific rule in `state` for this request: a tag-specific rule beats a model-wide one. */
  match(tenantId, type, model, tag, state) {
    let best = null;
    for (const r of this.doc.data.rules) {
      if (r.tenantId !== tenantId || r.type !== type || r.state !== state || r.match.model !== model) continue;
      if (r.match.tag && r.match.tag !== tag) continue;
      if (!best || (r.match.tag && !best.match.tag)) best = r;
    }
    return best;
  }

  /** An open rule (or one rejected in the last `cooldownDays`) already covers this. */
  covered(tenantId, type, match, cooldownDays = 30) {
    const since = Date.now() - cooldownDays * 86400_000;
    return this.doc.data.rules.some((r) => r.tenantId === tenantId && r.type === type &&
      r.match.model === match.model && (r.match.tag || null) === (match.tag || null) &&
      (OPEN_STATES.has(r.state) || Date.parse(r.updatedAt) > since));
  }

  async add({ tenantId, type, match, target = null, evidence = {}, estMonthlySavingsUsd = null }, actor) {
    if (!["cache", "route"].includes(type)) throw new Error("type must be cache or route");
    if (!match?.model) throw new Error("match.model is required");
    if (type === "route" && (!target || target === match.model)) throw new Error("route rules need a different target model");
    const now = new Date().toISOString();
    const rule = {
      id: "r_" + randomBytes(6).toString("hex"), tenantId, type,
      match: { model: match.model, tag: match.tag || null }, target,
      state: "proposed", evidence, estMonthlySavingsUsd, stats: emptyStats(),
      createdAt: now, updatedAt: now,
      history: [{ at: now, from: null, to: "proposed", actor, reason: "created" }]
    };
    this.doc.data.rules.push(rule);
    await this.doc.save();
    return rule;
  }

  async transition(id, to, { actor, reason }) {
    const rule = this.get(id);
    if (!rule) throw Object.assign(new Error("Rule not found"), { status: 404 });
    if (!TRANSITIONS[rule.state]?.includes(to)) {
      throw Object.assign(new Error(`Cannot move a rule from ${rule.state} to ${to}`), { status: 409 });
    }
    // A cheaper model must prove itself in shadow first, unless a human decides otherwise.
    if (rule.type === "route" && rule.state === "proposed" && to === "active" && actor !== "admin") {
      throw Object.assign(new Error("Route rules must pass shadow testing before going live"), { status: 409 });
    }
    const now = new Date().toISOString();
    rule.history.push({ at: now, from: rule.state, to, actor, reason });
    rule.state = to;
    rule.updatedAt = now;
    if (to === "shadow") rule.stats.shadow = emptyStats().shadow;   // a retest starts clean
    if (to === "active") rule.stats.audit = emptyStats().audit;
    await this.doc.save();
    return rule;
  }

  async recordEval(id, phase, { passed, evalSpendUsd = 0, referenceCostUsd = null, candidateCostUsd = null }) {
    const rule = this.get(id);
    if (!rule) return;
    const s = rule.stats[phase];
    s.n++;
    if (passed) s.passed++;
    s.evalSpendUsd = Number((s.evalSpendUsd + evalSpendUsd).toFixed(10));
    if (phase === "shadow" && referenceCostUsd != null && candidateCostUsd != null) {
      s.referenceCostUsd = Number((s.referenceCostUsd + referenceCostUsd).toFixed(10));
      s.candidateCostUsd = Number((s.candidateCostUsd + candidateCostUsd).toFixed(10));
    }
    if (phase === "audit") {
      s.recent.push(passed ? 1 : 0);
      if (s.recent.length > AUDIT_WINDOW) s.recent.shift();
    }
    await this.doc.save();
  }
}
