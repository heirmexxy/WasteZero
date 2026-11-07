import { randomBytes } from "node:crypto";
import { JsonDoc } from "./store.js";
import { sha256 } from "./util.js";

export const OPTIMIZATIONS = ["cache", "route"];

/**
 * What a customer has agreed WasteZero may do on its own. Everything is off by
 * default: a new customer is observe-only until they opt in.
 */
export const DEFAULT_POLICY = Object.freeze({
  allowedOptimizations: [],     // subset of OPTIMIZATIONS
  autoShadow: false,            // operator may start quality tests on its own
  autoPromote: false,           // operator may switch live traffic once tests pass
  minQuality: 0.95,             // share of tested answers that must be acceptable
  minSamples: 30,               // tests needed before a decision
  shadowSampleRate: 0.1,        // share of matching requests duplicated for testing
  auditSampleRate: 0.02,        // share of live optimised requests re-checked
  maxEvalSpendUsdPerMonth: 20,  // WasteZero's own spend cap for testing this customer
  revenueSharePct: 20,          // fee as % of verified savings
  monthlyBaseFeeUsd: 0,         // fixed monthly subscription charged on top (0 = savings share only)
  cacheTtlSec: 3600,
  cacheNondeterministic: false, // reuse answers even when temperature > 0, for every feature
  cacheTags: [],                // features (X-WasteZero-Tag) whose answers may be reused at any temperature

  // Runaway-spend protection. 0 = no cap.
  budgets: { dailyUsd: 0, monthlyUsd: 0, perTagDailyUsd: {}, perUserDailyUsd: 0 },
  budgetAction: "block",        // block | alert, when a cap is reached
  loopBreaker: { maxRepeats: 20, windowSec: 60, action: "alert" },   // alert | block | off
  spikeAlert: { factor: 5, minHourlyUsd: 5, action: "alert" },      // alert | pause | off
  alertEmail: "",               // defaults to the billing email
  alertWebhookUrl: ""           // Slack-compatible incoming webhook (HTTPS)
});

/** Fields a customer may change themselves through /v1/wastezero/settings. Commercial terms are not among them. */
export const CUSTOMER_EDITABLE = ["allowedOptimizations", "autoShadow", "autoPromote", "minQuality", "cacheTags", "cacheNondeterministic",
  "budgets", "budgetAction", "loopBreaker", "spikeAlert", "alertEmail", "alertWebhookUrl"];

const num = (v, min, max, name) => {
  if (!Number.isFinite(v) || v < min || v > max) throw new Error(`${name} must be between ${min} and ${max}`);
  return v;
};
const oneOf = (v, list, name) => { if (!list.includes(v)) throw new Error(`${name} must be one of ${list.join(", ")}`); return v; };
const tagList = (v, name) => {
  if (!Array.isArray(v) || v.some((t) => typeof t !== "string" || !/^[\w.:/-]{1,64}$/.test(t))) throw new Error(`${name} must be a list of feature tags`);
  return [...new Set(v)];
};

function normalizeSafety(policy, base) {
  const b = { ...base.budgets, ...(policy.budgets || {}) };
  b.dailyUsd = num(b.dailyUsd, 0, 1e7, "budgets.dailyUsd");
  b.monthlyUsd = num(b.monthlyUsd, 0, 1e8, "budgets.monthlyUsd");
  b.perUserDailyUsd = num(b.perUserDailyUsd, 0, 1e7, "budgets.perUserDailyUsd");
  if (!b.perTagDailyUsd || typeof b.perTagDailyUsd !== "object" || Array.isArray(b.perTagDailyUsd)) throw new Error("budgets.perTagDailyUsd must be an object of tag: usd");
  for (const [t, v] of Object.entries(b.perTagDailyUsd)) { tagList([t], "budgets.perTagDailyUsd"); num(v, 0, 1e7, `budgets.perTagDailyUsd.${t}`); }
  policy.budgets = { dailyUsd: b.dailyUsd, monthlyUsd: b.monthlyUsd, perTagDailyUsd: b.perTagDailyUsd, perUserDailyUsd: b.perUserDailyUsd };
  oneOf(policy.budgetAction, ["block", "alert"], "budgetAction");
  const lb = { ...base.loopBreaker, ...(policy.loopBreaker || {}) };
  policy.loopBreaker = { maxRepeats: num(lb.maxRepeats, 2, 10000, "loopBreaker.maxRepeats"), windowSec: num(lb.windowSec, 5, 3600, "loopBreaker.windowSec"), action: oneOf(lb.action, ["alert", "block", "off"], "loopBreaker.action") };
  const sa = { ...base.spikeAlert, ...(policy.spikeAlert || {}) };
  policy.spikeAlert = { factor: num(sa.factor, 1.5, 1000, "spikeAlert.factor"), minHourlyUsd: num(sa.minHourlyUsd, 0, 1e6, "spikeAlert.minHourlyUsd"), action: oneOf(sa.action, ["alert", "pause", "off"], "spikeAlert.action") };
  policy.cacheTags = tagList(policy.cacheTags, "cacheTags");
  if (typeof policy.alertEmail !== "string" || (policy.alertEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(policy.alertEmail))) throw new Error("alertEmail is not valid");
  if (typeof policy.alertWebhookUrl !== "string" || (policy.alertWebhookUrl && !/^https:\/\//.test(policy.alertWebhookUrl))) throw new Error("alertWebhookUrl must be an https URL");
}

const RANGES = {
  minQuality: [0.5, 1], minSamples: [5, 100000], shadowSampleRate: [0, 1], auditSampleRate: [0, 1],
  maxEvalSpendUsdPerMonth: [0, 1e6], revenueSharePct: [0, 100], monthlyBaseFeeUsd: [0, 1e6], cacheTtlSec: [1, 30 * 86400]
};

export function normalizePolicy(input = {}, base = DEFAULT_POLICY) {
  const policy = { ...DEFAULT_POLICY, ...base, ...input };
  if (!Array.isArray(policy.allowedOptimizations) || !policy.allowedOptimizations.every((o) => OPTIMIZATIONS.includes(o))) {
    throw new Error(`allowedOptimizations must be a list drawn from ${OPTIMIZATIONS.join(", ")}`);
  }
  policy.allowedOptimizations = [...new Set(policy.allowedOptimizations)];
  for (const [key, [min, max]] of Object.entries(RANGES)) {
    if (!Number.isFinite(policy[key]) || policy[key] < min || policy[key] > max) throw new Error(`${key} must be between ${min} and ${max}`);
  }
  for (const key of ["autoShadow", "autoPromote", "cacheNondeterministic"]) {
    if (typeof policy[key] !== "boolean") throw new Error(`${key} must be true or false`);
  }
  normalizeSafety(policy, { ...DEFAULT_POLICY, ...base });
  for (const key of Object.keys(policy)) if (!(key in DEFAULT_POLICY)) delete policy[key];
  return policy;
}

const publicView = ({ keyHash, billing = {}, ...rest }) => {
  const { authorizationCode, paymentMethodId, ...safeBilling } = billing;
  return { ...rest, billing: { ...safeBilling, hasCard: Boolean(authorizationCode || paymentMethodId) } };
};

export class Tenants {
  constructor(file, { bootstrapKey = "" } = {}) {
    this.doc = new JsonDoc(file, { tenants: [] });
    this.bootstrapKey = bootstrapKey;
  }

  async init() {
    const data = await this.doc.load();
    // Upgrade records written by older versions: fill in policy fields added since.
    let upgraded = false;
    for (const t of data.tenants) {
      const missing = Object.keys(DEFAULT_POLICY).some((k) => !(k in (t.policy || {})));
      if (missing) { t.policy = normalizePolicy({}, t.policy || {}); upgraded = true; }
      if (!t.billing) { t.billing = { email: "", status: "no_card" }; upgraded = true; }
    }
    if (upgraded) await this.doc.save();
    // Backwards compatibility with v0.3's single WASTEZERO_API_KEY: an observe-only "default" customer.
    if (this.bootstrapKey) {
      const keyHash = sha256(this.bootstrapKey);
      const existing = data.tenants.find((t) => t.id === "default");
      if (!existing) data.tenants.push({ id: "default", name: "Default", keyHash, policy: { ...DEFAULT_POLICY }, active: true, createdAt: new Date().toISOString() });
      else if (existing.keyHash !== keyHash) existing.keyHash = keyHash;
      else return;
      await this.doc.save();
    }
  }

  // Keys are stored only as SHA-256 hashes; comparing hashes reveals nothing useful about the key.
  findByKey(key) {
    if (!key) return null;
    const hash = sha256(key);
    return this.doc.data.tenants.find((t) => t.active && t.keyHash === hash) || null;
  }
  get(id) { return this.doc.data.tenants.find((t) => t.id === id) || null; }
  list() { return this.doc.data.tenants.filter((t) => t.active); }
  listPublic() { return this.doc.data.tenants.map(publicView); }
  publicView(t) { return publicView(t); }

  async create({ name, policy = {}, email = "", website = "", source = "admin", prospectId = null }) {
    if (typeof name !== "string" || !name.trim()) throw new Error("name is required");
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("email is not valid");
    const apiKey = "wz_" + randomBytes(24).toString("base64url");
    const tenant = {
      id: "t_" + randomBytes(6).toString("hex"),
      name: name.trim().slice(0, 120),
      keyHash: sha256(apiKey),
      policy: normalizePolicy(policy),
      billing: { email: email.trim().toLowerCase(), status: "no_card" },
      website: String(website).slice(0, 200), source, prospectId,
      active: true,
      createdAt: new Date().toISOString()
    };
    this.doc.data.tenants.push(tenant);
    await this.doc.save();
    return { tenant: publicView(tenant), apiKey };
  }

  async update(id, { name, policy, active, email }) {
    const tenant = this.get(id);
    if (!tenant) return null;
    if (policy !== undefined) tenant.policy = normalizePolicy(policy, tenant.policy);
    if (name !== undefined) tenant.name = String(name).trim().slice(0, 120) || tenant.name;
    if (active !== undefined) tenant.active = Boolean(active);
    if (email !== undefined) tenant.billing = { ...(tenant.billing || {}), email: String(email).trim().toLowerCase() };
    tenant.updatedAt = new Date().toISOString();
    await this.doc.save();
    return publicView(tenant);
  }

  findByEmail(email) {
    const e = String(email || "").toLowerCase();
    return this.doc.data.tenants.find((t) => t.billing?.email === e) || null;
  }

  async setBilling(id, patch) {
    const tenant = this.get(id);
    if (!tenant) return null;
    tenant.billing = { ...(tenant.billing || {}), ...patch };
    if (patch.paymentMethodId || patch.authorizationCode) tenant.billing.status = "card_on_file";
    await this.doc.save();
    return tenant;
  }

  async setPaused(id, paused) {
    const tenant = this.get(id);
    if (!tenant) return null;
    tenant.paused = paused || null;
    await this.doc.save();
    return tenant;
  }

  async rotateKey(id) {
    const tenant = this.get(id);
    if (!tenant) return null;
    const apiKey = "wz_" + randomBytes(24).toString("base64url");
    tenant.keyHash = sha256(apiKey);
    await this.doc.save();
    return apiKey;
  }
}
