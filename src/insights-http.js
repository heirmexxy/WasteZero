import { isPeriod } from "./util.js";
import { firewallReport, firewallCsv } from "./firewall.js";
import { note } from "./operator.js";
import { setIntegrations, integrationsView, syncRoi, roiReport } from "./roi.js";
import { seatAdvice, DEFAULT_SEAT_PLANS } from "./seats.js";
import { creditsReport } from "./credits.js";
import { batchableReport, BATCH_DISCOUNT } from "./deferred.js";
import { economics } from "./economics.js";
import { benchmarks } from "./benchmarks.js";
import { normalizePolicy } from "./tenants.js";

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
  // ---- one call for the Insights tab
  if (m === "GET" && api === "/insights") {
    const events = await ctx.events.all();
    return json(res, 200, {
      roi: roiReport(tenant, events, period), seats: seatAdvice(tenant, events), credits: creditsReport(tenant, events),
      batch: { ...batchableReport(tenant, events), discount: BATCH_DISCOUNT }, margins: economics({ events, tenant }),
      benchmarks: benchmarks(ctx, tenant, events, period), policy: { seatPlans: tenant.policy.seatPlans, defaultSeatPlans: DEFAULT_SEAT_PLANS, credits: tenant.policy.credits,
        marginAlertPct: tenant.policy.marginAlertPct, shareBenchmarks: tenant.policy.shareBenchmarks, planPrices: tenant.policy.planPrices }
    });
  }
  if (m === "PATCH" && api === "/insights/settings") {
    let b; try { b = await readJson(req); } catch (e) { return json(res, 400, { error: e.message }); }
    const allowed = ["seatPlans", "credits", "marginAlertPct", "shareBenchmarks", "planPrices"];
    const patch = Object.fromEntries(Object.entries(b).filter(([k]) => allowed.includes(k)));
    if (!Object.keys(patch).length) return json(res, 400, { error: `Send one of: ${allowed.join(", ")}` });
    try { tenant.policy = normalizePolicy({ ...tenant.policy, ...patch }, tenant.policy); } catch (e) { return json(res, 400, { error: e.message }); }
    await ctx.tenants.doc.save();
    await note(ctx, { actor: `customer:${tenant.id}`, action: "insights_settings", tenantId: tenant.id, message: `Changed ${Object.keys(patch).join(", ")}` });
    return json(res, 200, { ok: true });
  }

  // ---- ROI ledger
  if (m === "GET" && api === "/insights/roi") return json(res, 200, roiReport(tenant, await ctx.events.all(), period));
  if (m === "GET" && api === "/insights/integrations") return json(res, 200, integrationsView(tenant));
  if (m === "PUT" && api === "/insights/integrations") {
    let b; try { b = await readJson(req); } catch (e) { return json(res, 400, { error: e.message }); }
    let view; try { view = setIntegrations(ctx.config, tenant, b); } catch (e) { return json(res, 400, { error: e.message }); }
    await ctx.tenants.doc.save();
    await note(ctx, { actor: `customer:${tenant.id}`, action: "integrations", tenantId: tenant.id, message: `Integrations updated: ${Object.keys(b).join(", ")}` });
    return json(res, 200, view);
  }
  if (m === "POST" && api === "/insights/roi/sync") {
    const r = await syncRoi(ctx, tenant, period);
    return json(res, 200, { errors: r.errors, report: roiReport(tenant, await ctx.events.all(), period) });
  }
  return json(res, 404, { error: "Not found" });
}
