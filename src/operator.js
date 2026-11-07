import { existsSync } from "node:fs";
import path from "node:path";
import { analyze } from "./analyzer.js";
import { computeInvoice, issueInvoice, latestInvoices } from "./billing.js";
import { previousPeriod, round } from "./util.js";
import { collect } from "./collections.js";
import { runProspecting } from "./prospecting.js";

export const killSwitchPath = (config) => path.join(config.dataDir, "KILL_SWITCH");
export const isHalted = (config) => !config.operatorEnabled || existsSync(killSwitchPath(config));

/** Record a decision in the audit log; escalations also go to the webhook for a human. */
export async function note(ctx, entry) {
  const record = { timestamp: new Date().toISOString(), actor: "operator", ...entry };
  await ctx.audit.add(record);
  if (record.level === "escalation" && ctx.config.escalationWebhookUrl) {
    try {
      await ctx.fetch(ctx.config.escalationWebhookUrl, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: `[WasteZero] ${record.message}`, ...record }),
        signal: AbortSignal.timeout(10000)
      });
    } catch (error) { ctx.log.error("escalation webhook failed:", error.message); }
  }
  return record;
}

async function move(ctx, rule, to, reason, report) {
  await ctx.rules.transition(rule.id, to, { actor: "operator", reason });
  report.actions.push({ tenantId: rule.tenantId, ruleId: rule.id, to, reason });
  await note(ctx, { level: "info", tenantId: rule.tenantId, ruleId: rule.id, action: `rule:${to}`, message: reason });
}

/** Escalate once per rule per reason, so humans are not spammed every run. */
async function escalateOnce(ctx, rule, key, message, report) {
  rule.escalated ||= {};
  if (rule.escalated[key]) return;
  rule.escalated[key] = new Date().toISOString();
  await ctx.rules.doc.save();
  report.escalations.push({ tenantId: rule.tenantId, ruleId: rule.id, message });
  await note(ctx, { level: "escalation", tenantId: rule.tenantId, ruleId: rule.id, action: key, message });
}

/**
 * One pass of the autonomous operator. For each customer it:
 *   1. looks for waste and files proposals,
 *   2. starts quality tests where the customer allowed it,
 *   3. promotes, rejects or rolls back rules based on measured quality,
 *   4. drafts last month's invoice.
 * It only ever acts within each customer's policy, and stops entirely if the kill switch is set.
 */
export async function runOperator(ctx, { now = new Date() } = {}) {
  const report = { startedAt: now.toISOString(), halted: false, proposals: [], actions: [], escalations: [], invoices: [], collections: [], findings: [], prospecting: null };
  if (isHalted(ctx.config)) {
    report.halted = true;
    await note(ctx, { level: "info", action: "halted", message: "Operator skipped: kill switch set or OPERATOR_ENABLED=false" });
    return report;
  }

  const events = await ctx.events.all();
  const invoices = latestInvoices(await ctx.invoices.all());

  for (const tenant of ctx.tenants.list()) {
    const policy = tenant.policy;
    const allowed = new Set(policy.allowedOptimizations);

    // 1. Find waste.
    const { proposals, findings } = analyze({ events, tenant, config: ctx.config, now: now.getTime() });
    report.findings.push(...findings.map((f) => ({ tenantId: tenant.id, ...f })));
    for (const p of proposals) {
      if (ctx.rules.covered(tenant.id, p.type, p.match)) continue;
      const rule = await ctx.rules.add({ tenantId: tenant.id, ...p }, "operator");
      report.proposals.push({ tenantId: tenant.id, ruleId: rule.id, type: p.type, match: p.match, target: p.target, estMonthlySavingsUsd: p.estMonthlySavingsUsd });
      await note(ctx, { level: "info", tenantId: tenant.id, ruleId: rule.id, action: "proposed",
        message: `${p.type === "cache" ? "Reuse repeated answers" : `Route to ${p.target}`} for ${p.match.model}${p.match.tag ? ` [${p.match.tag}]` : ""}: est. $${p.estMonthlySavingsUsd}/month` });
    }

    for (const rule of ctx.rules.forTenant(tenant.id)) {
      const permitted = allowed.has(rule.type);

      // 2. Start testing (or, for exact-repeat reuse, go live) where the customer allowed it.
      if (rule.state === "proposed") {
        if (!permitted) { await escalateOnce(ctx, rule, "needs_consent", `Customer ${tenant.name} has not allowed "${rule.type}"; proposal ${rule.id} (est. $${rule.estMonthlySavingsUsd}/month) needs their consent.`, report); continue; }
        if (rule.type === "cache") {
          if (policy.autoPromote) await move(ctx, rule, "active", "Exact repeats of deterministic requests; customer allows automatic rollout", report);
          else await escalateOnce(ctx, rule, "needs_approval", `Answer reuse for ${rule.match.model} is ready; approve rule ${rule.id} to go live.`, report);
        } else if (policy.autoShadow) {
          await move(ctx, rule, "shadow", `Testing ${rule.target} against ${rule.match.model} on ${Math.round(policy.shadowSampleRate * 100)}% of matching requests`, report);
        } else {
          await escalateOnce(ctx, rule, "needs_approval", `Approve shadow testing of ${rule.target} for ${rule.match.model} (rule ${rule.id}).`, report);
        }
        continue;
      }

      // 3a. Decide on rules under test.
      if (rule.state === "shadow") {
        const s = rule.stats.shadow;
        if (s.n < policy.minSamples) {
          if (ctx.budget.left(tenant) <= 0) await escalateOnce(ctx, rule, "budget_exhausted", `Testing budget for ${tenant.name} is used up with ${s.n}/${policy.minSamples} samples for rule ${rule.id}.`, report);
          continue;
        }
        const passRate = s.passed / s.n;
        const measured = s.referenceCostUsd > 0 ? round(1 - s.candidateCostUsd / s.referenceCostUsd, 4) : null;
        const summary = `${s.passed}/${s.n} answers acceptable (${round(passRate * 100, 1)}%, need ${policy.minQuality * 100}%)${measured != null ? `, measured cost reduction ${round(measured * 100, 1)}%` : ""}`;
        if (passRate < policy.minQuality) await move(ctx, rule, "rejected", `Quality too low: ${summary}`, report);
        else if (measured != null && measured <= 0) await move(ctx, rule, "rejected", `No saving: ${summary}`, report);
        else if (policy.autoPromote && permitted) await move(ctx, rule, "active", `Passed: ${summary}`, report);
        else await escalateOnce(ctx, rule, "needs_approval", `Rule ${rule.id} passed testing (${summary}); approve to go live.`, report);
        continue;
      }

      // 3b. Watch live rules and roll back if quality slips.
      if (rule.state === "active") {
        if (!permitted) { await move(ctx, rule, "paused", "Customer withdrew consent for this optimisation", report); continue; }
        const recent = rule.stats.audit.recent;
        if (recent.length >= 10) {
          const passRate = recent.reduce((a, b) => a + b, 0) / recent.length;
          if (passRate < policy.minQuality) {
            await move(ctx, rule, "rolled_back", `Live quality dropped to ${round(passRate * 100, 1)}% over the last ${recent.length} checks`, report);
            ctx.cache.clearTenant(tenant.id);
            await escalateOnce(ctx, rule, "rolled_back", `Rolled back rule ${rule.id} for ${tenant.name}: live quality ${round(passRate * 100, 1)}%.`, report);
          }
        }
      }
    }

    // 4. Draft last month's invoice once.
    const period = previousPeriod(now);
    if (!invoices.some((i) => i.tenantId === tenant.id && i.period === period)) {
      const computed = computeInvoice({ events, tenant, period });
      if (computed.calls > 0) {
        const invoice = issueInvoice(computed);
        await ctx.invoices.add(invoice);
        report.invoices.push({ tenantId: tenant.id, id: invoice.id, period, feeUsd: invoice.feeUsd, status: invoice.status });
        await note(ctx, { level: invoice.totalUsd > 0 && ctx.config.billing.requireReconciliation ? "escalation" : "info", tenantId: tenant.id, action: "invoice_drafted",
          message: `Draft invoice ${invoice.id} for ${tenant.name} ${period}: saved $${computed.savingsUsd}, total due $${invoice.totalUsd}.${ctx.config.billing.requireReconciliation ? " Reconcile with the provider bill to send and charge it." : ""}` });
      }
    }
  }

  // 5. Send and collect invoices.
  await collect(ctx, report, { now });

  // 6. Find new customers.
  if (ctx.config.prospecting.enabled) {
    const before = report.escalations.length;
    await runProspecting(ctx, report, { now });
    for (const e of report.escalations.slice(before)) await note(ctx, { level: "escalation", action: "outreach_waiting", message: e.message });
  }
  return report;
}
