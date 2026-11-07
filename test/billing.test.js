import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { startApp } from "./helpers.js";
import { collect } from "../src/collections.js";
import { previousPeriod } from "../src/util.js";

const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

function fakeStripe({ declinePay = false } = {}) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    const u = new URL(url);
    const params = init.body ? Object.fromEntries(new URLSearchParams(init.body)) : {};
    calls.push({ method: init.method || "GET", path: u.pathname, params, idem: init.headers?.["idempotency-key"] });
    if (!u.host.includes("stripe.test")) return json({}, 404);
    const p = u.pathname;
    if (p === "/v1/customers") return json({ id: "cus_1" });
    if (p === "/v1/checkout/sessions") return json({ id: "cs_1", url: "https://checkout.stripe.test/cs_1" });
    if (p === "/v1/setup_intents/seti_1") return json({ id: "seti_1", payment_method: "pm_1" });
    if (p === "/v1/payment_methods/pm_1") return json({ id: "pm_1", card: { brand: "visa", last4: "4242" } });
    if (p === "/v1/customers/cus_1") return json({ id: "cus_1" });
    if (p === "/v1/invoices") return json({ id: "in_1" });
    if (p === "/v1/invoiceitems") return json({ id: "ii_1" });
    if (p === "/v1/invoices/in_1/finalize") return json({ id: "in_1", status: "open" });
    if (p === "/v1/invoices/in_1/pay") return declinePay ? json({ error: { message: "Your card was declined.", code: "card_declined" } }, 402) : json({ id: "in_1", status: "paid", hosted_invoice_url: "https://inv" });
    return json({ error: { message: "unknown " + p } }, 404);
  };
  return { calls, fetch };
}

const stripeEnv = { PAYMENT_PROVIDER: "stripe", STRIPE_SECRET_KEY: "sk_test_x", STRIPE_WEBHOOK_SECRET: "whsec_x", STRIPE_API_BASE: "http://stripe.test",
  PUBLIC_BASE_URL: "http://wz.test", BILLING_REQUIRE_RECONCILIATION: "false" };

function stripeSig(raw, secret = "whsec_x") {
  const t = Math.floor(Date.now() / 1000);
  return `t=${t},v1=${createHmac("sha256", secret).update(`${t}.${raw}`).digest("hex")}`;
}

async function seedSavings(s, tenantId, savingsUsd) {
  const period = previousPeriod();
  await s.ctx.events.add({ tenantId, timestamp: `${period}-15T10:00:00.000Z`, requestedModel: "gpt-4o", status: 200, optimization: "route",
    actualCostUsd: 1, baselineCostUsd: 1 + savingsUsd, savingsUsd });
  return period;
}

test("stripe: invoice emailed with card link, card saved by webhook, card charged once, monthly base fee included", async () => {
  const stripe = fakeStripe();
  const s = await startApp(stripeEnv, { fetch: stripe.fetch });
  const { json: created } = await s.admin("POST", "/admin/tenants", { name: "Acme", email: "billing@acme.test", policy: { revenueSharePct: 20, monthlyBaseFeeUsd: 49 } });
  const tenantId = created.tenant.id;
  const period = await seedSavings(s, tenantId, 1000);

  // Operator drafts last month's invoice, emails it, and finds no card yet.
  let report = await s.app.runOperator();
  assert.equal(report.invoices[0].period, period);
  assert.equal(report.collections[0].status, "awaiting_card");
  const [mail] = await s.ctx.outbox.all();
  assert.equal(mail.to, "billing@acme.test");
  assert.match(mail.html, /Total due: \$249\.00/);
  assert.match(mail.html, /http:\/\/wz\.test\/billing\/setup\?token=/);

  // Customer follows the link and is sent to Stripe's hosted page.
  const setupUrl = mail.html.match(/href="(http:\/\/wz\.test\/billing\/setup\?token=[^"]+)"/)[1].replace(/&amp;/g, "&");
  const redirect = await fetch(s.base + new URL(setupUrl).pathname + new URL(setupUrl).search, { redirect: "manual" });
  assert.equal(redirect.status, 303);
  assert.equal(redirect.headers.get("location"), "https://checkout.stripe.test/cs_1");

  // Stripe confirms the saved card.
  const raw = JSON.stringify({ type: "checkout.session.completed", data: { object: { mode: "setup", setup_intent: "seti_1", customer: "cus_1", metadata: { tenant_id: tenantId } } } });
  const forged = await s.call("POST", "/webhooks/payments", { raw, headers: { "stripe-signature": stripeSig(raw, "wrong") } });
  assert.equal(forged.status, 400);
  const hook = await s.call("POST", "/webhooks/payments", { raw, headers: { "stripe-signature": stripeSig(raw) } });
  assert.equal(hook.status, 200);
  assert.equal(s.ctx.tenants.get(tenantId).billing.cardLast4, "4242");

  // Next pass charges $249 (20% of $1000 + $49 base) exactly once.
  report = await s.app.runOperator();
  assert.equal(report.collections[0].status, "paid");
  const item = stripe.calls.find((c) => c.path === "/v1/invoiceitems");
  assert.equal(item.params.amount, "24900");
  await s.app.runOperator();
  assert.equal(stripe.calls.filter((c) => c.path === "/v1/invoices/in_1/pay").length, 1);
  const inv = (await s.admin("GET", "/admin/invoices")).json.invoices[0];
  assert.equal(inv.status, "paid");

  // A paid invoice cannot be reissued.
  assert.equal((await s.admin("POST", "/admin/reconcile", { tenantId, period, providerBilledUsd: 5 })).status, 409);
  await s.close();
});

test("stripe: declined card retries only after the retry window, then escalates", async () => {
  const stripe = fakeStripe({ declinePay: true });
  const s = await startApp({ ...stripeEnv, BILLING_MAX_ATTEMPTS: "2" }, { fetch: stripe.fetch });
  const { json: created } = await s.admin("POST", "/admin/tenants", { name: "Beta", email: "pay@beta.test" });
  await s.ctx.tenants.setBilling(created.tenant.id, { customerId: "cus_1", paymentMethodId: "pm_1" });
  await seedSavings(s, created.tenant.id, 100);
  const report = { escalations: [], collections: [] };
  await s.app.runOperator();
  const pays = () => stripe.calls.filter((c) => c.path === "/v1/invoices/in_1/pay").length;
  assert.equal(pays(), 1);
  await collect(s.ctx, report);                                           // too soon: no retry
  assert.equal(pays(), 1);
  await collect(s.ctx, report, { now: new Date(Date.now() + 73 * 3600_000) });
  assert.equal(pays(), 2);
  assert.equal(stripe.calls.filter((c) => c.path === "/v1/invoices").length, 1);   // same Stripe invoice reused
  await collect(s.ctx, report, { now: new Date(Date.now() + 150 * 3600_000) });
  assert.equal(pays(), 2);
  assert.ok(report.escalations.some((e) => /unpaid after 2 attempts/.test(e.message)));
  await s.close();
});

test("billing waits for reconciliation when required", async () => {
  const stripe = fakeStripe();
  const s = await startApp({ ...stripeEnv, BILLING_REQUIRE_RECONCILIATION: "true" }, { fetch: stripe.fetch });
  const { json: created } = await s.admin("POST", "/admin/tenants", { name: "Gamma", email: "g@gamma.test" });
  await s.ctx.tenants.setBilling(created.tenant.id, { customerId: "cus_1", paymentMethodId: "pm_1" });
  const period = await seedSavings(s, created.tenant.id, 100);
  let report = await s.app.runOperator();
  assert.equal(report.collections.length, 0);
  assert.equal((await s.ctx.outbox.all()).length, 0);
  await s.admin("POST", "/admin/reconcile", { tenantId: created.tenant.id, period, providerBilledUsd: 1 });
  report = await s.app.runOperator();
  assert.equal(report.collections[0].status, "paid");
  await s.close();
});

test("paystack: card saved through a refunded setup charge, then invoices charged in local currency", async () => {
  const calls = [];
  const fetch = async (url, init = {}) => {
    const u = new URL(url);
    const body = init.body ? JSON.parse(init.body) : {};
    calls.push({ path: u.pathname, body });
    if (u.pathname === "/transaction/initialize") return json({ status: true, data: { authorization_url: "https://checkout.paystack.test/abc", reference: "ref1" } });
    if (u.pathname === "/refund") return json({ status: true, data: {} });
    if (u.pathname === "/transaction/charge_authorization") return json({ status: true, data: { status: "success", reference: body.reference } });
    return json({ status: false, message: "unknown" }, 404);
  };
  const s = await startApp({ PAYMENT_PROVIDER: "paystack", PAYSTACK_SECRET_KEY: "sk_ps", PAYSTACK_API_BASE: "http://paystack.test", PUBLIC_BASE_URL: "http://wz.test",
    BILLING_CURRENCY: "ngn", BILLING_FX_RATE: "1600", BILLING_REQUIRE_RECONCILIATION: "false" }, { fetch });
  const { json: created } = await s.admin("POST", "/admin/tenants", { name: "Naija AI", email: "fin@naija.test" });
  const tenantId = created.tenant.id;
  const { url } = (await s.admin("POST", `/admin/tenants/${tenantId}/card-link`)).json;
  const redirect = await globalThis.fetch(url.replace("http://wz.test", s.base), { redirect: "manual" });
  assert.equal(redirect.headers.get("location"), "https://checkout.paystack.test/abc");
  assert.equal(calls.find((c) => c.path === "/transaction/initialize").body.currency, "NGN");

  const raw = JSON.stringify({ event: "charge.success", data: { reference: "ref1", metadata: { tenant_id: tenantId, purpose: "card_setup" },
    authorization: { authorization_code: "AUTH_x", reusable: true, last4: "4081", brand: "visa" }, customer: { email: "fin@naija.test" } } });
  const sig = createHmac("sha512", "sk_ps").update(raw).digest("hex");
  assert.equal((await s.call("POST", "/webhooks/payments", { raw, headers: { "x-paystack-signature": "bad" } })).status, 400);
  assert.equal((await s.call("POST", "/webhooks/payments", { raw, headers: { "x-paystack-signature": sig } })).status, 200);
  assert.ok(calls.some((c) => c.path === "/refund" && c.body.transaction === "ref1"));
  assert.equal(s.ctx.tenants.get(tenantId).billing.status, "card_on_file");
  // Card details never leak through the admin API.
  assert.equal(JSON.stringify((await s.admin("GET", "/admin/tenants")).json).includes("AUTH_x"), false);

  await seedSavings(s, tenantId, 50);
  const report = await s.app.runOperator();
  assert.equal(report.collections[0].status, "paid");
  const charge = calls.find((c) => c.path === "/transaction/charge_authorization").body;
  assert.equal(charge.amount, 10 * 1600 * 100);   // $10 fee -> NGN 16,000 in kobo
  assert.equal(charge.authorization_code, "AUTH_x");
  await s.close();
});
