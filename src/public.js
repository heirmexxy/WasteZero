import { signToken, verifyToken, link } from "./tokens.js";
import { applyPaymentEvent, cardSetupUrl } from "./collections.js";
import { note } from "./operator.js";
import { escapeHtml, clientIp } from "./util.js";

// Public pages: self-serve signup, card setup, unsubscribe, payment webhooks. No bearer key here.

const page = (title, body) => `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title><style>
body{font:16px/1.55 system-ui,sans-serif;max-width:620px;margin:48px auto;padding:0 20px;color:#16181d}
h1{font-size:26px;margin-bottom:4px}label{display:block;margin:14px 0 4px;font-weight:600}
input{width:100%;padding:10px;border:1px solid #c8ccd4;border-radius:6px;font:inherit;box-sizing:border-box}
button,.btn{display:inline-block;margin-top:18px;padding:11px 18px;background:#16181d;color:#fff;border:0;border-radius:6px;font:inherit;cursor:pointer;text-decoration:none}
code,pre{background:#f2f3f5;border-radius:4px;padding:2px 5px;font-size:14px}pre{padding:12px;overflow:auto}
.muted{color:#5d6370;font-size:14px}.err{color:#b42318}</style></head><body>${body}</body></html>`;

function sendPage(res, status, title, body) {
  res.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  res.end(page(title, body));
}

function readRaw(req, max = 262144) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on("data", (c) => { size += c.length; if (size > max) { reject(Object.assign(new Error("too large"), { status: 413 })); req.destroy(); } else chunks.push(c); });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

// Simple per-IP limit for signups.
const recentSignups = new Map();
function rateLimited(ip, now = Date.now()) {
  const list = (recentSignups.get(ip) || []).filter((t) => now - t < 3600_000);
  if (list.length >= 5) return true;
  list.push(now);
  recentSignups.set(ip, list);
  return false;
}

function signupForm(ref, error = "") {
  return `<h1>WasteZero</h1><p>Lower your AI model bill. Pay only a share of the savings we verify.</p>
<p class="muted">You start in observe-only mode: WasteZero measures your spend and shows where the waste is. Nothing about your traffic changes until you approve it.</p>
${error ? `<p class="err">${escapeHtml(error)}</p>` : ""}
<form method="post" action="/signup"><input type="hidden" name="ref" value="${escapeHtml(ref)}">
<label for="name">Company name</label><input id="name" name="name" required maxlength="120">
<label for="email">Billing email</label><input id="email" name="email" type="email" required>
<label for="website">Website</label><input id="website" name="website" placeholder="example.com" maxlength="200">
<input name="company_url" style="display:none" tabindex="-1" autocomplete="off">
<button type="submit">Create account</button></form>`;
}

export async function handlePublic(ctx, req, res, url) {
  const { config } = ctx;
  const p = url.pathname;

  if (p === "/signup") {
    if (!config.signupEnabled) return sendPage(res, 404, "Not found", "<p>Signup is not open.</p>");
    if (req.method === "GET") return sendPage(res, 200, "Sign up · WasteZero", signupForm(url.searchParams.get("ref") || ""));
    if (req.method !== "POST") return sendPage(res, 405, "Not allowed", "");
    const raw = await readRaw(req, 16384);
    const form = req.headers["content-type"]?.includes("json") ? JSON.parse(raw || "{}") : Object.fromEntries(new URLSearchParams(raw));
    if (form.company_url) return sendPage(res, 200, "Thanks", "<p>Thanks.</p>");   // honeypot
    if (rateLimited(clientIp(req, config))) return sendPage(res, 429, "Slow down", "<p>Too many signups from this address. Try again later.</p>");
    if (ctx.tenants.findByEmail(form.email)) return sendPage(res, 409, "Sign up · WasteZero", signupForm(form.ref || "", "An account already exists for this email. Contact us to recover the key."));
    let created;
    try { created = await ctx.tenants.create({ name: form.name, email: form.email || "", website: form.website || "", source: "signup" }); }
    catch (error) { return sendPage(res, 400, "Sign up · WasteZero", signupForm(form.ref || "", error.message)); }
    const tenant = ctx.tenants.get(created.tenant.id);
    const ref = verifyToken(config, form.ref);
    if (ref?.p) {
      const prospect = ctx.prospects.get(ref.p);
      if (prospect) { await ctx.prospects.set(prospect, "signed_up", { tenantId: tenant.id }, "signed up"); tenant.prospectId = prospect.id; await ctx.tenants.doc.save(); }
    }
    await note(ctx, { level: "escalation", tenantId: tenant.id, action: "signup", message: `New signup: ${tenant.name} (${tenant.billing.email})${ref?.p ? " from outreach" : ""}` });
    const setup = cardSetupUrl(ctx, tenant);
    await ctx.mailer.send({ kind: "welcome", to: tenant.billing.email, subject: "Your WasteZero account",
      text: `Welcome to WasteZero. Point your OpenAI base URL at ${config.publicBaseUrl}/v1 and use the API key shown at signup.${setup ? ` Add a card for billing: ${setup}` : ""}`,
      html: `<p>Welcome to WasteZero.</p><p>Point your OpenAI base URL at <code>${escapeHtml(config.publicBaseUrl)}/v1</code> and use the API key shown at signup.</p>${setup ? `<p><a href="${escapeHtml(setup)}">Add a card for billing</a></p>` : ""}` });
    return sendPage(res, 201, "Welcome · WasteZero", `<h1>You're in</h1>
<p>Your API key (shown once; store it now):</p><pre>${escapeHtml(created.apiKey)}</pre>
<p>Point your app's OpenAI base URL at WasteZero and use this key. Keep your own provider key by sending it in <code>X-Upstream-Authorization</code>:</p>
<pre>client = OpenAI(
  base_url="${escapeHtml(config.publicBaseUrl)}/v1",
  api_key="${escapeHtml(created.apiKey)}",
  default_headers={"X-Upstream-Authorization": "Bearer YOUR_OPENAI_KEY",
                   "X-WasteZero-Tag": "feature-name"})</pre>
<p class="muted">Tag each feature with <code>X-WasteZero-Tag</code> to see cost by feature. See your numbers any time at <code>GET /v1/wastezero/summary</code>.</p>
${setup ? `<a class="btn" href="${escapeHtml(setup)}">Add a card for billing</a><p class="muted">You're only charged when there are verified savings${tenant.policy.monthlyBaseFeeUsd ? " plus the monthly subscription" : ""}.</p>` : ""}`);
  }

  if (p === "/billing/setup" && req.method === "GET") {
    const token = verifyToken(config, url.searchParams.get("token"));
    const tenant = token?.p === "card" && ctx.tenants.get(token.t);
    if (!tenant) return sendPage(res, 400, "Link expired", "<p>This link has expired. Reply to your invoice email for a new one.</p>");
    if (!ctx.payments.enabled) return sendPage(res, 503, "Unavailable", "<p>Card billing is not configured yet.</p>");
    try {
      const { url: checkout } = await ctx.payments.setupLink(tenant, {
        successUrl: `${config.publicBaseUrl}/billing/done`, cancelUrl: `${config.publicBaseUrl}/billing/cancelled`
      });
      res.writeHead(303, { location: checkout, "cache-control": "no-store" });
      return res.end();
    } catch (error) {
      ctx.log.error("card setup failed:", error.message);
      return sendPage(res, 502, "Try again", "<p>We couldn't reach the payment provider. Please try again in a minute.</p>");
    }
  }
  if (p === "/billing/done") {
    const reference = url.searchParams.get("reference") || url.searchParams.get("trxref");
    if (reference && ctx.payments.verifySetup) {
      try {
        const event = await ctx.payments.verifySetup(reference);
        if (event) {
          const tenant = ctx.tenants.get(event.tenantId);
          if (tenant?.billing?.status !== "card_on_file") await applyPaymentEvent(ctx, event);
          return sendPage(res, 200, "Card saved", `<h1>Card saved</h1><p>Your ${escapeHtml(event.billing.cardBrand || "card")} ending ${escapeHtml(event.billing.cardLast4 || "")} is saved. The small setup charge is being refunded. Invoices will be charged automatically.</p>`);
        }
      } catch (error) { ctx.log.error("card setup check failed:", error.message); }
      return sendPage(res, 200, "Not confirmed", "<p>We couldn't confirm the card yet. If you were charged, it will be refunded; please try the link again.</p>");
    }
    return sendPage(res, 200, "Card saved", "<h1>Thank you</h1><p>Your card is being saved. Invoices will be charged to it automatically.</p>");
  }
  if (p === "/billing/cancelled") return sendPage(res, 200, "Cancelled", "<p>No card was saved. You can use the link in your email again at any time.</p>");

  if (p === "/unsubscribe") {
    const token = verifyToken(config, url.searchParams.get("token"));
    if (!token?.e) return sendPage(res, 400, "Link expired", "<p>This link is not valid.</p>");
    await ctx.prospects.suppress({ email: token.e, domain: token.d });
    await note(ctx, { level: "info", action: "unsubscribed", message: `${token.e} unsubscribed` });
    if (req.method === "POST") { res.writeHead(200); return res.end(); }   // one-click (RFC 8058)
    return sendPage(res, 200, "Unsubscribed", "<p>You're unsubscribed. We won't email this address or company again.</p>");
  }

  if (p === "/webhooks/payments" && req.method === "POST") {
    if (!ctx.payments.enabled) { res.writeHead(404); return res.end(); }
    const raw = await readRaw(req);
    let event;
    try { event = await ctx.payments.parseWebhook(raw, req.headers); }
    catch (error) { ctx.log.error("webhook rejected:", error.message); res.writeHead(400); return res.end("invalid"); }
    await applyPaymentEvent(ctx, event);
    res.writeHead(200, { "content-type": "application/json" });
    return res.end('{"received":true}');
  }
  return null;
}

export const PUBLIC_PATHS = new Set(["/signup", "/billing/setup", "/billing/done", "/billing/cancelled", "/unsubscribe", "/webhooks/payments"]);
export { link, signToken };
