import { verifyToken } from "./tokens.js";
import { sha256 } from "./util.js";

/**
 * Telegram alerts with buttons. A customer links a chat from their dashboard (a signed /start link);
 * alerts then arrive with "Pause traffic" and "Resume" buttons that act immediately.
 * Only the linked chat can act for that customer. Webhook calls are checked against a secret token.
 */
export const webhookSecret = (config) => config.telegram.webhookSecret || sha256("tg-webhook:" + config.adminKey).slice(0, 32);
const api = (config, method) => `${config.telegram.apiBase}/bot${config.telegram.botToken}/${method}`;
export const ALERT_BUTTONS = [{ text: "⏸ Pause traffic", data: "pause" }, { text: "▶ Resume", data: "resume" }, { text: "Status", data: "status" }];

export async function tgSend(ctx, chatId, text, buttons = null) {
  if (!ctx.config.telegram.botToken || chatId == null) return false;
  try {
    const r = await ctx.fetch(api(ctx.config, "sendMessage"), {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: text.slice(0, 4000), ...(buttons ? { reply_markup: { inline_keyboard: [buttons.map((b) => ({ text: b.text, callback_data: b.data }))] } } : {}) }),
      signal: AbortSignal.timeout(10000)
    });
    return r.ok;
  } catch (error) { ctx.log.error("telegram send failed:", error.message); return false; }
}

export async function setupTelegramWebhook(ctx) {
  const { telegram, publicBaseUrl } = ctx.config;
  if (!telegram.botToken || !publicBaseUrl.startsWith("https://")) return false;
  try {
    const r = await ctx.fetch(api(ctx.config, "setWebhook"), {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: `${publicBaseUrl}/webhooks/telegram`, secret_token: webhookSecret(ctx.config), allowed_updates: ["message", "callback_query"] }),
      signal: AbortSignal.timeout(10000)
    });
    return r.ok;
  } catch { return false; }
}

function readBody(req) {
  return new Promise((resolve) => {
    let raw = "";
    req.on("data", (c) => { raw += c; if (raw.length > 100_000) req.destroy(); });
    req.on("end", () => { try { resolve(JSON.parse(raw)); } catch { resolve(null); } });
    req.on("error", () => resolve(null));
  });
}

export async function handleTelegram(ctx, req, res) {
  const done = () => { res.writeHead(200, { "content-type": "application/json" }); res.end("{}"); };
  if (!ctx.config.telegram.botToken || req.headers["x-telegram-bot-api-secret-token"] !== webhookSecret(ctx.config)) {
    res.writeHead(401); return res.end();
  }
  const update = await readBody(req);
  if (!update) return done();
  const { note } = await import("./operator.js");

  const msg = update.message;
  if (msg?.text?.startsWith("/start")) {
    const token = msg.text.split(/\s+/)[1];
    const p = verifyToken(ctx.config, token);
    const tenant = p?.k === "tg" ? ctx.tenants.get(p.t) : null;
    if (!tenant) { await tgSend(ctx, msg.chat.id, "This link has expired. Open your WasteZero dashboard → Protection & settings → Connect Telegram."); return done(); }
    await ctx.tenants.setFields(tenant.id, { telegramChatId: msg.chat.id });
    await note(ctx, { actor: "customer", level: "info", tenantId: tenant.id, action: "telegram_linked", message: `${tenant.name} linked Telegram` });
    await tgSend(ctx, msg.chat.id, `Connected to WasteZero for ${tenant.name}. Budget, loop and spike alerts will arrive here, with buttons to pause or resume traffic.`, ALERT_BUTTONS);
    return done();
  }

  const cq = update.callback_query;
  if (cq?.message?.chat?.id != null) {
    const chatId = cq.message.chat.id;
    const tenant = ctx.tenants.findByTelegramChat(chatId);
    let reply = "This chat isn't linked to a WasteZero account.";
    if (tenant) {
      if (cq.data === "pause") {
        await ctx.tenants.setPaused(tenant.id, { at: new Date().toISOString(), reason: "paused from Telegram" });
        await note(ctx, { actor: "customer", level: "info", tenantId: tenant.id, action: "paused", message: `${tenant.name} paused traffic from Telegram` });
        reply = "Traffic paused. Requests get a 429 until you resume.";
      } else if (cq.data === "resume") {
        await ctx.tenants.setPaused(tenant.id, null);
        await note(ctx, { actor: "customer", level: "info", tenantId: tenant.id, action: "resumed", message: `${tenant.name} resumed traffic from Telegram` });
        reply = "Traffic resumed.";
      } else {
        const s = ctx.meter.today(tenant.id);
        reply = `${tenant.paused ? "Paused" : "Running"}. Today $${s.dayUsd.toFixed(2)}, this month $${s.monthUsd.toFixed(2)}.`;
      }
    }
    try {
      await ctx.fetch(api(ctx.config, "answerCallbackQuery"), { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ callback_query_id: cq.id, text: reply.slice(0, 190) }), signal: AbortSignal.timeout(10000) });
    } catch { /* best effort */ }
    await tgSend(ctx, chatId, reply, tenant ? ALERT_BUTTONS : null);
  }
  return done();
}
