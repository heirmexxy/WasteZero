import { layout, sendHtml } from "./ui.js";
import { receiveInbound } from "./agents.js";
import { clientIp, escapeHtml, sha256 } from "./util.js";

// Contact form (/contact) and inbound email (/webhooks/inbound-email): both feed the Inbox agent.
export const CONTACT_PATHS = new Set(["/contact", "/webhooks/inbound-email"]);
const inboxSecret = (config) => config.agents.inboxSecret || sha256("inbox:" + config.adminKey).slice(0, 32);
export { inboxSecret };

const hits = new Map();
const limited = (ip) => { const now = Date.now(); const l = (hits.get(ip) || []).filter((t) => now - t < 3600_000); l.push(now); hits.set(ip, l); return l.length > 5; };

function read(req, max = 200_000) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (c) => { raw += c; if (raw.length > max) { reject(new Error("too large")); req.destroy(); } });
    req.on("end", () => resolve(raw));
    req.on("error", reject);
  });
}
function parse(req, raw) {
  if (String(req.headers["content-type"] || "").includes("json")) { try { return JSON.parse(raw); } catch { return {}; } }
  return Object.fromEntries(new URLSearchParams(raw));
}
const pick = (o, ...keys) => { for (const k of keys) if (o[k] != null && o[k] !== "") return typeof o[k] === "object" ? (o[k].email || o[k].address || JSON.stringify(o[k])) : String(o[k]); return ""; };

const form = (msg = "", err = "") => layout("Contact · WasteZero", `
<div style="max-width:560px"><h1>Talk to us</h1><p class="muted">Questions, a demo, or help connecting. We usually answer within a day.</p>
${msg ? `<p class="ok">${escapeHtml(msg)}</p>` : ""}${err ? `<p class="err">${escapeHtml(err)}</p>` : ""}
<form method="post" action="/contact"><label>Name</label><input name="name" maxlength="120">
<label>Email</label><input name="email" type="email" required><label>Message</label><textarea name="message" required maxlength="5000" style="font-family:inherit;font-size:15px"></textarea>
<input name="website_url" style="display:none" tabindex="-1" autocomplete="off"><button class="btn" type="submit" style="margin-top:14px">Send</button></form></div>`);

export async function handleContact(ctx, req, res, url) {
  const p = url.pathname, m = req.method;
  if (p === "/contact" && m === "GET") return sendHtml(res, 200, form());
  if (p === "/contact" && m === "POST") {
    const f = parse(req, await read(req, 20_000));
    if (f.website_url) return sendHtml(res, 200, form("Thanks, we'll be in touch."));
    if (limited(clientIp(req, ctx.config))) return sendHtml(res, 429, form("", "Too many messages from this address. Try again later."));
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(f.email || "") || !String(f.message || "").trim()) return sendHtml(res, 400, form("", "Please give an email and a message."));
    await receiveInbound(ctx, { from: f.email, name: f.name, subject: `Contact form: ${String(f.name || f.email).slice(0, 80)}`, text: f.message, source: "contact" });
    return sendHtml(res, 200, form("Thanks, we'll be in touch."));
  }
  if (p === "/webhooks/inbound-email" && m === "POST") {
    const secret = req.headers["x-wastezero-inbox-secret"] || url.searchParams.get("secret");
    if (secret !== inboxSecret(ctx.config)) { res.writeHead(401); return res.end(); }
    const b = parse(req, await read(req));
    // Accepts common inbound-email webhook shapes (Postmark, Mailgun, SendGrid, Resend, plain JSON).
    const msg = { from: pick(b, "From", "from", "sender", "FromFull"), subject: pick(b, "Subject", "subject"),
      text: pick(b, "TextBody", "text", "body-plain", "stripped-text", "plain", "body"), source: "email" };
    if (!msg.from || !msg.text) { res.writeHead(400, { "content-type": "application/json" }); return res.end('{"error":"need from and text"}'); }
    await receiveInbound(ctx, msg);
    res.writeHead(200, { "content-type": "application/json" });
    return res.end('{"received":true}');
  }
  return null;
}
