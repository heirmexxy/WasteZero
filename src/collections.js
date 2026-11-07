import { latestInvoices, renderInvoiceHtml } from "./billing.js";
import { signToken, link } from "./tokens.js";
import { note } from "./operator.js";

const CHARGEABLE = new Set(["ready", "draft", "payment_failed", "awaiting_card"]);

export function cardSetupUrl(ctx, tenant) {
  if (!ctx.config.publicBaseUrl || !ctx.payments.enabled) return "";
  return link(ctx.config, "/billing/setup", { token: signToken(ctx.config, { t: tenant.id, p: "card" }) });
}

async function update(ctx, invoice, patch) {
  const next = { ...invoice, ...patch, updatedAt: new Date().toISOString() };
  await ctx.invoices.add(next);
  return next;
}

/**
 * Send and collect invoices:
 *   - an invoice is billable once reconciled ("ready"), or straight away if reconciliation is not required
 *   - the customer is emailed the invoice once, with a card link if no card is saved
 *   - the saved card is charged; failures retry every BILLING_RETRY_HOURS up to BILLING_MAX_ATTEMPTS
 *   - an invoice found mid-charge ("charging") after a crash is never retried automatically
 */
export async function collect(ctx, report, { now = new Date() } = {}) {
  const b = ctx.config.billing;
  for (let invoice of latestInvoices(await ctx.invoices.all())) {
    const tenant = ctx.tenants.get(invoice.tenantId);
    if (!tenant) continue;

    if (invoice.status === "charging") {
      if (!invoice.escalatedStuck) {
        invoice = await update(ctx, invoice, { escalatedStuck: true });
        report.escalations.push({ tenantId: tenant.id, message: `Invoice ${invoice.id} was interrupted mid-charge; check ${b.provider} before retrying.` });
        await note(ctx, { level: "escalation", tenantId: tenant.id, action: "charge_interrupted", message: `Invoice ${invoice.id} was interrupted mid-charge; check the payment provider, then set its status manually.` });
      }
      continue;
    }
    if (!CHARGEABLE.has(invoice.status)) continue;
    if (invoice.status === "draft" && b.requireReconciliation) continue;

    const total = invoice.totalUsd ?? invoice.feeUsd ?? 0;
    if (total <= 0) {
      await update(ctx, invoice, { status: "no_charge" });
      report.collections.push({ tenantId: tenant.id, invoiceId: invoice.id, status: "no_charge" });
      continue;
    }

    // Email the invoice once.
    if (!invoice.emailedAt && tenant.billing?.email) {
      const payUrl = cardSetupUrl(ctx, tenant);
      const hasCard = tenant.billing?.status === "card_on_file";
      const sent = await ctx.mailer.send({
        kind: "invoice", to: tenant.billing.email,
        subject: `WasteZero invoice ${invoice.period}: you saved $${invoice.savingsUsd.toFixed(2)}`,
        html: renderInvoiceHtml(invoice, { payUrl: hasCard ? "" : payUrl }),
        text: `WasteZero invoice ${invoice.id} for ${invoice.period}. Saved $${invoice.savingsUsd.toFixed(2)}. Total due $${total.toFixed(2)}.${hasCard ? " Your card on file will be charged." : payUrl ? ` Add a card: ${payUrl}` : ""}`
      });
      if (sent.ok) invoice = await update(ctx, invoice, { emailedAt: now.toISOString() });
    }

    if (!ctx.payments.enabled || !b.autoCharge) continue;
    const attempts = invoice.payment?.attempts || 0;
    if (attempts >= b.maxAttempts) {
      if (!invoice.escalatedFailed) {
        invoice = await update(ctx, invoice, { escalatedFailed: true });
        report.escalations.push({ tenantId: tenant.id, message: `Invoice ${invoice.id} unpaid after ${attempts} attempts.` });
        await note(ctx, { level: "escalation", tenantId: tenant.id, action: "collections_failed", message: `Invoice ${invoice.id} for ${tenant.name} ($${total}) unpaid after ${attempts} attempts: ${invoice.payment?.error || "no card"}` });
      }
      continue;
    }
    const last = invoice.payment?.lastAttemptAt ? Date.parse(invoice.payment.lastAttemptAt) : 0;
    if (last && now.getTime() - last < b.retryHours * 3600_000 && invoice.status !== "awaiting_card") continue;
    if (invoice.status === "awaiting_card" && tenant.billing?.status !== "card_on_file") continue;

    invoice = await update(ctx, invoice, { status: "charging" });
    const result = await ctx.payments.charge(tenant, invoice, attempts + 1);
    const payment = {
      ...(invoice.payment || {}), provider: ctx.payments.name, attempts: result.status === "awaiting_card" ? attempts : attempts + 1,
      lastAttemptAt: now.toISOString(), providerRef: result.providerRef ?? invoice.payment?.providerRef ?? null,
      error: result.error || null, ...(result.status === "paid" ? { paidAt: now.toISOString(), status: "paid" } : {})
    };
    invoice = await update(ctx, invoice, { status: result.status, payment });
    report.collections.push({ tenantId: tenant.id, invoiceId: invoice.id, status: result.status, amountUsd: total });
    await note(ctx, { level: result.status === "payment_failed" ? "escalation" : "info", tenantId: tenant.id, action: `payment_${result.status}`,
      message: `Invoice ${invoice.id} ($${total}) for ${tenant.name}: ${result.status}${result.error ? ` (${result.error})` : ""}` });
  }
}

/** Apply a verified payment-provider event. */
export async function applyPaymentEvent(ctx, event) {
  if (event.type === "card_saved") {
    const tenant = await ctx.tenants.setBilling(event.tenantId, event.billing);
    if (tenant) await note(ctx, { level: "info", tenantId: tenant.id, action: "card_saved", message: `${tenant.name} saved a ${event.billing.cardBrand || "card"} ending ${event.billing.cardLast4 || "????"}` });
    return;
  }
  if (event.type !== "payment_succeeded" && event.type !== "payment_failed") return;
  const invoice = latestInvoices(await ctx.invoices.all()).find((i) => i.id === event.invoiceId);
  if (!invoice || invoice.status === "paid") return;
  if (event.type === "payment_succeeded") {
    await update(ctx, invoice, { status: "paid", payment: { ...(invoice.payment || {}), status: "paid", paidAt: new Date().toISOString(), providerRef: event.providerRef } });
    await note(ctx, { level: "info", tenantId: invoice.tenantId, action: "payment_paid", message: `Invoice ${invoice.id} paid` });
  } else if (invoice.status !== "payment_failed") {
    await update(ctx, invoice, { status: "payment_failed", payment: { ...(invoice.payment || {}), error: event.error } });
  }
}
