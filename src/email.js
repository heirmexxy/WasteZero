/**
 * Email sender. "log" writes to data/outbox.jsonl (default, safe for setup and testing);
 * "resend" sends through the Resend API.
 */
export function createMailer(ctx) {
  const { email } = ctx.config;
  return {
    provider: email.provider,
    async send({ to, subject, html, text, headers = {}, kind }) {
      const message = { to, subject, html, text, headers, kind, from: email.from || `${email.senderName} <noreply@localhost>` };
      if (email.provider === "log") {
        await ctx.outbox.add({ timestamp: new Date().toISOString(), status: "logged", ...message });
        return { ok: true, id: "logged" };
      }
      try {
        const res = await ctx.fetch(`${email.resendApiBase}/emails`, {
          method: "POST",
          headers: { authorization: `Bearer ${email.resendApiKey}`, "content-type": "application/json" },
          body: JSON.stringify({ from: message.from, to: [to], subject, html, text, headers, ...(email.replyTo ? { reply_to: email.replyTo } : {}) }),
          signal: AbortSignal.timeout(15000)
        });
        const data = await res.json().catch(() => ({}));
        await ctx.outbox.add({ timestamp: new Date().toISOString(), status: res.ok ? "sent" : "failed", to, subject, kind, providerId: data.id || null, error: res.ok ? null : data.message || res.status });
        return res.ok ? { ok: true, id: data.id } : { ok: false, error: data.message || `HTTP ${res.status}` };
      } catch (error) {
        await ctx.outbox.add({ timestamp: new Date().toISOString(), status: "failed", to, subject, kind, error: error.message });
        return { ok: false, error: error.message };
      }
    }
  };
}
