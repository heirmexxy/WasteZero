import { breakerGate } from "./breaker.js";
import { firewall, firewallRecord } from "./firewall.js";

/**
 * Checks every request gets before it leaves for a provider (after budgets):
 * the circuit breaker for its agent session, then the secrets & personal-data firewall
 * (which may mask the body in place). Returns null, or { status, code, message } to refuse.
 * Fields for the event log go on req.wzTeam (spread into every event).
 */
export function shieldRequest(ctx, tenant, req, body) {
  const extra = (req.wzTeam ||= {});
  const tripped = breakerGate(ctx, tenant, req, body);
  if (req.wzSession) { extra.sessionKey = req.wzSession.key; extra.sessionLabel = req.wzSession.label; }
  if (tripped) return { status: tripped.status, code: "session_paused", message: tripped.message };
  const fw = firewall(body, tenant.policy);
  const record = firewallRecord(fw, tenant.policy);
  if (record) extra.firewall = record;
  if (fw.block) {
    const what = fw.block === "secrets" ? `secrets (${Object.keys(fw.secrets).join(", ")})` : `personal data (${Object.keys(fw.pii).join(", ")})`;
    ctx.events.add({ tenantId: tenant.id, timestamp: new Date().toISOString(), status: 403, blockedBy: "firewall", model: body.model, actualCostUsd: 0, baselineCostUsd: 0, savingsUsd: 0, ...extra })
      .catch((e) => ctx.log.error("firewall event failed:", e.message));
    return { status: 403, code: "blocked_by_firewall", message: `WasteZero blocked this request: it contains ${what}. Remove them and try again (your company's security setting).` };
  }
  return null;
}
