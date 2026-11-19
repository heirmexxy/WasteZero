/**
 * Secrets and personal-data firewall.
 *
 * Every prompt is scanned before it leaves for the AI provider. Per customer, for secrets and for
 * personal data separately:
 *   off      nothing
 *   monitor  record what was found (type and count, never the value)
 *   mask     replace each finding with [REDACTED:type] and record it
 *   block    refuse the request and record it
 * Findings go on the request's event; the compliance report is built from those.
 */

const luhn = (digits) => {
  let sum = 0, alt = false;
  for (let i = digits.length - 1; i >= 0; i--) { let d = digits.charCodeAt(i) - 48; if (alt) { d *= 2; if (d > 9) d -= 9; } sum += d; alt = !alt; }
  return sum % 10 === 0;
};

export const SECRET_PATTERNS = [
  ["private_key", /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----[\s\S]*?-----END (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----/g],
  ["aws_access_key", /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g],
  ["aws_secret_key", /(?<=aws_secret_access_key\s*[=:]\s*["']?)[A-Za-z0-9/+=]{40}\b/gi],
  ["github_token", /\b(?:gh[pousr]_[A-Za-z0-9]{36,255}|github_pat_[A-Za-z0-9_]{60,255})\b/g],
  ["anthropic_key", /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g],
  ["openai_key", /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{32,}\b/g],
  ["stripe_key", /\b(?:sk|rk)_live_[A-Za-z0-9]{20,}\b/g],
  ["paystack_key", /\bsk_live_[a-f0-9]{30,}\b/g],
  ["google_api_key", /\bAIza[0-9A-Za-z_-]{35}\b/g],
  ["slack_token", /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/g],
  ["jwt", /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g],
  ["connection_string", /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqp):\/\/[^\s:@/]+:[^\s@/]+@[^\s"'<>]+/gi],
  ["password_assignment", /(?<=\b(?:password|passwd|pwd|secret|api[_-]?key|access[_-]?token)\s*[=:]\s*["']?)(?!\[REDACTED)[^\s"'`]{8,}/gi]
];

export const PII_PATTERNS = [
  ["email", /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g],
  ["card_number", /\b(?:\d[ -]?){13,19}\b/g, (m) => { const d = m.replace(/\D/g, ""); return d.length >= 13 && d.length <= 19 && luhn(d); }],
  ["phone", /(?<![\w.])\+?\d{1,3}[\s.-]?\(?\d{2,4}\)?[\s.-]?\d{3,4}[\s.-]?\d{3,4}(?![\w.])/g, (m) => m.replace(/\D/g, "").length >= 10],
  ["us_ssn", /\b\d{3}-\d{2}-\d{4}\b/g],
  ["iban", /\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){3,7}(?: ?[A-Z0-9]{1,3})?\b/g],
  ["nigeria_bvn_nin", /(?<=\b(?:BVN|NIN)\b\D{0,12})\d{11}\b/gi]
];

/** Scan one string. Returns { text, findings: { type: count } }, masking only when asked. */
export function scanText(text, mode, patterns) {
  const findings = {};
  if (typeof text !== "string" || !text || mode === "off") return { text, findings };
  // Each finding is replaced before the next pattern runs, so one value is never counted twice
  // (a card number is not also a phone number). Monitor mode returns the original text.
  let out = text;
  for (const [type, re, accept] of patterns) {
    out = out.replace(re, (m) => {
      if (accept && !accept(m)) return m;
      findings[type] = (findings[type] || 0) + 1;
      return `[REDACTED:${type}]`;
    });
  }
  return { text: mode === "mask" ? out : text, findings };
}

const merge = (into, f) => { for (const [k, v] of Object.entries(f)) into[k] = (into[k] || 0) + v; };

/** Walk every piece of text a request sends (system, messages, tool results), in either API format. */
function walk(body, fn) {
  if (typeof body.system === "string") body.system = fn(body.system);
  else if (Array.isArray(body.system)) for (const b of body.system) if (typeof b?.text === "string") b.text = fn(b.text);
  for (const m of Array.isArray(body.messages) ? body.messages : []) {
    if (typeof m.content === "string") m.content = fn(m.content);
    else if (Array.isArray(m.content)) for (const b of m.content) {
      if (typeof b?.text === "string") b.text = fn(b.text);
      if (typeof b?.content === "string") b.content = fn(b.content);
      else if (Array.isArray(b?.content)) for (const c of b.content) if (typeof c?.text === "string") c.text = fn(c.text);
      if (b?.type === "tool_use" && b.input && typeof b.input === "object") b.input = JSON.parse(fn(JSON.stringify(b.input)));
    }
    if (Array.isArray(m.tool_calls)) for (const t of m.tool_calls) if (typeof t?.function?.arguments === "string") t.function.arguments = fn(t.function.arguments);
  }
}

/**
 * Check (and maybe mask) a request body in place. Returns
 *   { block: "secrets" | "pii" | null, secrets: {type: n}, pii: {type: n} }
 */
export function firewall(body, policy) {
  const cfg = policy?.firewall || { secrets: "off", pii: "off" };
  const result = { block: null, secrets: {}, pii: {} };
  if (cfg.secrets === "off" && cfg.pii === "off") return result;
  // Masked JSON inside tool_use inputs must stay valid JSON, so masks never contain quotes.
  walk(body, (text) => {
    let t = text;
    if (cfg.secrets !== "off") { const r = scanText(t, cfg.secrets === "mask" ? "mask" : "monitor", SECRET_PATTERNS); merge(result.secrets, r.findings); t = r.text; }
    if (cfg.pii !== "off") { const r = scanText(t, cfg.pii === "mask" ? "mask" : "monitor", PII_PATTERNS); merge(result.pii, r.findings); t = r.text; }
    return t;
  });
  if (cfg.secrets === "block" && Object.keys(result.secrets).length) result.block = "secrets";
  else if (cfg.pii === "block" && Object.keys(result.pii).length) result.block = "pii";
  return result;
}

/** Compact record for the event log: types and counts, never values. */
export function firewallRecord(r, policy) {
  const s = Object.values(r.secrets).reduce((a, b) => a + b, 0), p = Object.values(r.pii).reduce((a, b) => a + b, 0);
  if (!s && !p) return null;
  const action = (kind) => (r.block === kind ? "blocked" : policy.firewall[kind] === "mask" ? "masked" : "logged");
  return { secrets: r.secrets, pii: r.pii, secretsAction: s ? action("secrets") : null, piiAction: p ? action("pii") : null };
}

/** Compliance report for a period from the event log. */
export function firewallReport(events, tenant, period) {
  const rows = events.filter((e) => e.tenantId === tenant.id && e.firewall && String(e.timestamp).startsWith(period));
  const byType = {}, byAction = { masked: 0, blocked: 0, logged: 0 }, byPerson = {};
  const people = new Map((tenant.org?.people || []).map((p) => [p.id, p.email]));
  for (const e of rows) {
    for (const kind of ["secrets", "pii"]) for (const [t, n] of Object.entries(e.firewall[kind] || {})) {
      byType[t] = byType[t] || { kind, count: 0 }; byType[t].count += n;
      const a = e.firewall[`${kind}Action`]; if (a) byAction[a] += n;
    }
    const who = e.personId ? (tenant.org?.settings?.privacyMode ? "(private)" : people.get(e.personId) || e.personId) : (e.tag || "untagged");
    byPerson[who] = (byPerson[who] || 0) + 1;
  }
  return {
    period, requestsWithFindings: rows.length, byType, byAction, settings: tenant.policy.firewall,
    top: Object.entries(byPerson).sort((a, b) => b[1] - a[1]).slice(0, 20).map(([who, requests]) => ({ who, requests })),
    recent: rows.slice(-50).reverse().map((e) => ({ at: e.timestamp, who: e.personId ? (tenant.org?.settings?.privacyMode ? "(private)" : people.get(e.personId) || e.personId) : (e.tag || "–"), secrets: e.firewall.secrets, pii: e.firewall.pii, secretsAction: e.firewall.secretsAction, piiAction: e.firewall.piiAction }))
  };
}

export function firewallCsv(report) {
  const lines = ["time,who,secrets,secrets_action,personal_data,personal_data_action"];
  const fmt = (o) => Object.entries(o || {}).map(([k, v]) => `${k}:${v}`).join(" ");
  for (const r of report.recent) lines.push([r.at, r.who, fmt(r.secrets), r.secretsAction || "", fmt(r.pii), r.piiAction || ""].map((v) => `"${String(v).replace(/"/g, '""')}"`).join(","));
  return lines.join("\n") + "\n";
}
