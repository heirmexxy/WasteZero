import { randomBytes } from "node:crypto";
import { parseUsage, fetchOpenAIUsage, auditReport } from "./audit.js";
import { note } from "./operator.js";
import { escapeHtml, median, clientIp } from "./util.js";
import { DEFAULT_POLICY } from "./tenants.js";

// Public website: landing page, free audit, public stats.
export const SITE_PATHS = new Set(["/", "/audit", "/stats"]);

const STYLE = `
:root{--ink:#14161b;--muted:#5b6170;--line:#e3e5ea;--accent:#0b7a53;--bg:#fbfbf9}
*{box-sizing:border-box}body{margin:0;font:16px/1.6 system-ui,-apple-system,Segoe UI,sans-serif;color:var(--ink);background:var(--bg)}
main{max-width:880px;margin:0 auto;padding:40px 22px 80px}
h1{font-size:clamp(30px,5vw,46px);line-height:1.12;margin:18px 0 14px;letter-spacing:-.02em}
h2{font-size:22px;margin:44px 0 10px}h3{font-size:17px;margin:0 0 4px}
p{margin:0 0 12px}.muted{color:var(--muted)}.small{font-size:14px}
.btn{display:inline-block;padding:12px 20px;border-radius:8px;background:var(--ink);color:#fff;text-decoration:none;font-weight:600;border:0;font:inherit;cursor:pointer}
.btn.alt{background:transparent;color:var(--ink);border:1.5px solid var(--ink)}
.row{display:flex;gap:12px;flex-wrap:wrap;margin:22px 0}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:14px}.grid4{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:14px}
.card{background:#fff;border:1px solid var(--line);border-radius:10px;padding:18px}
.stat{font-size:30px;font-weight:700;letter-spacing:-.01em}
.tag{display:inline-block;font-size:12px;padding:1px 8px;border-radius:99px;background:#eef6f2;color:var(--accent);font-weight:600}
.tag.est{background:#f3f1ea;color:#7a5b0b}
nav{display:flex;justify-content:space-between;align-items:center}nav a{color:var(--ink);text-decoration:none;font-weight:600}
label{display:block;font-weight:600;margin:16px 0 6px}input,textarea,select{width:100%;padding:10px;border:1px solid #c9ccd4;border-radius:8px;font:inherit;background:#fff}
textarea{min-height:120px;font-family:ui-monospace,monospace;font-size:13px}.err{color:#b42318}
.finding{border-left:4px solid var(--accent);padding:12px 16px;margin:12px 0;background:#fff;border-radius:0 8px 8px 0}
.money{font-weight:700;font-size:18px}code{background:#eef0f3;padding:1px 5px;border-radius:4px;font-size:14px}`;

const page = (title, body, desc = "") => `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>${desc ? `<meta name="description" content="${escapeHtml(desc)}">` : ""}<style>${STYLE}</style></head>
<body><main><nav><a href="/">WasteZero</a><span class="small"><a href="/audit">Free audit</a> &nbsp; <a href="/signup">Sign up</a></span></nav>${body}</main></body></html>`;

function sendHtml(res, status, html) {
  res.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  res.end(html);
}
const sendJson = (res, status, obj) => { res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify(obj)); };
const money = (n) => "$" + Number(n).toLocaleString("en-US", { minimumFractionDigits: n < 100 ? 2 : 0, maximumFractionDigits: n < 100 ? 2 : 0 });

// Public stats, recomputed at most once a minute.
let statsCache = { at: 0, value: null };
export async function publicStats(ctx) {
  if (Date.now() - statsCache.at < 60_000 && statsCache.value) return statsCache.value;
  const events = await ctx.events.all();
  const overhead = events.slice(-5000).map((e) => e.overheadMs).filter((x) => Number.isFinite(x));
  const sorted = [...overhead].sort((a, b) => a - b);
  const value = {
    totalSavedUsd: Number(events.reduce((a, e) => a + (e.savingsUsd > 0 ? e.savingsUsd : 0), 0).toFixed(2)),
    requestsOptimized: events.filter((e) => e.optimization && e.status >= 200 && e.status < 300).length,
    requestsProtected: events.filter((e) => e.blocked).length,
    overheadMsP50: sorted.length ? median(sorted) : null,
    overheadMsP95: sorted.length ? sorted[Math.floor(sorted.length * 0.95)] : null,
    customers: ctx.tenants.list().length
  };
  statsCache = { at: Date.now(), value };
  return value;
}

function landing(stats) {
  const pct = DEFAULT_POLICY.revenueSharePct;
  const proof = stats.totalSavedUsd >= 1 ? `<div class="grid" style="margin-top:28px">
  <div class="card"><div class="stat">${money(stats.totalSavedUsd)}</div><div class="muted small">saved for customers so far</div></div>
  <div class="card"><div class="stat">${stats.requestsOptimized.toLocaleString()}</div><div class="muted small">requests made cheaper</div></div>
  ${stats.overheadMsP50 != null ? `<div class="card"><div class="stat">${Math.round(stats.overheadMsP50)} ms</div><div class="muted small">median delay WasteZero adds (p95 ${Math.round(stats.overheadMsP95)} ms)</div></div>` : ""}</div>` : "";
  return page("WasteZero — find where your AI money leaks", `
<h1>Find where your AI money leaks.<br>Fix it without hurting quality.<br>Pay only from what we save.</h1>
<p class="muted" style="font-size:18px;max-width:640px">WasteZero sits between your app and your AI model provider. It shows which feature, customer and prompt is burning money, stops runaway spend, and cuts waste with fixes it proves on your own traffic first.</p>
<div class="row"><a class="btn" href="/audit">Get a free waste audit</a><a class="btn alt" href="/signup">Start observe-only</a></div>
<p class="small muted">The audit takes 5 minutes, needs no code change, and never touches your traffic.</p>
${proof}
<h2>Sound familiar?</h2>
<div class="grid">
<div class="card"><h3>"Our AI bill doubled and nobody can explain why."</h3><p class="muted small">See cost by feature, customer and model, on every request.</p></div>
<div class="card"><h3>"An agent looped overnight and cost us thousands."</h3><p class="muted small">Budget caps, a loop breaker and spike alerts stop it within minutes, not at month end.</p></div>
<div class="card"><h3>"We pay top-model prices for simple work."</h3><p class="muted small">Repeated answers are reused. Simple tasks move to cheaper models, but only after quality tests pass.</p></div>
</div>
<h2>How it works</h2>
<div class="grid4">
<div class="card"><span class="tag">1</span><h3>Audit</h3><p class="muted small">Upload a usage export or connect read-only usage data. Get waste in dollars per month.</p></div>
<div class="card"><span class="tag">2</span><h3>Observe</h3><p class="muted small">Change one line (your base URL). Nothing about your traffic changes yet.</p></div>
<div class="card"><span class="tag">3</span><h3>Prove</h3><p class="muted small">Cheaper options are tested on your real requests. You see the scores side by side.</p></div>
<div class="card"><span class="tag">4</span><h3>Save</h3><p class="muted small">Fixes go live with your approval, are watched continuously, and roll back on their own if quality slips.</p></div>
</div>
<h2>Pricing</h2>
<p><strong>${pct}% of the savings we verify</strong> against your provider bill. Nothing if we save nothing. Every saved request is listed in a statement you can download and check.</p>
<h2>Trust</h2>
<ul class="muted">
<li>Prompts and answers are not stored. Request fingerprints are one-way hashes.</li>
<li>Keep your own provider key; your provider bills you directly.</li>
<li>Published added delay${stats.overheadMsP50 != null ? ` (currently ${Math.round(stats.overheadMsP50)} ms median)` : ""}, and a fallback snippet so your app goes straight to the provider if WasteZero is ever unreachable.</li>
<li>Nothing changes without your written consent. Every automated decision is logged.</li>
</ul>
<div class="row"><a class="btn" href="/audit">Get a free waste audit</a></div>`,
  "WasteZero finds where your AI model spend leaks, fixes it without hurting quality, and only charges from verified savings.");
}

function auditForm(error = "") {
  return page("Free AI waste audit · WasteZero", `
<h1>Free AI waste audit</h1>
<p class="muted">See where your model spend leaks, in dollars per month. No code change, no proxy. Uses totals only; no prompts are read.</p>
${error ? `<p class="err">${escapeHtml(error)}</p>` : ""}
<form id="f">
<label>1. Your usage data</label>
<select id="source"><option value="upload">Upload a usage export (CSV or JSON)</option><option value="openai">Connect OpenAI (organisation admin key, read once, never stored)</option></select>
<div id="up"><input type="file" id="file" accept=".csv,.json,text/csv,application/json" style="margin-top:10px">
<p class="small muted">From the OpenAI dashboard: Usage → Export. Or any CSV with columns like <code>date, model, input_tokens, output_tokens, cached_tokens, requests</code>.</p></div>
<div id="oa" style="display:none"><input type="password" id="key" placeholder="sk-admin-..." autocomplete="off" style="margin-top:10px">
<p class="small muted">Used once to read the last 30 days of usage totals, then discarded. Create a read-only admin key and delete it afterwards if you prefer.</p></div>
<label for="email">2. Email (optional, to get the report and a follow-up)</label><input id="email" type="email" placeholder="you@company.com">
<div class="row"><button class="btn" type="submit" id="go">Run the audit</button></div>
<p id="msg" class="err"></p>
</form>
<script>
const $=(id)=>document.getElementById(id);
$("source").onchange=()=>{const o=$("source").value==="openai";$("oa").style.display=o?"block":"none";$("up").style.display=o?"none":"block";};
$("f").onsubmit=async(e)=>{e.preventDefault();$("msg").textContent="";$("go").disabled=true;$("go").textContent="Analysing...";
try{const body={source:$("source").value,email:$("email").value};
if(body.source==="upload"){const f=$("file").files[0];if(!f)throw new Error("Choose a file first");if(f.size>5e6)throw new Error("File is over 5 MB");body.content=await f.text();}
else{body.adminKey=$("key").value.trim();if(!body.adminKey)throw new Error("Paste an admin key first");}
const r=await fetch("/audit",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)});
const j=await r.json();if(!r.ok)throw new Error(j.error||"Something went wrong");location.href="/audit/"+j.id;}
catch(err){$("msg").textContent=err.message;$("go").disabled=false;$("go").textContent="Run the audit";}};
</script>`);
}

export function renderAudit(a) {
  const r = a.report;
  const fee = DEFAULT_POLICY.revenueSharePct / 100;
  const items = r.findings.map((f) => `<div class="finding"><span class="tag ${f.confidence === "estimated" ? "est" : ""}">${f.confidence}</span>
<h3 style="margin-top:6px">${escapeHtml(f.title)}</h3><p class="money">${money(f.monthlyUsd)} / month</p><p class="small">${escapeHtml(f.detail)}</p><p class="small muted">Fix: ${escapeHtml(f.fix)}</p></div>`).join("");
  return page("Your AI waste audit · WasteZero", `
<h1>${money(r.monthlyOpportunityUsd)} a month of possible savings</h1>
<p class="muted">From ${r.periodDays} days of usage (${r.rows.toLocaleString()} rows). Current spend: <strong>${money(r.monthlySpendUsd)} / month</strong>.
${r.monthlyOpportunityUsd > 0 ? ` You would keep ${money(r.monthlyOpportunityUsd * (1 - fee))} of it; WasteZero's fee would be ${money(r.monthlyOpportunityUsd * fee)}.` : ""}</p>
<p class="small muted">"Measured" findings come straight from your data. "Estimated" ones rest on the assumption stated in each. Some findings touch the same spend, so the headline combines them without counting any dollar twice; the findings listed below add up to more.</p>
${items || "<p>No clear waste found in totals. Repeated requests and loops only show up per request, so observe-only mode may still find savings.</p>"}
${r.unpricedModels.length ? `<p class="small muted">No price configured for: ${r.unpricedModels.map(escapeHtml).join(", ")}. Their spend is left out.</p>` : ""}
<h2>Not visible from totals</h2><p class="muted">${escapeHtml(r.notSeen)}</p>
<div class="row"><a class="btn" href="/signup">Start observe-only (free)</a><a class="btn alt" href="/audit">Run another audit</a></div>
<p class="small muted">Report ${escapeHtml(a.id)} · ${escapeHtml(a.createdAt.slice(0, 10))}. Keep this link private; anyone with it can see the report.</p>`);
}

const auditHits = new Map();
const limited = (ip) => {
  const now = Date.now();
  const list = (auditHits.get(ip) || []).filter((t) => now - t < 3600_000);
  if (list.length >= 10) return true;
  list.push(now); auditHits.set(ip, list); return false;
};

function readBody(req, max) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on("data", (c) => { size += c.length; if (size > max) { reject(Object.assign(new Error("Upload is over 6 MB"), { status: 413 })); req.destroy(); } else chunks.push(c); });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

export async function handleSite(ctx, req, res, url) {
  const p = url.pathname, m = req.method;
  if (m === "GET" && p === "/") return sendHtml(res, 200, landing(await publicStats(ctx)));
  if (m === "GET" && p === "/stats") return sendJson(res, 200, await publicStats(ctx));
  if (m === "GET" && p === "/audit") return sendHtml(res, 200, auditForm());

  if (m === "POST" && p === "/audit") {
    if (limited(clientIp(req, ctx.config))) return sendJson(res, 429, { error: "Too many audits from this address. Try again in an hour." });
    let b;
    try { b = JSON.parse(await readBody(req, 6 * 1024 * 1024)); }
    catch (e) { return sendJson(res, e.status || 400, { error: e.status ? e.message : "Could not read the request" }); }
    let rows;
    try {
      if (b.source === "openai") rows = await fetchOpenAIUsage(ctx, String(b.adminKey || ""), { baseUrl: ctx.config.openaiAdminBaseUrl });
      else rows = parseUsage(b.content);
    } catch (e) { return sendJson(res, 400, { error: e.message }); }
    if (!rows.length) return sendJson(res, 400, { error: "No usage rows found. The file needs a model column and token counts." });
    const report = auditReport(rows, ctx.config);
    const email = typeof b.email === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(b.email) ? b.email.toLowerCase() : "";
    const audit = { id: "a_" + randomBytes(9).toString("base64url"), createdAt: new Date().toISOString(), source: b.source === "openai" ? "openai" : "upload", email, report };
    await ctx.audits.add(audit);
    await note(ctx, { level: email ? "escalation" : "info", action: "audit", message: `Free audit${email ? ` by ${email}` : ""}: $${report.monthlySpendUsd}/month spend, $${report.monthlyOpportunityUsd}/month opportunity` });
    if (email) {
      const link = `${ctx.config.publicBaseUrl}/audit/${audit.id}`;
      await ctx.mailer.send({ kind: "audit", to: email, subject: `Your AI waste audit: ${money(report.monthlyOpportunityUsd)}/month`,
        text: `Your WasteZero audit found ${money(report.monthlyOpportunityUsd)} a month of possible savings on ${money(report.monthlySpendUsd)} of monthly spend. Full report: ${link}`,
        html: `<p>Your WasteZero audit found <strong>${money(report.monthlyOpportunityUsd)} a month</strong> of possible savings on ${money(report.monthlySpendUsd)} of monthly spend.</p><p><a href="${escapeHtml(link)}">Open the full report</a></p>` });
    }
    return sendJson(res, 201, { id: audit.id });
  }

  if (m === "GET" && p.startsWith("/audit/")) {
    const id = p.slice(7);
    const audit = /^a_[\w-]{6,40}$/.test(id) ? (await ctx.audits.query((a) => a.id === id, 1))[0] : null;
    if (!audit) return sendHtml(res, 404, page("Not found", "<p>That report was not found.</p>"));
    return sendHtml(res, 200, renderAudit(audit));
  }
  return null;
}
