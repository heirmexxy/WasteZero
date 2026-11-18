import { randomBytes } from "node:crypto";
import { signToken, verifyToken } from "./tokens.js";
import { layout, sendHtml } from "./ui.js";
import { escapeHtml, clientIp, sha256 } from "./util.js";

/**
 * Sign-in for customers and admins, kept in a signed, HttpOnly cookie.
 * Customers: a one-time emailed link (15 minutes), or their API key as a fallback.
 * Admins: the admin key.
 * Changes made from the dashboards must carry the X-WZ-UI header; a browser cannot add a custom
 * header to a request from another site without CORS, which WasteZero never grants.
 */
export const CUSTOMER_COOKIE = "wz_s";
export const ADMIN_COOKIE = "wz_a";
const DAY = 86400;

function cookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function cookieHeader(config, name, value, maxAge) {
  const secure = String(config.publicBaseUrl || "").startsWith("https://") ? "; Secure" : "";
  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}

const adminFingerprint = (config) => sha256("admin-session:" + config.adminKey).slice(0, 16);

export function customerFromSession(ctx, req) {
  const p = verifyToken(ctx.config, cookies(req)[CUSTOMER_COOKIE]);
  if (p?.k !== "cs") return null;
  const t = ctx.tenants.get(p.t);
  return t?.active && (t.sessionVersion || 0) === (p.v || 0) ? t : null;
}

export function isAdminSession(ctx, req) {
  const p = verifyToken(ctx.config, cookies(req)[ADMIN_COOKIE]);
  return p?.k === "as" && p.f === adminFingerprint(ctx.config);
}

/** Mutations from the dashboards must carry this header (blocks cross-site form posts). */
export const fromDashboard = (req) => req.headers["x-wz-ui"] === "1";

export const startCustomerSession = (ctx, tenant) =>
  cookieHeader(ctx.config, CUSTOMER_COOKIE, signToken(ctx.config, { k: "cs", t: tenant.id, v: tenant.sessionVersion || 0 }, 14 * DAY), 14 * DAY);
export const startAdminSession = (ctx) =>
  cookieHeader(ctx.config, ADMIN_COOKIE, signToken(ctx.config, { k: "as", f: adminFingerprint(ctx.config) }, 12 * 3600), 12 * 3600);
export const clearCookie = (ctx, name) => cookieHeader(ctx.config, name, "", 0);

// ------------------------------------------------------------ pages

// Attempt limits per visitor address and purpose, over 15 minutes. Key sign-ins count failures only.
const attempts = new Map();
const recent = (key) => (attempts.get(key) || []).filter((t) => Date.now() - t < 15 * 60_000);
const tooMany = (key, max) => recent(key).length >= max;
const count = (key) => attempts.set(key, [...recent(key), Date.now()]);
const usedLinks = new Map();   // one-time links: nonce → expiry

function readForm(req, max = 8192) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (c) => { raw += c; if (raw.length > max) { reject(new Error("too large")); req.destroy(); } });
    req.on("end", () => resolve(Object.fromEntries(new URLSearchParams(raw))));
    req.on("error", reject);
  });
}

function signinPage({ message = "", error = "", email = "" } = {}) {
  return layout("Sign in · WasteZero", `
<div style="max-width:440px">
<h1>Sign in</h1>
<p class="muted">For companies with a WasteZero account. We email a one-time link to the address you signed up with.</p>
${message ? `<p class="ok">${escapeHtml(message)}</p>` : ""}${error ? `<p class="err">${escapeHtml(error)}</p>` : ""}
<form method="post" action="/signin">
<label for="email">The email you signed up with</label><input id="email" name="email" type="email" required value="${escapeHtml(email)}" autocomplete="email">
<button class="btn" type="submit" style="margin-top:14px">Email me a sign-in link</button>
</form>
<details style="margin-top:28px"><summary class="small muted">Sign in with an API key instead</summary>
<form method="post" action="/signin/key">
<label for="key">WasteZero API key</label><input id="key" name="apiKey" type="password" placeholder="wz_..." autocomplete="off" required>
<button class="btn alt" type="submit" style="margin-top:14px">Sign in</button>
</form></details>
<p style="margin-top:28px">No account yet? <a href="/signup"><strong>Create one</strong></a> (free audit first, pay only from savings).</p>
<p class="small muted">Employee with an AI budget? <a href="/me/signin">See my budget</a> · WasteZero staff: <a href="/console">Admin console</a></p>
</div>`);
}

export const ACCOUNT_PATHS = new Set(["/signin", "/signin/key", "/signin/verify", "/signout", "/console/signin", "/console/signin/email", "/console/signin/verify", "/console/signout"]);

export async function handleAccounts(ctx, req, res, url) {
  const { config } = ctx;
  const p = url.pathname, m = req.method;
  const ip = clientIp(req, config);

  if (p === "/signin" && m === "GET") {
    if (customerFromSession(ctx, req)) { res.writeHead(303, { location: "/app" }); return res.end(); }
    return sendHtml(res, 200, signinPage());
  }
  if (p === "/signin" && m === "POST") {
    if (tooMany(`link:${ip}`, 10)) return sendHtml(res, 429, signinPage({ error: "Too many attempts. Try again in 15 minutes." }));
    count(`link:${ip}`);
    const form = await readForm(req);
    const email = String(form.email || "").trim().toLowerCase();
    const tenant = email && ctx.tenants.findByEmail(email);
    if (tenant?.active) {
      const nonce = randomBytes(9).toString("base64url");
      const token = signToken(config, { k: "ml", t: tenant.id, n: nonce }, 15 * 60);
      const link = `${config.publicBaseUrl}/signin/verify?token=${encodeURIComponent(token)}`;
      await ctx.mailer.send({ kind: "signin", to: email, subject: "Your WasteZero sign-in link",
        text: `Sign in to WasteZero: ${link}\n\nThe link works once, for 15 minutes. If you didn't ask for it, ignore this email.`,
        html: `<p><a href="${escapeHtml(link)}">Sign in to WasteZero</a></p><p style="color:#666">The link works once, for 15 minutes. If you didn't ask for it, ignore this email.</p>` });
    }
    // Same answer either way, so the form can't be used to find out who is a customer.
    return sendHtml(res, 200, signinPage({ message: "If that email has an account, a sign-in link is on its way. Check your inbox (and spam). No email after a few minutes? You may not have an account yet: create one below.", email }));
  }
  if (p === "/signin/verify" && m === "GET") {
    const payload = verifyToken(config, url.searchParams.get("token"));
    const now = Date.now();
    for (const [n, exp] of usedLinks) if (exp < now) usedLinks.delete(n);
    if (payload?.k !== "ml" || usedLinks.has(payload.n)) return sendHtml(res, 400, signinPage({ error: "That link has expired or was already used. Ask for a new one." }));
    usedLinks.set(payload.n, payload.exp * 1000);
    const tenant = ctx.tenants.get(payload.t);
    if (!tenant?.active) return sendHtml(res, 400, signinPage({ error: "That account is not active." }));
    res.writeHead(303, { location: "/app", "set-cookie": startCustomerSession(ctx, tenant) });
    return res.end();
  }
  if (p === "/signin/key" && m === "POST") {
    if (tooMany(`key:${ip}`, 10)) return sendHtml(res, 429, signinPage({ error: "Too many attempts. Try again in 15 minutes." }));
    const form = await readForm(req);
    const tenant = ctx.tenants.findByKey(String(form.apiKey || "").trim());
    if (!tenant) { count(`key:${ip}`); return sendHtml(res, 401, signinPage({ error: "That key wasn't recognised." })); }
    res.writeHead(303, { location: "/app", "set-cookie": startCustomerSession(ctx, tenant) });
    return res.end();
  }
  if (p === "/signout") {
    res.writeHead(303, { location: "/signin", "set-cookie": clearCookie(ctx, CUSTOMER_COOKIE) });
    return res.end();
  }

  if (p === "/console/signin/email" && m === "POST") {
    const adminEmail = config.agents?.adminEmail;
    if (tooMany(`alink:${ip}`, 5)) return sendHtml(res, 429, adminSigninPage("Too many attempts. Try again in 15 minutes.", adminEmail));
    count(`alink:${ip}`);
    const form = await readForm(req);
    const email = String(form.email || "").trim().toLowerCase();
    if (adminEmail && email === adminEmail && config.adminKey) {
      const nonce = randomBytes(9).toString("base64url");
      const token = signToken(config, { k: "al", f: adminFingerprint(config), n: nonce }, 15 * 60);
      const link = `${config.publicBaseUrl}/console/signin/verify?token=${encodeURIComponent(token)}`;
      await ctx.mailer.send({ kind: "admin-signin", to: email, subject: "WasteZero admin sign-in link",
        text: `Sign in to the WasteZero admin console: ${link}\n\nThe link works once, for 15 minutes. If you didn't ask for it, someone tried to sign in as admin. Ignore this email.`,
        html: `<p><a href="${escapeHtml(link)}">Sign in to the WasteZero admin console</a></p><p style="color:#666">The link works once, for 15 minutes. If you didn't ask for it, ignore this email.</p>` });
    }
    return sendHtml(res, 200, adminSigninPage("", adminEmail, "If that is the admin email, a sign-in link is on its way. Check your inbox (and spam)."));
  }
  if (p === "/console/signin/verify" && m === "GET") {
    const payload = verifyToken(config, url.searchParams.get("token"));
    const now = Date.now();
    for (const [n, exp] of usedLinks) if (exp < now) usedLinks.delete(n);
    if (payload?.k !== "al" || payload.f !== adminFingerprint(config) || usedLinks.has(payload.n))
      return sendHtml(res, 400, adminSigninPage("That link has expired or was already used. Ask for a new one.", config.agents?.adminEmail));
    usedLinks.set(payload.n, payload.exp * 1000);
    res.writeHead(303, { location: "/console", "set-cookie": startAdminSession(ctx) });
    return res.end();
  }
  if (p === "/console/signin" && m === "POST") {
    if (tooMany(`admin:${ip}`, 5)) return sendHtml(res, 429, adminSigninPage("Too many attempts. Try again in 15 minutes.", config.agents?.adminEmail));
    const form = await readForm(req);
    const { timingSafeEqual } = await import("node:crypto");
    const a = Buffer.from(String(form.adminKey || "")), b = Buffer.from(config.adminKey || "");
    if (!config.adminKey || a.length !== b.length || !timingSafeEqual(a, b)) { count(`admin:${ip}`); return sendHtml(res, 401, adminSigninPage("That admin key is not right.", config.agents?.adminEmail)); }
    res.writeHead(303, { location: "/console", "set-cookie": startAdminSession(ctx) });
    return res.end();
  }
  if (p === "/console/signout") {
    res.writeHead(303, { location: "/console", "set-cookie": clearCookie(ctx, ADMIN_COOKIE) });
    return res.end();
  }
  return null;
}

export function adminSigninPage(error = "", adminEmail = "", message = "") {
  const keyForm = `<form method="post" action="/console/signin">
<label for="k">Admin key</label><input id="k" name="adminKey" type="password" required autocomplete="off">
<p class="tiny muted">On the server: <code>cat /root/wastezero-admin-key.txt</code></p>
<button class="btn${adminEmail ? " alt" : ""}" type="submit">Sign in</button></form>`;
  return layout("Admin · WasteZero", `
<div style="max-width:440px"><h1>Admin console</h1>
${message ? `<p class="ok">${escapeHtml(message)}</p>` : ""}${error ? `<p class="err">${escapeHtml(error)}</p>` : ""}
${adminEmail ? `<form method="post" action="/console/signin/email">
<label for="e">Admin email</label><input id="e" name="email" type="email" required autocomplete="email">
<button class="btn" type="submit" style="margin-top:14px">Email me a sign-in link</button></form>
<details style="margin-top:28px"><summary class="small muted">Use the admin key instead</summary>${keyForm}</details>` : keyForm}
</div>`);
}
