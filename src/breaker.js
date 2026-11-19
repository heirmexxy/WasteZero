import { createHash } from "node:crypto";
import { signToken, verifyToken } from "./tokens.js";
import { deliverAlert } from "./guard.js";
import { note } from "./operator.js";

/**
 * Circuit breaker for runaway agent sessions.
 *
 * An agent session (a Claude Code run, a script, a background job) is paused, on its own, when:
 *   - it spends more than breaker.usdPer10Min in any 10 minutes, or
 *   - it sends the same failing tool result breaker.repeatLimit times in a row (stuck in a loop).
 * The rest of the account keeps working. The engineer and their manager (or the account's alert
 * contacts) are told at once, with a one-click resume link. Pauses lift by themselves after
 * breaker.pauseMinutes. action "alert" only warns; "off" disables it.
 *
 * Sessions are recognised by X-WasteZero-Session, else the SDK's metadata.user_id / user field
 * (Claude Code puts its session id there), else the key and end user.
 */

const WINDOW_MS = 10 * 60_000;
const sha = (s) => createHash("sha256").update(s).digest("hex").slice(0, 16);

export class Breaker {
  constructor() { this.sessions = new Map(); }

  state(key) {
    let s = this.sessions.get(key);
    if (!s) {
      s = { spend: [], lastSig: null, repeats: 0, pausedUntil: 0, reason: null, trips: 0, lastSeen: 0, label: null, graceUntil: 0 };
      this.sessions.set(key, s);
      if (this.sessions.size > 50000) {                 // forget the oldest idle sessions
        const cutoff = Date.now() - 6 * 3600_000;
        for (const [k, v] of this.sessions) if (v.lastSeen < cutoff && v.pausedUntil < Date.now()) this.sessions.delete(k);
      }
    }
    return s;
  }
  pause(key, minutes, reason, now = Date.now()) { const s = this.state(key); s.pausedUntil = now + minutes * 60_000; s.reason = reason; s.trips++; }
  resume(key, now = Date.now()) {
    const s = this.sessions.get(key);
    if (!s) return false;
    s.pausedUntil = 0; s.reason = null; s.spend = []; s.repeats = 0; s.lastSig = null; s.graceUntil = now + WINDOW_MS;
    return true;
  }
  paused(tenantId) {
    const now = Date.now(), out = [];
    for (const [k, s] of this.sessions) if (k.startsWith(tenantId + "|") && s.pausedUntil > now) out.push({ key: k, label: s.label, reason: s.reason, until: new Date(s.pausedUntil).toISOString() });
    return out;
  }
}

/** Who and what this request belongs to. */
export function sessionOf(req, tenant, body) {
  const explicit = String(req.headers["x-wastezero-session"] || "").slice(0, 200);
  const meta = String(body?.metadata?.user_id || body?.user || "").slice(0, 300);
  const fromMeta = meta.match(/session[_-]([\w-]{8,})/i)?.[1] || meta;
  const who = req.wzTeam?.personId || req.wzKeyId || "key";
  const raw = explicit || fromMeta || `${who}:${String(req.headers["x-wastezero-user"] || "")}`;
  // The label never holds a raw end-user id (body.user can be an email): only a short hash.
  return { key: `${tenant.id}|${who}|${sha(raw)}`, label: explicit ? explicit.slice(0, 60) : fromMeta ? `session ${sha(fromMeta).slice(0, 8)}` : "default session" };
}

/** The last tool result, if it failed: what an agent stuck in a loop keeps sending back. */
export function failingToolSignature(body) {
  const msgs = Array.isArray(body?.messages) ? body.messages : [];
  const last = msgs.at(-1);
  if (!last) return null;
  const text = (c) => (typeof c === "string" ? c : Array.isArray(c) ? c.map((b) => (typeof b?.text === "string" ? b.text : typeof b?.content === "string" ? b.content : Array.isArray(b?.content) ? text(b.content) : "")).join("\n") : "");
  if (last.role === "tool") {            // OpenAI format
    const t = text(last.content);
    return /error|exception|failed|traceback|not found|denied|refused/i.test(t) ? sha(t.slice(0, 4000)) : null;
  }
  if (last.role === "user" && Array.isArray(last.content)) {   // Anthropic format
    const results = last.content.filter((b) => b?.type === "tool_result");
    const failed = results.filter((b) => b.is_error || /error|exception|failed|traceback/i.test(text(b.content)));
    return failed.length ? sha(failed.map((b) => text(b.content)).join("|").slice(0, 4000)) : null;
  }
  return null;
}

/**
 * Before a request goes out. Returns null to go ahead, or { status, message } when this
 * session is paused (or is pausing now because it is stuck in a loop).
 */
export function breakerGate(ctx, tenant, req, body) {
  const cfg = tenant.policy.breaker;
  if (!cfg || cfg.action === "off") return null;
  const sess = sessionOf(req, tenant, body);
  req.wzSession = sess;
  const s = ctx.breaker.state(sess.key);
  const now = Date.now();
  s.lastSeen = now; s.label = sess.label;
  if (s.pausedUntil > now) return { status: 429, message: pausedMessage(ctx, tenant, sess, s) };

  const sig = failingToolSignature(body);
  if (sig && sig === s.lastSig) s.repeats++; else { s.repeats = sig ? 1 : 0; s.lastSig = sig; }
  if (sig && s.repeats >= cfg.repeatLimit) {
    const reason = `stuck in a loop: the same failing step came back ${s.repeats} times in a row`;
    s.repeats = 0;
    return trip(ctx, tenant, req, sess, s, reason);
  }
  return null;
}

/** After a request is metered: watch the session's spend rate. */
export function breakerObserve(ctx, tenant, event) {
  const cfg = tenant.policy.breaker;
  if (!cfg || cfg.action === "off" || !event.sessionKey || !(event.actualCostUsd > 0)) return;
  const s = ctx.breaker.state(event.sessionKey);
  const now = Date.now();
  s.spend.push([now, event.actualCostUsd]);
  s.spend = s.spend.filter(([t]) => now - t < WINDOW_MS);
  if (now < s.graceUntil || s.pausedUntil > now) return;
  const total = s.spend.reduce((a, [, v]) => a + v, 0);
  if (total > cfg.usdPer10Min) {
    trip(ctx, tenant, { wzTeam: { personId: event.personId } }, { key: event.sessionKey, label: event.sessionLabel || s.label }, s,
      `spent $${total.toFixed(2)} in 10 minutes (limit $${cfg.usdPer10Min})`);
    s.spend = [];
  }
}

function trip(ctx, tenant, req, sess, s, reason) {
  const cfg = tenant.policy.breaker;
  const pausing = cfg.action === "pause";
  if (pausing) ctx.breaker.pause(sess.key, cfg.pauseMinutes, reason);
  else s.trips++;
  const org = tenant.org;
  const person = req.wzTeam?.personId && org ? org.people.find((p) => p.id === req.wzTeam.personId) : null;
  const who = person ? (person.name || person.email) : "An agent session";
  const link = resumeLink(ctx, tenant, sess);
  const msg = `Circuit breaker: ${who} (${sess.label}) ${reason}. ${pausing ? `That session is paused for up to ${cfg.pauseMinutes} minutes; the rest of your account keeps working. Resume it: ${link}` : "Alert only: nothing was paused."}`;
  (async () => {
    await deliverAlert(ctx, tenant, msg);
    if (person) {
      await ctx.mailer.send({ kind: "breaker", to: person.email, subject: pausing ? "Your AI session was paused" : "Your AI session looks stuck", text: `${msg}\n\nCheck what the agent is doing before resuming.` });
      const mgr = person.managerId && org.people.find((p) => p.id === person.managerId);
      if (mgr && !org.settings?.privacyMode) await ctx.mailer.send({ kind: "breaker", to: mgr.email, subject: `${who}'s AI session was ${pausing ? "paused" : "flagged"}`, text: msg });
    }
    await note(ctx, { actor: "breaker", action: pausing ? "session_paused" : "session_flagged", tenantId: tenant.id, message: `${sess.label}: ${reason}` });
  })().catch((e) => ctx.log.error("breaker alert failed:", e.message));
  return pausing ? { status: 429, message: pausedMessage(ctx, tenant, sess, s) } : null;
}

function pausedMessage(ctx, tenant, sess, s) {
  return `WasteZero paused this AI session: ${s.reason}. Other work isn't affected. Resume when you're ready: ${resumeLink(ctx, tenant, sess)} (it also resumes by itself at ${new Date(s.pausedUntil).toISOString().slice(11, 16)} UTC).`;
}

export function resumeLink(ctx, tenant, sess) {
  return `${ctx.config.publicBaseUrl}/breaker/resume?token=${encodeURIComponent(signToken(ctx.config, { k: "br", t: tenant.id, s: sess.key, l: sess.label }, 24 * 3600))}`;
}

export function resumeFromToken(ctx, token) {
  const v = verifyToken(ctx.config, token);
  if (v?.k !== "br" || !String(v.s).startsWith(v.t + "|")) return null;
  return { tenantId: v.t, key: v.s, label: v.l };
}
