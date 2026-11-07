import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Card billing adapters. Both follow the same shape:
 *   setupLink(tenant)          -> hosted page where the customer saves a card
 *   charge(tenant, invoice)    -> charge the saved card for an invoice
 *   parseWebhook(raw, headers) -> verified event, or throws
 * Webhook events: { type: "card_saved" | "payment_succeeded" | "payment_failed", tenantId, ... }
 */
export function createPayments(ctx) {
  const b = ctx.config.billing;
  if (b.provider === "stripe") return stripe(ctx);
  if (b.provider === "paystack") return paystack(ctx);
  return { name: "none", enabled: false };
}

const safeEq = (a, b) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };
const minorUnits = (ctx, usd) => Math.round(usd * ctx.config.billing.fxRate * 100);

// ------------------------------------------------------------ Stripe

function form(obj, prefix = "", out = new URLSearchParams()) {
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (Array.isArray(v)) v.forEach((item, i) => (typeof item === "object" ? form(item, `${key}[${i}]`, out) : out.append(`${key}[]`, item)));
    else if (typeof v === "object") form(v, key, out);
    else out.append(key, String(v));
  }
  return out;
}

function stripe(ctx) {
  const b = ctx.config.billing;
  const api = async (method, path, params, idempotencyKey) => {
    const res = await ctx.fetch(`${b.stripeApiBase}/v1${path}`, {
      method,
      headers: {
        authorization: `Bearer ${b.stripeSecretKey}`,
        "content-type": "application/x-www-form-urlencoded",
        "stripe-version": "2024-06-20",
        ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {})
      },
      body: params ? form(params).toString() : undefined,
      signal: AbortSignal.timeout(20000)
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.error?.message || `Stripe HTTP ${res.status}`), { declined: res.status === 402, code: data.error?.code });
    return data;
  };

  return {
    name: "stripe", enabled: true,

    async setupLink(tenant, { successUrl, cancelUrl }) {
      let customerId = tenant.billing?.customerId;
      if (!customerId) {
        const c = await api("POST", "/customers", { email: tenant.billing?.email, name: tenant.name, metadata: { tenant_id: tenant.id } }, `cus-${tenant.id}`);
        customerId = c.id;
        await ctx.tenants.setBilling(tenant.id, { customerId });
      }
      const s = await api("POST", "/checkout/sessions", {
        mode: "setup", customer: customerId, payment_method_types: ["card"],
        success_url: successUrl, cancel_url: cancelUrl,
        metadata: { tenant_id: tenant.id }, setup_intent_data: { metadata: { tenant_id: tenant.id } }
      });
      return { url: s.url };
    },

    async charge(tenant, invoice, attempt) {
      const { customerId, paymentMethodId } = tenant.billing || {};
      if (!customerId || !paymentMethodId) return { status: "awaiting_card" };
      const amount = minorUnits(ctx, invoice.totalUsd);
      const key = `${invoice.id}-${attempt}`;
      let stripeInvoiceId = invoice.payment?.providerRef;
      try {
        if (!stripeInvoiceId) {
          const inv = await api("POST", "/invoices", {
            customer: customerId, collection_method: "charge_automatically", auto_advance: "false", currency: b.currency,
            default_payment_method: paymentMethodId, description: `WasteZero ${invoice.period}`,
            metadata: { tenant_id: tenant.id, wastezero_invoice: invoice.id }
          }, `inv-${invoice.id}`);
          stripeInvoiceId = inv.id;
          await api("POST", "/invoiceitems", { customer: customerId, invoice: stripeInvoiceId, amount, currency: b.currency, description: `WasteZero ${invoice.period}: ${invoice.feePct}% of verified savings${invoice.baseFeeUsd ? " + base fee" : ""}` }, `item-${invoice.id}`);
          await api("POST", `/invoices/${stripeInvoiceId}/finalize`, {}, `fin-${invoice.id}`);
        }
        const paid = await api("POST", `/invoices/${stripeInvoiceId}/pay`, {}, `pay-${key}`);
        return { status: paid.status === "paid" ? "paid" : "pending", providerRef: stripeInvoiceId, receiptUrl: paid.hosted_invoice_url || null };
      } catch (error) {
        return { status: "payment_failed", error: error.message, providerRef: stripeInvoiceId || null };
      }
    },

    async parseWebhook(raw, headers) {
      if (!b.stripeWebhookSecret) throw new Error("STRIPE_WEBHOOK_SECRET is not set");
      const sig = String(headers["stripe-signature"] || "");
      const parts = Object.fromEntries(sig.split(",").map((p) => p.split("=")));
      const t = Number(parts.t);
      if (!t || Math.abs(Date.now() / 1000 - t) > 300) throw new Error("Stale or missing signature timestamp");
      const expected = createHmac("sha256", b.stripeWebhookSecret).update(`${t}.${raw}`).digest("hex");
      const candidates = sig.split(",").filter((p) => p.startsWith("v1=")).map((p) => p.slice(3));
      if (!candidates.some((c) => safeEq(c, expected))) throw new Error("Bad signature");
      const event = JSON.parse(raw);
      const obj = event.data?.object || {};
      if (event.type === "checkout.session.completed" && obj.mode === "setup") {
        const si = await api("GET", `/setup_intents/${obj.setup_intent}`);
        const pm = await api("GET", `/payment_methods/${si.payment_method}`);
        await api("POST", `/customers/${obj.customer}`, { invoice_settings: { default_payment_method: pm.id } });
        return { type: "card_saved", tenantId: obj.metadata?.tenant_id, billing: { customerId: obj.customer, paymentMethodId: pm.id, cardBrand: pm.card?.brand, cardLast4: pm.card?.last4 } };
      }
      if (event.type === "invoice.paid") return { type: "payment_succeeded", tenantId: obj.metadata?.tenant_id, invoiceId: obj.metadata?.wastezero_invoice, providerRef: obj.id };
      if (event.type === "invoice.payment_failed") return { type: "payment_failed", tenantId: obj.metadata?.tenant_id, invoiceId: obj.metadata?.wastezero_invoice, providerRef: obj.id, error: obj.last_finalization_error?.message || "payment failed" };
      return { type: "ignored", providerType: event.type };
    }
  };
}

// ------------------------------------------------------------ Paystack

function paystack(ctx) {
  const b = ctx.config.billing;
  const api = async (method, path, body) => {
    const res = await ctx.fetch(`${b.paystackApiBase}${path}`, {
      method,
      headers: { authorization: `Bearer ${b.paystackSecretKey}`, "content-type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20000)
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.status === false) throw new Error(data.message || `Paystack HTTP ${res.status}`);
    return data.data;
  };

  return {
    name: "paystack", enabled: true,

    // Paystack saves a card through a small first charge, which is refunded once the card is saved.
    async setupLink(tenant, { successUrl }) {
      const data = await api("POST", "/transaction/initialize", {
        email: tenant.billing?.email, amount: b.paystackSetupAmountMinor, currency: b.currency.toUpperCase(),
        channels: ["card"], callback_url: successUrl,
        metadata: { tenant_id: tenant.id, purpose: "card_setup" }
      });
      return { url: data.authorization_url };
    },

    // Confirms a card setup when the customer returns from checkout, so a webhook is not required.
    // (A Paystack account has one webhook URL, which may already serve another platform.)
    async verifySetup(reference) {
      const d = await api("GET", `/transaction/verify/${encodeURIComponent(reference)}`);
      const meta = typeof d.metadata === "string" ? JSON.parse(d.metadata || "{}") : d.metadata || {};
      if (d.status !== "success" || meta.purpose !== "card_setup" || !d.authorization?.reusable) return null;
      try { await api("POST", "/refund", { transaction: d.reference }); } catch (error) { ctx.log.error("setup refund failed:", error.message); }
      return { type: "card_saved", tenantId: meta.tenant_id, billing: { authorizationCode: d.authorization.authorization_code, email: d.customer?.email, cardBrand: d.authorization.brand, cardLast4: d.authorization.last4 } };
    },

    async charge(tenant, invoice, attempt) {
      const { authorizationCode, email } = tenant.billing || {};
      if (!authorizationCode) return { status: "awaiting_card" };
      try {
        const data = await api("POST", "/transaction/charge_authorization", {
          authorization_code: authorizationCode, email, amount: minorUnits(ctx, invoice.totalUsd), currency: b.currency.toUpperCase(),
          reference: `${invoice.id}-${attempt}`, metadata: { tenant_id: tenant.id, wastezero_invoice: invoice.id, purpose: "invoice" }
        });
        const status = data.status === "success" ? "paid" : data.status === "failed" ? "payment_failed" : "pending";
        return { status, providerRef: data.reference, error: status === "payment_failed" ? data.gateway_response : null };
      } catch (error) {
        return { status: "payment_failed", error: error.message };
      }
    },

    async parseWebhook(raw, headers) {
      const expected = createHmac("sha512", b.paystackSecretKey).update(raw).digest("hex");
      if (!safeEq(String(headers["x-paystack-signature"] || ""), expected)) throw new Error("Bad signature");
      const event = JSON.parse(raw);
      const d = event.data || {};
      const meta = typeof d.metadata === "string" ? JSON.parse(d.metadata || "{}") : d.metadata || {};
      if (event.event === "charge.success" && meta.purpose === "card_setup") {
        if (!d.authorization?.reusable) return { type: "ignored", providerType: "non-reusable card" };
        try { await api("POST", "/refund", { transaction: d.reference }); } catch (error) { ctx.log.error("setup refund failed:", error.message); }
        return { type: "card_saved", tenantId: meta.tenant_id, billing: { authorizationCode: d.authorization.authorization_code, email: d.customer?.email, cardBrand: d.authorization.brand, cardLast4: d.authorization.last4 } };
      }
      if (event.event === "charge.success" && meta.purpose === "invoice") return { type: "payment_succeeded", tenantId: meta.tenant_id, invoiceId: meta.wastezero_invoice, providerRef: d.reference };
      if (event.event === "charge.failed" && meta.purpose === "invoice") return { type: "payment_failed", tenantId: meta.tenant_id, invoiceId: meta.wastezero_invoice, providerRef: d.reference, error: d.gateway_response };
      return { type: "ignored", providerType: event.event };
    }
  };
}
