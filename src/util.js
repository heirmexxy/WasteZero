import { createHash } from "node:crypto";

export const sha256 = (text) => createHash("sha256").update(text).digest("hex");

/** JSON.stringify with sorted keys, so equal objects always produce equal strings. */
export function stableStringify(value) {
  if (Array.isArray(value)) return "[" + value.map(stableStringify).join(",") + "]";
  if (value && typeof value === "object") {
    return "{" + Object.keys(value).sort()
      .filter((k) => value[k] !== undefined)
      .map((k) => JSON.stringify(k) + ":" + stableStringify(value[k]))
      .join(",") + "}";
  }
  return JSON.stringify(value);
}

// Fields that do not change what the model is asked to produce.
const FINGERPRINT_IGNORED = new Set(["user", "stream", "stream_options", "metadata", "store"]);

/** One-way hash identifying an identical request. Stored instead of the prompt itself. */
export function fingerprint(body) {
  const relevant = {};
  for (const key of Object.keys(body)) if (!FINGERPRINT_IGNORED.has(key)) relevant[key] = body[key];
  return sha256(stableStringify(relevant));
}

/** True when the caller asked for repeatable output (safe to serve a stored answer). */
export const isDeterministic = (body) => body.temperature === 0 && (body.n ?? 1) === 1;

export function sanitizeTag(raw) {
  if (typeof raw !== "string") return null;
  const tag = raw.trim().slice(0, 64);
  return /^[\w.:/-]+$/.test(tag) ? tag : null;
}

export const round = (n, dp = 8) => Number(Number(n).toFixed(dp));

export function median(values) {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** "YYYY-MM" of the month before `date`, in UTC. */
export function previousPeriod(date = new Date()) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() - 1, 1)).toISOString().slice(0, 7);
}
export const isPeriod = (p) => typeof p === "string" && /^\d{4}-(0[1-9]|1[0-2])$/.test(p);

/** The visitor's address. Behind Caddy/nginx (TRUST_PROXY=true) it comes from X-Forwarded-For. */
export function clientIp(req, config) {
  if (config?.trustProxy) {
    const fwd = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
    if (fwd) return fwd;
  }
  return req.socket?.remoteAddress || "unknown";
}

/**
 * Combine savings findings that may overlap, so the same dollar is never counted twice.
 * Each finding is treated as a share of total spend applied one after another:
 * total = spend × (1 − Π(1 − finding/spend)). Always below spend.
 */
export function combineSavings(spend, amounts) {
  if (!(spend > 0)) return 0;
  const remaining = amounts.reduce((left, a) => left * (1 - Math.min(Math.max(a, 0), spend) / spend), 1);
  return spend * (1 - remaining);
}

export function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
