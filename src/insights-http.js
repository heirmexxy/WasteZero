import { isPeriod } from "./util.js";
import { firewallReport, firewallCsv } from "./firewall.js";
import { note } from "./operator.js";

// Customer dashboard API for Security (circuit breaker + firewall) and Insights.
// Mounted under /app/api/security* and /app/api/insights*.

export async function handleInsightsApi(ctx, req, res, tenant, api, url, { json, readJson }) {
  const m = req.method;
  const period = url.searchParams.get("period") || new Date().toISOString().slice(0, 7);
  if (!isPeriod(period)) return json(res, 400, { error: "period must be YYYY-MM" });

  if (m === "GET" && api === "/security") {
    return json(res, 200, { firewall: firewallReport(await ctx.events.all(), tenant, period), breaker: tenant.policy.breaker, paused: ctx.breaker.paused(tenant.id) });
  }
  if (m === "GET" && api === "/security.csv") {
    res.writeHead(200, { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="wastezero-security-${period}.csv"` });
    return res.end(firewallCsv(firewallReport(await ctx.events.all(), tenant, period)));
  }
  if (m === "POST" && api === "/security/resume") {
    let b; try { b = await readJson(req); } catch (e) { return json(res, 400, { error: e.message }); }
    if (typeof b.key !== "string" || !b.key.startsWith(tenant.id + "|")) return json(res, 400, { error: "Unknown session" });
    ctx.breaker.resume(b.key);
    await note(ctx, { actor: `customer:${tenant.id}`, action: "session_resumed", tenantId: tenant.id, message: "Session resumed from the dashboard" });
    return json(res, 200, { paused: ctx.breaker.paused(tenant.id) });
  }
  return json(res, 404, { error: "Not found" });
}
