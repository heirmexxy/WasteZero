import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { layout, sendHtml } from "./ui.js";
import { escapeHtml, clientIp } from "./util.js";
import { signToken } from "./tokens.js";
import { note } from "./operator.js";
import {
  orgOf, teamsReport, importPeople, personByEmail, person, personBudget, requestException, decideException, approvalPlan,
  describeTerm, sealSecret, meLink, personFromToken, exceptionFromToken, isEmail, round
} from "./teams.js";

// Web side of WasteZero for Teams:
//   /app/api/teams/*   the company admin (signed-in customer) runs budgets, people and approvals
//   /me                an employee sees their budget, asks for more, gets their own key
//   /teams/approve     a manager / exec / finance approves or declines from the link in their email

export const TEAMS_PATHS = new Set(["/me", "/me/signin", "/me/request", "/me/key", "/teams/approve", "/app/teams.js"]);
const CLIENT_JS = readFileSync(fileURLToPath(new URL("./teams-client.js", import.meta.url)), "utf8");

const readForm = (req, max = 16384) => new Promise((resolve, reject) => {
  let raw = "";
  req.on("data", (c) => { raw += c; if (raw.length > max) { reject(new Error("too large")); req.destroy(); } });
  req.on("end", () => resolve(Object.fromEntries(new URLSearchParams(raw))));
  req.on("error", reject);
});

const hits = new Map();
function limited(key, max, windowMs = 15 * 60_000) {
  const now = Date.now();
  const list = (hits.get(key) || []).filter((t) => now - t < windowMs);
  list.push(now); hits.set(key, list);
  if (hits.size > 20000) hits.delete(hits.keys().next().value);
  return list.length > max;
}

const usd = (n) => `$${Number(n || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const PROVIDER_NAME = /^[a-z0-9-]{2,24}$/;

// ------------------------------------------------------------ company admin API

export async function handleTeamsApi(ctx, req, res, tenant, api, { json, readJson }) {
  const m = req.method;
  const o = orgOf(tenant);
  const save = () => ctx.tenants.doc.save();
  const body = async () => { try { return await readJson(req); } catch (e) { json(res, 400, { error: e.message }); return null; } };

  if (m === "GET" && api === "/teams") return json(res, 200, teamsReport(ctx, tenant));

  if (m === "PATCH" && api === "/teams/settings") {
    const b = await body(); if (!b) return;
    const s = o.settings;
    try {
      if ("enabled" in b) o.enabled = !!b.enabled;
      if ("onLimit" in b) { if (!["downgrade", "block"].includes(b.onLimit)) throw new Error("onLimit is downgrade or block"); s.onLimit = b.onLimit; }
      if ("usePool" in b) s.usePool = !!b.usePool;
      if ("privacyMode" in b) s.privacyMode = !!b.privacyMode;
      if ("alertPcts" in b) {
        const a = [...new Set((Array.isArray(b.alertPcts) ? b.alertPcts : String(b.alertPcts).split(",")).map(Number))].filter((x) => x > 0 && x <= 200);
        if (!a.length) throw new Error("Give at least one alert percentage, e.g. 80, 100"); s.alertPcts = a.sort((x, y) => x - y);
      }
      if ("slackWebhookUrl" in b) {
        const u = String(b.slackWebhookUrl || "").trim();
        if (u && !/^https:\/\/hooks\.slack\.com\/[\w/-]+$/.test(u)) throw new Error("The Slack link must be an incoming-webhook URL (https://hooks.slack.com/...)");
        s.slackWebhookUrl = u;
      }
      for (const k of ["execEmails", "financeEmails"]) if (k in b) {
        const list = (Array.isArray(b[k]) ? b[k] : String(b[k] || "").split(/[,\s]+/)).map((e) => String(e).trim().toLowerCase()).filter(Boolean);
        const bad = list.find((e) => !isEmail(e)); if (bad) throw new Error(`"${bad}" is not an email`);
        s[k] = list.slice(0, 10);
      }
      if ("fallbackModels" in b) {
        const f = b.fallbackModels || {};
        if (typeof f !== "object" || Array.isArray(f) || Object.values(f).some((v) => typeof v !== "string")) throw new Error("fallbackModels maps a model (or prefix) to a cheaper model");
        s.fallbackModels = f;
      }
    } catch (e) { return json(res, 400, { error: e.message }); }
    await save();
    await note(ctx, { actor: `customer:${tenant.id}`, action: "teams_settings", tenantId: tenant.id, message: `Teams settings changed: ${Object.keys(b).join(", ")}` });
    return json(res, 200, teamsReport(ctx, tenant));
  }

  if (m === "PUT" && api === "/teams/roles") {
    const b = await body(); if (!b) return;
    const roles = Array.isArray(b.roles) ? b.roles : null;
    if (!roles?.length || roles.length > 50) return json(res, 400, { error: "Send 1 to 50 roles" });
    const clean = [];
    for (const r of roles) {
      const id = String(r.id || r.name || "").toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);
      const v = Number(r.monthlyUsd);
      if (!id || !Number.isFinite(v) || v < 0) return json(res, 400, { error: `Role "${r.name || r.id}" needs a name and a monthly budget of 0 or more` });
      clean.push({ id, name: String(r.name || id).slice(0, 40), monthlyUsd: round(v) });
    }
    const inUse = new Set(o.people.filter((p) => p.active !== false).map((p) => p.roleId));
    const removed = o.roles.filter((r) => !clean.some((c) => c.id === r.id) && inUse.has(r.id));
    if (removed.length) return json(res, 400, { error: `Role "${removed[0].name}" still has people. Move them first.` });
    o.roles = clean;
    await save();
    return json(res, 200, teamsReport(ctx, tenant));
  }

  if (m === "POST" && api === "/teams/import") {
    const b = await body(); if (!b) return;
    let result;
    try { result = importPeople(o, b.csv, { deactivateMissing: !!b.deactivateMissing }); } catch (e) { return json(res, 400, { error: e.message }); }
    for (const p of o.people) if (p.active === false) await ctx.tenants.revokePersonKeys(tenant.id, p.id);
    await save();
    await note(ctx, { actor: `customer:${tenant.id}`, action: "teams_import", tenantId: tenant.id, message: `Imported people: +${result.added}, updated ${result.updated}, deactivated ${result.deactivated}` });
    return json(res, 200, { result, report: teamsReport(ctx, tenant) });
  }

  let match = api.match(/^\/teams\/people\/(p_[a-f0-9]+)$/);
  if (m === "PATCH" && match) {
    const p = o.people.find((q) => q.id === match[1]);
    if (!p) return json(res, 404, { error: "Not found" });
    const b = await body(); if (!b) return;
    if ("roleId" in b) { if (!o.roles.some((r) => r.id === b.roleId)) return json(res, 400, { error: "Unknown role" }); p.roleId = b.roleId; }
    if ("monthlyUsd" in b) { if (b.monthlyUsd === null || b.monthlyUsd === "") delete p.monthlyUsd; else { const v = Number(b.monthlyUsd); if (!Number.isFinite(v) || v < 0) return json(res, 400, { error: "Budget must be 0 or more" }); p.monthlyUsd = round(v); } }
    if ("managerEmail" in b) { const mgr = b.managerEmail ? personByEmail(o, b.managerEmail) : null; if (b.managerEmail && !mgr) return json(res, 400, { error: "Manager not found among your people" }); p.managerId = mgr && mgr.id !== p.id ? mgr.id : null; }
    if (b.active === false) { p.active = false; await ctx.tenants.revokePersonKeys(tenant.id, p.id); }
    await save();
    return json(res, 200, teamsReport(ctx, tenant));
  }

  match = api.match(/^\/teams\/people\/(p_[a-f0-9]+)\/(key|invite)$/);
  if (m === "POST" && match) {
    const p = person(o, match[1]);
    if (!p) return json(res, 404, { error: "Not found" });
    if (match[2] === "key") {
      const { apiKey } = await ctx.tenants.personKey(tenant.id, p);
      await note(ctx, { actor: `customer:${tenant.id}`, action: "teams_person_key", tenantId: tenant.id, message: `Key created for ${p.email}` });
      return json(res, 200, { apiKey, email: p.email });
    }
    await invite(ctx, tenant, p);
    return json(res, 200, { ok: true });
  }

  if (m === "POST" && api === "/teams/invite-all") {
    const todo = o.people.filter((p) => p.active !== false && !p.keyId);
    for (const p of todo.slice(0, 500)) await invite(ctx, tenant, p);
    return json(res, 200, { invited: Math.min(todo.length, 500) });
  }

  match = api.match(/^\/teams\/exceptions\/(ex_[a-f0-9]+)\/(approve|decline)$/);
  if (m === "POST" && match) {
    try { await decideException(ctx, tenant, match[1], "admin", match[2]); } catch (e) { return json(res, 400, { error: e.message }); }
    return json(res, 200, teamsReport(ctx, tenant));
  }

  if (m === "PUT" && api === "/teams/provider-keys") {
    const b = await body(); if (!b) return;
    const name = String(b.provider || "").toLowerCase().trim(), key = String(b.key || "").trim();
    if (!PROVIDER_NAME.test(name) || key.length < 10 || key.length > 400) return json(res, 400, { error: "Give the provider (e.g. anthropic, openai) and its API key" });
    o.providerKeys = { ...(o.providerKeys || {}), [name]: sealSecret(ctx.config, key) };
    await save();
    await note(ctx, { actor: `customer:${tenant.id}`, action: "teams_provider_key", tenantId: tenant.id, message: `Stored ${name} key (encrypted)` });
    return json(res, 200, teamsReport(ctx, tenant));
  }
  match = api.match(/^\/teams\/provider-keys\/([a-z0-9-]{2,24})$/);
  if (m === "DELETE" && match) {
    if (o.providerKeys) delete o.providerKeys[match[1]];
    await save();
    return json(res, 200, teamsReport(ctx, tenant));
  }

  return json(res, 404, { error: "Not found" });
}

async function invite(ctx, tenant, p) {
  const link = meLink(ctx, tenant, p, 7 * 86400);
  await ctx.mailer.send({ kind: "team-invite", to: p.email, subject: `${tenant.name}: your AI budget and WasteZero key`,
    text: `${tenant.name} uses WasteZero to manage AI spend. Your monthly AI budget is ${usd(personBudget(orgOf(tenant), p).total)}.\n\nGet your own key and set up Claude Code, Cursor or your scripts here (link valid 7 days): ${link}\n\nWasteZero moves routine requests to cheaper models and reuses answers, so your budget goes further.` });
}

// ------------------------------------------------------------ employee and approver pages

function mePage(ctx, tenant, p, token, { message = "", error = "", apiKey = "" } = {}) {
  const o = orgOf(tenant);
  const b = personBudget(o, p);
  const used = round(ctx.meter.month(tenant.id).person(p.id));
  const pct = b.total > 0 ? Math.min(100, Math.round(used / b.total * 100)) : 0;
  const role = o.roles.find((r) => r.id === p.roleId);
  const mine = o.exceptions.filter((x) => x.personId === p.id).slice(-5).reverse();
  const base = ctx.config.publicBaseUrl;
  const plan20 = round(b.base * 0.2);
  const setup = apiKey ? `
<div class="notice"><strong>Your key (copy it now; it won't be shown again):</strong><pre>${escapeHtml(apiKey)}</pre>Creating a new key replaces this one.</div>
<h3>Claude Code</h3><pre>export ANTHROPIC_BASE_URL=${escapeHtml(base)}
export ANTHROPIC_API_KEY=${escapeHtml(apiKey)}</pre>
<h3>Cursor, OpenAI SDK and other OpenAI-compatible tools</h3><pre>Base URL: ${escapeHtml(base)}/v1
API key:  ${escapeHtml(apiKey)}</pre>
<h3>Anthropic SDK</h3><pre>Anthropic(base_url="${escapeHtml(base)}", api_key="${escapeHtml(apiKey)}")</pre>
${Object.keys(o.providerKeys || {}).length ? "" : `<p class="small muted">Your company hasn't stored a provider key in WasteZero yet, so also send your own: header <code>X-Upstream-Authorization: &lt;your provider key&gt;</code>.</p>`}` : "";
  return layout("My AI budget · WasteZero", `
<div style="max-width:620px"><h1>My AI budget</h1>
<p class="muted">${escapeHtml(p.name || p.email)} · ${escapeHtml(tenant.name)} · ${escapeHtml(role?.name || "")}</p>
${message ? `<p class="ok">${escapeHtml(message)}</p>` : ""}${error ? `<p class="err">${escapeHtml(error)}</p>` : ""}
<div class="card"><h3>This month</h3>
<p style="font-size:28px;margin:4px 0"><strong>${usd(used)}</strong> <span class="muted" style="font-size:16px">of ${usd(b.total)}</span></p>
<div style="background:#eef0f3;border-radius:99px;height:10px;overflow:hidden"><div style="height:10px;width:${pct}%;background:${pct >= 100 ? "var(--bad)" : pct >= 80 ? "var(--warn)" : "var(--accent)"}"></div></div>
<p class="small muted">${b.extra ? `Includes ${usd(b.extra)} of approved extra budget. ` : ""}${o.settings.onLimit === "block" ? "At your limit, requests stop until more is approved" : "At your limit, requests move to a cheaper model"}${o.settings.usePool ? ", unless your team has budget to spare" : ""}.</p></div>
${setup}
<form method="post" action="/me/key" class="card"><input type="hidden" name="token" value="${escapeHtml(token)}">
<h3>Your WasteZero key</h3><p class="small muted">${p.keyId ? "You have a key. Create a new one if you lost it (the old one stops working)." : "Use it in Claude Code, Cursor or your scripts instead of a provider key."}</p>
<button class="btn ${p.keyId ? "alt" : ""}" type="submit">${p.keyId ? "Replace my key" : "Create my key"}</button></form>
<form method="post" action="/me/request" class="card"><input type="hidden" name="token" value="${escapeHtml(token)}">
<h3>Ask for more budget</h3>
<p class="small muted">Up to ${usd(plan20)} more this month: your manager's manager approves. Up to ${usd(b.base * 2)} more for 90 days: one level higher, with an ROI note. More than that: an executive and finance.</p>
<label>Extra dollars per month</label><input name="amountUsd" type="number" min="1" step="1" required>
<label>What it's for</label><textarea name="reason" rows="2" required maxlength="1000"></textarea>
<label>ROI (needed above ${usd(plan20)}): what will it produce, and why is it worth it?</label><textarea name="roi" rows="3" maxlength="1500"></textarea>
<button class="btn" type="submit" style="margin-top:12px">Send request</button></form>
${mine.length ? `<h3>Your requests</h3><table><tr><th>Amount</th><th>Status</th><th>Term</th></tr>${mine.map((x) => `<tr><td>${usd(x.amountUsd)}</td><td><span class="tag ${x.state === "approved" ? "" : x.state === "pending" ? "warn" : "grey"}">${escapeHtml(x.state)}</span></td><td class="small">${escapeHtml(describeTerm(x))}${x.expiresAt ? ` · until ${x.expiresAt.slice(0, 10)}` : ""}</td></tr>`).join("")}</table>` : ""}
<p class="small muted" style="margin-top:20px">Tip: match the model to the task. Smaller models handle drafting, summaries and simple edits well, and leave more budget for hard problems.</p>
</div>`);
}

const signinPage = (message = "", error = "") => layout("My AI budget · WasteZero", `
<div style="max-width:440px"><h1>My AI budget</h1><p class="muted">For employees of companies that use WasteZero for Teams.</p>
${message ? `<p class="ok">${escapeHtml(message)}</p>` : ""}${error ? `<p class="err">${escapeHtml(error)}</p>` : ""}
<form method="post" action="/me/signin"><label for="e">Work email</label><input id="e" name="email" type="email" required autocomplete="email">
<button class="btn" type="submit" style="margin-top:14px">Email me a link</button></form></div>`);

function approvePage(ctx, tenant, x, approver, token, { message = "", error = "" } = {}) {
  const o = orgOf(tenant);
  const p = o.people.find((q) => q.id === x.personId);
  const b = p ? personBudget(o, p) : { base: 0, total: 0 };
  const used = p ? round(ctx.meter.month(tenant.id).person(p.id)) : 0;
  const mine = x.groups.find((g) => g.emails.includes(approver));
  const canAct = x.state === "pending" && mine && !mine.approvedBy;
  return layout("Approve AI budget · WasteZero", `
<div style="max-width:560px"><h1>AI budget request</h1>
${message ? `<p class="ok">${escapeHtml(message)}</p>` : ""}${error ? `<p class="err">${escapeHtml(error)}</p>` : ""}
<div class="card"><p><strong>${escapeHtml(p?.name || p?.email || "Someone")}</strong> asks for <strong>${usd(x.amountUsd)}</strong> more per month (${escapeHtml(describeTerm(x))}).</p>
<p class="small">Budget ${usd(b.base)}/month · spent ${o.settings.privacyMode ? "(private)" : usd(used)} this month</p>
<p><strong>What for:</strong> ${escapeHtml(x.reason)}</p>${x.roi ? `<p><strong>ROI:</strong> ${escapeHtml(x.roi)}</p>` : ""}
<p class="small muted">Approvals needed: ${x.groups.map((g) => `${escapeHtml(g.name)} ${g.approvedBy ? "✓" : "…"}`).join(" · ")}. Status: ${escapeHtml(x.state)}.</p></div>
${canAct ? `<form method="post" action="/teams/approve" class="row"><input type="hidden" name="token" value="${escapeHtml(token)}">
<button class="btn good" name="decision" value="approve" type="submit">Approve</button><button class="btn alt" name="decision" value="decline" type="submit">Decline</button></form>` : ""}
</div>`);
}

export async function handleTeamsPages(ctx, req, res, url) {
  const p = url.pathname, m = req.method;
  if (p === "/app/teams.js") { res.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-cache" }); return res.end(CLIENT_JS); }

  if (p === "/me/signin") {
    if (m === "GET") return sendHtml(res, 200, signinPage());
    const ip = clientIp(req, ctx.config);
    if (limited(`me:${ip}`, 5)) return sendHtml(res, 429, signinPage("", "Too many attempts. Try again in 15 minutes."));
    const form = await readForm(req).catch(() => ({}));
    const email = String(form.email || "").trim().toLowerCase();
    for (const t of ctx.tenants.list()) {
      const who = t.org?.enabled ? personByEmail(t.org, email) : null;
      if (who) {
        await ctx.mailer.send({ kind: "team-signin", to: who.email, subject: "Your AI budget link", text: `See your AI budget at ${t.name}, ask for more or get your key (link valid 1 hour): ${meLink(ctx, t, who, 3600)}` });
        break;
      }
    }
    return sendHtml(res, 200, signinPage("If that email is set up for an AI budget, a link is on its way."));
  }

  if (p === "/me" && m === "GET") {
    const token = url.searchParams.get("token") || "";
    const who = personFromToken(ctx, token);
    if (!who) return sendHtml(res, 400, signinPage("", "That link has expired. Ask for a new one."));
    return sendHtml(res, 200, mePage(ctx, who.tenant, who.person, token));
  }

  if ((p === "/me/request" || p === "/me/key") && m === "POST") {
    const form = await readForm(req).catch(() => ({}));
    const who = personFromToken(ctx, form.token);
    if (!who) return sendHtml(res, 400, signinPage("", "That link has expired. Ask for a new one."));
    if (p === "/me/key") {
      if (limited(`mekey:${who.person.id}`, 5, 3600_000)) return sendHtml(res, 429, mePage(ctx, who.tenant, who.person, form.token, { error: "Too many new keys this hour." }));
      const { apiKey } = await ctx.tenants.personKey(who.tenant.id, who.person);
      await note(ctx, { actor: "teams", action: "person_key", tenantId: who.tenant.id, message: `${who.person.email} created their key` });
      return sendHtml(res, 200, mePage(ctx, who.tenant, who.person, form.token, { apiKey }));
    }
    try {
      const x = await requestException(ctx, who.tenant, who.person, { amountUsd: form.amountUsd, reason: form.reason, roi: form.roi });
      return sendHtml(res, 200, mePage(ctx, who.tenant, who.person, form.token, { message: `Request sent to: ${x.groups.map((g) => g.name).join(" and ")}. You'll get an email when it's decided.` }));
    } catch (e) { return sendHtml(res, 400, mePage(ctx, who.tenant, who.person, form.token, { error: e.message })); }
  }

  if (p === "/teams/approve") {
    const form = m === "POST" ? await readForm(req).catch(() => ({})) : {};
    const token = m === "POST" ? form.token : url.searchParams.get("token");
    const found = exceptionFromToken(ctx, token);
    if (!found) return sendHtml(res, 400, layout("Expired · WasteZero", `<h1>This link has expired</h1><p>Ask the person to send the request again, or approve it in the WasteZero dashboard.</p>`));
    if (m === "GET") return sendHtml(res, 200, approvePage(ctx, found.tenant, found.exception, found.approver, token));
    try {
      const x = await decideException(ctx, found.tenant, found.exception.id, found.approver, form.decision === "decline" ? "decline" : "approve");
      const msg = x.state === "pending" ? "Thanks. Your approval is recorded; it still needs the others listed." : `Done: the request is ${x.state}.`;
      return sendHtml(res, 200, approvePage(ctx, found.tenant, x, found.approver, token, { message: msg }));
    } catch (e) { return sendHtml(res, 400, approvePage(ctx, found.tenant, found.exception, found.approver, token, { error: e.message })); }
  }
  return null;
}

export { approvalPlan };
