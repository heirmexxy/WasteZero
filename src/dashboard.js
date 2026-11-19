import { customerFromSession, fromDashboard } from "./accounts.js";
import { layout, sendHtml } from "./ui.js";
import { summarize, statementCsv } from "./reports.js";
import { wasteReport } from "./waste.js";
import { economics, forecastMonth } from "./economics.js";
import { latestInvoices, renderInvoiceHtml } from "./billing.js";
import { cardSetupUrl } from "./collections.js";
import { CUSTOMER_EDITABLE, normalizePolicy } from "./tenants.js";
import { note } from "./operator.js";
import { signToken } from "./tokens.js";
import { isPeriod, median } from "./util.js";
import { handleTeamsApi } from "./teams-http.js";
import { handleInsightsApi } from "./insights-http.js";

// Customer dashboard: /app (page) and /app/api/* (JSON, signed-in customer only).

const json = (res, status, body) => { res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify(body)); };
const readJson = (req, max = 65536) => new Promise((resolve, reject) => {
  let raw = "";
  req.on("data", (c) => { raw += c; if (raw.length > max) { reject(new Error("too large")); req.destroy(); } });
  req.on("end", () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch { reject(new Error("Body must be JSON")); } });
  req.on("error", reject);
});

const settingsOf = (t) => Object.fromEntries(CUSTOMER_EDITABLE.map((k) => [k, t.policy[k]]));

function ruleView(r, policy) {
  const s = r.stats.shadow, a = r.stats.audit;
  const passRate = s.n ? s.passed / s.n : null;
  const measuredCut = s.referenceCostUsd > 0 ? 1 - s.candidateCostUsd / s.referenceCostUsd : null;
  const ready = r.state === "shadow" && s.n >= policy.minSamples && passRate >= policy.minQuality;
  return {
    id: r.id, type: r.type, state: r.state, match: r.match, target: r.target, estMonthlySavingsUsd: r.estMonthlySavingsUsd,
    evidence: r.evidence, createdAt: r.createdAt, updatedAt: r.updatedAt,
    test: { samples: s.n, needed: policy.minSamples, passRate, minQuality: policy.minQuality, measuredCostCut: measuredCut, readyToApprove: ready },
    live: { checks: a.n, passed: a.passed, recentPassRate: a.recent.length ? a.recent.reduce((x, y) => x + y, 0) / a.recent.length : null },
    samples: r.samples || [],
    history: r.history.slice(-5)
  };
}

async function overview(ctx, tenant) {
  const all = (await ctx.events.all()).filter((e) => e.tenantId === tenant.id);
  const month = new Date().toISOString().slice(0, 7);
  const thisMonth = all.filter((e) => e.timestamp.startsWith(month));
  const s = summarize(thisMonth);
  const spend = ctx.meter.today(tenant.id);
  const overhead = all.slice(-2000).map((e) => e.overheadMs).filter(Number.isFinite);
  const top = (obj) => Object.entries(obj).map(([k, v]) => ({ name: k, calls: v.calls, costUsd: v.actualCostUsd, savingsUsd: v.savingsUsd })).sort((a, b) => b.costUsd - a.costUsd).slice(0, 8);
  const byProvider = {};
  for (const e of thisMonth) { const k = e.provider || "openai"; byProvider[k] = (byProvider[k] || 0) + (e.actualCostUsd || 0); }
  const pending = ctx.rules.forTenant(tenant.id).filter((r) => ["proposed", "shadow"].includes(r.state));
  return {
    name: tenant.name, paused: tenant.paused || null, allowed: tenant.policy.allowedOptimizations,
    firstRequestAt: all[0]?.timestamp || null, lastRequestAt: all.at(-1)?.timestamp || null, requestsAllTime: all.length,
    month: { requests: s.calls, spendUsd: s.actualCostUsd, withoutWasteZeroUsd: s.baselineCostUsd, savingsUsd: s.savingsUsd, errors: s.errors, blocked: thisMonth.filter((e) => e.blocked).length },
    todayUsd: Number(spend.dayUsd.toFixed(4)), forecast: forecastMonth(spend.monthUsd),
    budgets: tenant.policy.budgets, feePct: tenant.policy.revenueSharePct,
    byTag: top(s.byTag), byModel: top(s.byModel),
    byProvider: Object.entries(byProvider).map(([name, costUsd]) => ({ name, costUsd: Number(costUsd.toFixed(4)) })).sort((a, b) => b.costUsd - a.costUsd),
    overheadMsP50: overhead.length ? median(overhead) : null,
    pendingApprovals: pending.length,
    billing: { hasCard: tenant.billing?.status === "card_on_file", cardLast4: tenant.billing?.cardLast4 || null, cardBrand: tenant.billing?.cardBrand || null }
  };
}

export async function handleApp(ctx, req, res, url) {
  const p = url.pathname, m = req.method;
  const tenant = customerFromSession(ctx, req);
  if (p === "/app" || p === "/app/") {
    if (!tenant) { res.writeHead(303, { location: "/signin" }); return res.end(); }
    return sendHtml(res, 200, appPage(ctx, tenant));
  }
  if (!p.startsWith("/app/api/")) return null;
  if (!tenant) return json(res, 401, { error: "Signed out. Reload the page to sign in again." });
  if (m !== "GET" && !fromDashboard(req)) return json(res, 403, { error: "Missing dashboard header" });
  const api = p.slice("/app/api".length);
  const fresh = () => ctx.tenants.get(tenant.id);
  if (api === "/teams" || api.startsWith("/teams/")) return handleTeamsApi(ctx, req, res, fresh(), api, { json, readJson });
  if (/^\/(security|insights)(\.csv|\/|$)/.test(api)) return handleInsightsApi(ctx, req, res, fresh(), api, url, { json, readJson });

  if (m === "GET" && api === "/overview") return json(res, 200, await overview(ctx, tenant));
  if (m === "GET" && api === "/waste") return json(res, 200, wasteReport({ events: await ctx.events.all(), tenant, config: ctx.config, rules: ctx.rules }));
  if (m === "GET" && api === "/economics") return json(res, 200, economics({ events: await ctx.events.all(), tenant }));

  if (m === "GET" && api === "/rules") return json(res, 200, { rules: ctx.rules.forTenant(tenant.id).map((r) => ruleView(r, tenant.policy)).reverse() });
  let match = api.match(/^\/rules\/([\w-]+)\/(approve|reject|pause|resume)$/);
  if (m === "POST" && match) {
    const rule = ctx.rules.get(match[1]);
    if (!rule || rule.tenantId !== tenant.id) return json(res, 404, { error: "Not found" });
    const action = match[2];
    let to, reason;
    try {
      if (action === "approve") {
        if (rule.state === "proposed") { to = rule.type === "route" ? "shadow" : "active"; reason = rule.type === "route" ? "Customer approved testing" : "Customer approved"; }
        else if (rule.state === "shadow") {
          const v = ruleView(rule, tenant.policy).test;
          if (!v.readyToApprove) return json(res, 409, { error: `Still testing: ${v.samples}/${v.needed} samples${v.passRate != null ? `, ${Math.round(v.passRate * 100)}% acceptable (needs ${Math.round(v.minQuality * 100)}%)` : ""}.` });
          to = "active"; reason = "Customer approved after quality tests";
        } else if (rule.state === "paused") { to = "active"; reason = "Customer resumed"; }
        else return json(res, 409, { error: `Nothing to approve: this change is ${rule.state}` });
        // Approving a change is consent for that kind of change.
        const allowed = new Set(fresh().policy.allowedOptimizations);
        if (!allowed.has(rule.type)) { allowed.add(rule.type); await ctx.tenants.update(tenant.id, { policy: { allowedOptimizations: [...allowed] } }); }
      } else if (action === "reject") { to = "rejected"; reason = "Customer declined"; }
      else if (action === "pause") { to = "paused"; reason = "Customer paused"; }
      else { to = "active"; reason = "Customer resumed"; }
      await ctx.rules.transition(rule.id, to, { actor: "customer", reason });
    } catch (error) { return json(res, error.status || 400, { error: error.message }); }
    if (rule.type === "cache" && to !== "active") ctx.cache.clearTenant(tenant.id);
    await note(ctx, { actor: "customer", level: "info", tenantId: tenant.id, ruleId: rule.id, action: `rule:${to}`, message: `${tenant.name}: ${reason}` });
    return json(res, 200, { rule: ruleView(ctx.rules.get(rule.id), fresh().policy) });
  }

  if (m === "GET" && api === "/settings") return json(res, 200, { settings: settingsOf(fresh()), paused: fresh().paused || null, telegram: telegramInfo(ctx, fresh()) });
  if (m === "PATCH" && api === "/settings") {
    let b;
    try { b = await readJson(req); } catch (e) { return json(res, 400, { error: e.message }); }
    const refused = Object.keys(b).filter((k) => !CUSTOMER_EDITABLE.includes(k));
    if (refused.length) return json(res, 400, { error: `Can't change: ${refused.join(", ")}` });
    try { normalizePolicy(b, fresh().policy); await ctx.tenants.update(tenant.id, { policy: b }); }
    catch (error) { return json(res, 400, { error: error.message }); }
    if (!fresh().policy.allowedOptimizations.includes("cache")) ctx.cache.clearTenant(tenant.id);
    await note(ctx, { actor: "customer", level: "info", tenantId: tenant.id, action: "settings_updated", message: `${tenant.name} changed ${Object.keys(b).join(", ")}` });
    return json(res, 200, { settings: settingsOf(fresh()) });
  }
  if (m === "POST" && api === "/resume") {
    await ctx.tenants.setPaused(tenant.id, null);
    await note(ctx, { actor: "customer", level: "info", tenantId: tenant.id, action: "resumed", message: `${tenant.name} resumed traffic` });
    return json(res, 200, { ok: true });
  }
  if (m === "POST" && api === "/pause") {
    await ctx.tenants.setPaused(tenant.id, { at: new Date().toISOString(), reason: "paused from the dashboard" });
    await note(ctx, { actor: "customer", level: "info", tenantId: tenant.id, action: "paused", message: `${tenant.name} paused traffic` });
    return json(res, 200, { ok: true });
  }

  if (m === "GET" && api === "/keys") return json(res, 200, { keys: ctx.tenants.publicView(fresh()).keys.filter((k) => !k.personId) });
  if (m === "POST" && api === "/keys") {
    const b = await readJson(req).catch(() => ({}));
    try {
      const created = await ctx.tenants.createKey(tenant.id, b.label);
      await note(ctx, { actor: "customer", level: "info", tenantId: tenant.id, action: "key_created", message: `Key "${created.key.label}" created` });
      return json(res, 201, created);
    } catch (error) { return json(res, 400, { error: error.message }); }
  }
  match = api.match(/^\/keys\/([\w-]+)$/);
  if (m === "DELETE" && match) {
    const r = await ctx.tenants.revokeKey(tenant.id, match[1]);
    if (r.error) return json(res, 409, r);
    await note(ctx, { actor: "customer", level: "info", tenantId: tenant.id, action: "key_revoked", message: `Key ${match[1]} revoked` });
    return json(res, 200, r);
  }

  if (m === "GET" && api === "/invoices") {
    const list = latestInvoices(await ctx.invoices.all()).filter((i) => i.tenantId === tenant.id && i.status !== "preview").reverse()
      .map(({ id, period, status, savingsUsd, feeUsd, baseFeeUsd, usageUsd, totalUsd, payment }) => ({ id, period, status, savingsUsd, feeUsd, baseFeeUsd, usageUsd, totalUsd, paidAt: payment?.paidAt || null }));
    return json(res, 200, { invoices: list, card: { hasCard: fresh().billing?.status === "card_on_file", cardLast4: fresh().billing?.cardLast4, cardBrand: fresh().billing?.cardBrand }, cardPayments: ctx.payments.enabled });
  }
  match = api.match(/^\/invoices\/([\w-]+)$/);
  if (m === "GET" && match) {
    const inv = latestInvoices(await ctx.invoices.all()).find((i) => i.id === match[1] && i.tenantId === tenant.id);
    if (!inv) return json(res, 404, { error: "Not found" });
    return sendHtml(res, 200, renderInvoiceHtml(inv));
  }
  if (m === "POST" && api === "/card-link") {
    const link = cardSetupUrl(ctx, fresh());
    return link ? json(res, 200, { url: link }) : json(res, 409, { error: "Card payments are not switched on yet." });
  }
  if (m === "GET" && api === "/statement.csv") {
    const period = url.searchParams.get("period") || new Date().toISOString().slice(0, 7);
    if (!isPeriod(period)) return json(res, 400, { error: "period must be YYYY-MM" });
    res.writeHead(200, { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="wastezero-${period}.csv"` });
    return res.end(statementCsv(await ctx.events.all(), tenant.id, period));
  }
  return json(res, 404, { error: "Not found" });
}

function telegramInfo(ctx, tenant) {
  const t = ctx.config.telegram;
  if (!t?.botToken || !t.botUsername) return { available: false };
  const token = signToken(ctx.config, { k: "tg", t: tenant.id }, 3600);
  return { available: true, connected: tenant.telegramChatId != null, link: `https://t.me/${t.botUsername}?start=${encodeURIComponent(token)}` };
}

// ------------------------------------------------------------ page

const NAV = `<a href="/app">Dashboard</a><a href="/docs">Docs</a><a href="/signout">Sign out</a>`;

function appPage(ctx, tenant) {
  const base = ctx.config.publicBaseUrl || "";
  return layout(`${tenant.name} · WasteZero`, `
<div class="row" style="justify-content:space-between;margin:8px 0 0"><h1 style="margin:10px 0 0;font-size:28px" id="title">${tenant.name.replace(/[<>&"]/g, "")}</h1><span id="pausebox"></span></div>
<div class="tabs" id="tabs">
<button data-t="overview" class="on">Overview</button><button data-t="savings">Savings &amp; waste</button><button data-t="approvals">Approvals <span id="pendingCount"></span></button>
<button data-t="profit">Profit per customer</button><button data-t="settings">Protection &amp; settings</button><button data-t="teams">WasteZero for Teams</button><button data-t="keys">API keys</button><button data-t="billing">Billing</button><button data-t="setup">Setup</button>
</div>
<div id="view"><p class="muted">Loading…</p></div><script src="/app/teams.js"></script>`, { nav: NAV, script: appScript(base) });
}

function appScript(base) {
  return `
const BASE=${JSON.stringify(base)};
const $=(s)=>document.querySelector(s);
const esc=(s)=>String(s??"").replace(/[&<>"']/g,(c)=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const usd=(n,d)=>n==null?"–":"$"+Number(n).toLocaleString("en-US",{minimumFractionDigits:d??(Math.abs(n)<100?2:0),maximumFractionDigits:d??(Math.abs(n)<100?2:0)});
const pct=(x)=>x==null?"–":Math.round(x*100)+"%";
const when=(t)=>t?new Date(t).toLocaleString():"–";
async function api(path,opt={}){const r=await fetch("/app/api"+path,{...opt,headers:{"content-type":"application/json","x-wz-ui":"1",...(opt.headers||{})}});
 if(r.status===401){location.href="/signin";throw new Error("signed out")}const j=await r.json().catch(()=>({}));if(!r.ok)throw new Error(j.error||("Error "+r.status));return j;}
const view=$("#view");
function tab(t){document.querySelectorAll("#tabs button").forEach(b=>b.classList.toggle("on",b.dataset.t===t));view.innerHTML='<p class="muted">Loading…</p>';
 (R[t]||R.overview)().catch(e=>view.innerHTML='<p class="err">'+esc(e.message)+'</p>');history.replaceState(null,"","#"+t);}
document.querySelectorAll("#tabs button").forEach(b=>b.onclick=()=>tab(b.dataset.t));
function table(rows,cols){if(!rows.length)return '<p class="muted small">Nothing yet.</p>';return '<table><tr>'+cols.map(c=>'<th>'+c[0]+'</th>').join("")+'</tr>'+rows.map(r=>'<tr>'+cols.map(c=>'<td>'+c[1](r)+'</td>').join("")+'</tr>').join("")+'</table>';}
async function pausebox(o){$("#pausebox").innerHTML=o.paused?'<span class="tag bad">Paused</span> <button class="btn sm good" id="rs">Resume traffic</button>':'<button class="btn sm alt" id="ps">Pause all traffic</button>';
 const rs=$("#rs"),ps=$("#ps");if(rs)rs.onclick=async()=>{await api("/resume",{method:"POST"});tab("overview")};
 if(ps)ps.onclick=async()=>{if(confirm("Pause all AI traffic through WasteZero? Requests will get a 429 until you resume."))await api("/pause",{method:"POST"});tab("overview")};
 $("#pendingCount").innerHTML=o.pendingApprovals?'<span class="tag warn">'+o.pendingApprovals+'</span>':"";}
const R={};
R.teams=()=>window.WZTeams({view,api,esc,usd,table,when});
R.overview=async()=>{const o=await api("/overview");pausebox(o);
 const first=o.firstRequestAt?'<span class="tag">Receiving traffic</span> <span class="small muted">last request '+when(o.lastRequestAt)+'</span>':'<div class="notice"><strong>Waiting for your first request…</strong> Follow the <a href="#setup" onclick="tab(\\'setup\\');return false">setup</a> steps; this updates by itself.</div>';
 const f=o.forecast;const cap=o.budgets.monthlyUsd;
 view.innerHTML=first+(o.paused?'<div class="notice"><strong>Traffic is paused:</strong> '+esc(o.paused.reason)+'</div>':'')+
 '<div class="grid4" style="margin-top:14px">'+
 '<div class="card"><div class="stat">'+usd(o.month.spendUsd)+'</div><div class="small muted">AI spend this month</div></div>'+
 '<div class="card"><div class="stat">'+(f.projectedUsd!=null?usd(f.projectedUsd):"–")+'</div><div class="small muted">forecast for the month'+(cap?(' · budget '+usd(cap)):"")+'</div>'+(cap&&f.projectedUsd>cap?'<span class="tag bad">over budget pace</span>':"")+'</div>'+
 '<div class="card"><div class="stat">'+usd(o.month.savingsUsd)+'</div><div class="small muted">saved this month · fee '+o.feePct+'%</div></div>'+
 '<div class="card"><div class="stat">'+o.month.requests.toLocaleString()+'</div><div class="small muted">requests · '+o.month.blocked+' blocked by your protection</div></div></div>'+
 (o.pendingApprovals?'<div class="notice" style="margin-top:14px"><strong>'+o.pendingApprovals+' change'+(o.pendingApprovals>1?'s':'')+' waiting for you.</strong> <a href="#approvals" onclick="tab(\\'approvals\\');return false">Review</a></div>':'')+
 '<h2>Where the money goes</h2><div class="grid"><div class="card"><h3>By feature</h3>'+table(o.byTag,[["Feature",r=>esc(r.name)],["Spend",r=>usd(r.costUsd)],["Saved",r=>usd(r.savingsUsd)]])+'</div>'+
 '<div class="card"><h3>By model</h3>'+table(o.byModel,[["Model",r=>esc(r.name)],["Spend",r=>usd(r.costUsd)],["Calls",r=>r.calls]])+'</div>'+
 '<div class="card"><h3>By provider</h3>'+table(o.byProvider,[["Provider",r=>esc(r.name)],["Spend",r=>usd(r.costUsd)]])+'</div></div>'+
 '<p class="small muted" style="margin-top:14px">Today '+usd(o.todayUsd)+(o.overheadMsP50!=null?' · WasteZero adds '+Math.round(o.overheadMsP50)+' ms median':'')+' · <a href="/app/api/statement.csv">download this month\\'s statement (CSV)</a></p>';
 if(!o.firstRequestAt)setTimeout(()=>{if(location.hash==="#overview"||!location.hash)tab("overview")},8000);};
R.savings=async()=>{const w=await api("/waste");
 view.innerHTML='<div class="grid4"><div class="card"><div class="stat">'+usd(w.monthlyWasteUsd)+'</div><div class="small muted">waste found, per month</div></div><div class="card"><div class="stat">'+usd(w.savedSoFarUsd)+'</div><div class="small muted">saved in the last '+w.windowDays+' days</div></div><div class="card"><div class="stat">'+usd(w.monthlySpendUsd)+'</div><div class="small muted">monthly spend at current rate</div></div></div>'+
 (w.findings.length?w.findings.map(f=>'<div class="finding"><span class="tag '+(f.confidence==="estimated"?"est":"")+'">'+f.confidence+'</span><h3 style="margin-top:6px">'+esc(f.title)+'</h3><p class="money">'+usd(f.monthlyUsd)+' / month</p><p class="small">'+esc(f.detail)+'</p><p class="small muted">Fix: '+esc(f.fix)+'</p></div>').join(""):'<p class="muted" style="margin-top:14px">No waste found yet. This fills in as traffic flows.</p>')+
 '<p class="tiny muted">Some findings touch the same spend; the headline counts each dollar once.</p>';};
function ruleTitle(r){return r.type==="route"?'Use '+esc(r.target)+' instead of '+esc(r.match.model):r.type==="cache"?'Reuse answers to repeated '+esc(r.match.model)+' requests':'Prompt caching for '+esc(r.match.model);}
const STATE={proposed:["Proposed","warn"],shadow:["Testing","warn"],active:["Live","" ],paused:["Paused","grey"],rejected:["Declined","grey"],rolled_back:["Rolled back","bad"]};
R.approvals=async()=>{const {rules}=await api("/rules");
 view.innerHTML='<p class="muted small">WasteZero proposes changes from your traffic. A cheaper model is first tested on a sample of your real requests (your answers are not affected) and only goes live when you approve and it meets your quality bar.</p>'+(rules.length?rules.map(r=>{const s=STATE[r.state]||[r.state,"grey"];const t=r.test;
  const proof=r.type==="route"?'<p class="small">Quality tests: <strong>'+t.samples+'/'+t.needed+'</strong> samples'+(t.passRate!=null?', <strong>'+pct(t.passRate)+'</strong> acceptable (bar '+pct(t.minQuality)+')':'')+(t.measuredCostCut!=null?', measured cost cut <strong>'+pct(t.measuredCostCut)+'</strong>':'')+(r.live.checks?' · live checks '+r.live.passed+'/'+r.live.checks:'')+'</p>':'';
  const samples=r.samples.length?'<details><summary class="small">Side-by-side examples ('+r.samples.length+')</summary>'+r.samples.slice().reverse().map(x=>'<div style="margin:10px 0"><p class="tiny muted">'+when(x.at)+' · '+(x.passed?'<span class="tag">acceptable</span>':'<span class="tag bad">not acceptable</span>')+(x.score!=null?' score '+x.score+'/10':'')+'</p><p class="small"><strong>Request:</strong> '+esc(x.request)+'</p><div class="side"><div><strong>'+esc(x.originalModel)+'</strong> ('+usd(x.originalCostUsd,5)+')\\n'+esc(x.original)+'</div><div><strong>'+esc(x.cheaperModel)+'</strong> ('+usd(x.cheaperCostUsd,5)+')\\n'+esc(x.cheaper)+'</div></div></div>').join("")+'</details>':(r.type==="route"?'<p class="tiny muted">Turn on "keep test samples" in settings to see example answers side by side.</p>':'');
  const btn=[];if(r.state==="proposed")btn.push(['approve',r.type==="route"?'Approve testing':'Approve','good']);if(r.state==="shadow")btn.push(['approve',t.readyToApprove?'Approve going live':'Approve when tests pass',t.readyToApprove?'good':'alt']);
  if(["proposed","shadow"].includes(r.state))btn.push(['reject','Decline','alt']);if(r.state==="active")btn.push(['pause','Pause','alt']);if(r.state==="paused")btn.push(['resume','Resume','good']);
  return '<div class="card" style="margin:12px 0"><span class="tag '+s[1]+'">'+s[0]+'</span> <span class="tag grey">'+(r.match.tag?'feature: '+esc(r.match.tag):'all features')+'</span><h3 style="margin-top:8px">'+ruleTitle(r)+'</h3><p class="money">'+(r.estMonthlySavingsUsd!=null?'≈ '+usd(r.estMonthlySavingsUsd)+' / month':'')+'</p>'+proof+samples+'<div class="row">'+btn.map(b=>'<button class="btn sm '+b[2]+'" data-a="'+b[0]+'" data-id="'+r.id+'">'+b[1]+'</button>').join("")+'</div><p class="tiny muted">'+esc((r.history.at(-1)||{}).reason||"")+'</p></div>';}).join(""):'<p class="muted">No proposals yet. WasteZero looks at your traffic every hour.</p>');
 view.querySelectorAll("button[data-a]").forEach(b=>b.onclick=async()=>{b.disabled=true;try{await api("/rules/"+b.dataset.id+"/"+b.dataset.a,{method:"POST"});tab("approvals")}catch(e){alert(e.message);b.disabled=false}});};
R.profit=async()=>{const e=await api("/economics");
 view.innerHTML='<p class="muted small">Send <code>X-WasteZero-User</code> (your customer\\'s ID) and <code>X-WasteZero-Plan</code> (their plan) with each request, and set plan prices in settings. You\\'ll see which customers cost more in AI than they pay.</p>'+
 '<div class="grid4"><div class="card"><div class="stat">'+e.userCount+'</div><div class="small muted">customers seen this month</div></div><div class="card"><div class="stat">'+e.losingUsers+'</div><div class="small muted">cost more than they pay</div></div><div class="card"><div class="stat">'+usd(e.untrackedCostUsd)+'</div><div class="small muted">spend not linked to a customer</div></div></div>'+
 '<h2>By plan</h2>'+table(e.plans,[["Plan",r=>esc(r.plan)],["Customers",r=>r.users],["Avg AI cost",r=>usd(r.avgCostPerUserUsd)],["Price",r=>usd(r.priceUsd)],["Avg margin",r=>r.avgMarginPerUserUsd==null?"–":'<span class="'+(r.avgMarginPerUserUsd<0?"err":"ok")+'">'+usd(r.avgMarginPerUserUsd)+'</span>'],["Losing",r=>r.losingUsers]])+
 '<h2>Costliest customers</h2>'+table(e.users.slice(0,50),[["Customer",r=>esc(r.label||r.user)],["Plan",r=>esc(r.plan||"–")],["Requests",r=>r.requests],["AI cost",r=>usd(r.costUsd)],["Margin",r=>r.marginUsd==null?"–":'<span class="'+(r.losing?"err":"ok")+'">'+usd(r.marginUsd)+'</span>']])+
 '<p class="tiny muted">Customer IDs show as short codes unless "show end-user IDs" is on in settings.</p>';};
R.settings=async()=>{const {settings:s,telegram:tg}=await api("/settings");const b=s.budgets;
 const opt=(n,v,l)=>'<label style="font-weight:400;display:flex;gap:8px;align-items:center"><input type="checkbox" style="width:auto" name="'+n+'" '+(v?"checked":"")+'> '+l+'</label>';
 const sel=(n,v,opts)=>'<select name="'+n+'">'+opts.map(o=>'<option'+(o===v?' selected':'')+'>'+o+'</option>').join("")+'</select>';
 view.innerHTML='<form id="f"><h2 style="margin-top:0">Runaway-spend protection</h2><div class="grid">'+
 '<div><label>Daily budget ($, 0 = none)</label><input name="daily" type="number" step="0.01" min="0" value="'+b.dailyUsd+'"></div>'+
 '<div><label>Monthly budget ($)</label><input name="monthly" type="number" step="0.01" min="0" value="'+b.monthlyUsd+'"></div>'+
 '<div><label>Per end user per day ($)</label><input name="perUser" type="number" step="0.01" min="0" value="'+b.perUserDailyUsd+'"></div>'+
 '<div><label>When a budget is reached</label>'+sel("budgetAction",s.budgetAction,["block","alert"])+'</div>'+
 '<div><label>Loop breaker</label>'+sel("loopAction",s.loopBreaker.action,["alert","block","off"])+'<p class="tiny muted">more than <input name="loopMax" type="number" min="2" value="'+s.loopBreaker.maxRepeats+'" style="width:70px;display:inline"> identical requests in <input name="loopWin" type="number" min="5" value="'+s.loopBreaker.windowSec+'" style="width:70px;display:inline"> s</p></div>'+
 '<div><label>Spending spikes</label>'+sel("spikeAction",s.spikeAlert.action,["alert","pause","off"])+'<p class="tiny muted">hour above <input name="spikeFactor" type="number" min="1.5" step="0.5" value="'+s.spikeAlert.factor+'" style="width:70px;display:inline">× normal and over $<input name="spikeMin" type="number" min="0" step="1" value="'+s.spikeAlert.minHourlyUsd+'" style="width:70px;display:inline"></p></div></div>'+
 '<h2>Alerts</h2><div class="grid"><div><label>Alert email</label><input name="alertEmail" type="email" value="'+esc(s.alertEmail)+'" placeholder="defaults to billing email"></div><div><label>Slack webhook (https)</label><input name="alertWebhookUrl" value="'+esc(s.alertWebhookUrl)+'"></div></div>'+
 (tg.available?'<p class="small" style="margin-top:10px">Telegram: '+(tg.connected?'<span class="tag">connected</span> alerts arrive with Pause and Resume buttons. ':'')+'<a class="btn sm alt" target="_blank" href="'+esc(tg.link)+'">'+(tg.connected?'Reconnect':'Connect Telegram')+'</a></p>':'')+
 '<h2>Savings you allow</h2>'+opt("o_cache",s.allowedOptimizations.includes("cache"),"Reuse answers to identical repeat requests")+opt("o_route",s.allowedOptimizations.includes("route"),"Cheaper models, after quality tests pass")+opt("o_prompt",s.allowedOptimizations.includes("prompt_cache"),"Automatic prompt caching (Anthropic)")+
 opt("autoShadow",s.autoShadow,"Start quality tests without asking me")+opt("autoPromote",s.autoPromote,"Switch on changes that pass tests without asking me")+
 '<div class="grid"><div><label>Quality bar (share of answers that must be acceptable)</label><input name="minQuality" type="number" min="0.5" max="1" step="0.01" value="'+s.minQuality+'"></div>'+
 '<div><label>Features where answers may be reused at any temperature</label><input name="cacheTags" value="'+esc(s.cacheTags.join(", "))+'" placeholder="faq, search"></div></div>'+
 '<h2>Data</h2>'+opt("keepTestSamples",s.keepTestSamples,"Keep test samples (example answers) to show side by side")+opt("storeEndUserIds",s.storeEndUserIds,"Show end-user IDs as sent (otherwise short codes)")+
 '<label>Plan prices, one per line (plan = monthly price)</label><textarea name="plans" style="min-height:70px">'+Object.entries(s.planPrices).map(([k,v])=>k+" = "+v).join("\\n")+'</textarea>'+
 '<div class="row"><button class="btn" type="submit">Save</button><span id="msg" class="small"></span></div></form>';
 $("#f").onsubmit=async(ev)=>{ev.preventDefault();const f=ev.target;const n=(x)=>Number(f[x].value||0);const allowed=[];if(f.o_cache.checked)allowed.push("cache");if(f.o_route.checked)allowed.push("route");if(f.o_prompt.checked)allowed.push("prompt_cache");
  const plans={};for(const line of f.plans.value.split("\\n")){const m=line.split("=");if(m.length===2&&m[0].trim())plans[m[0].trim()]=Number(m[1])}
  const body={budgets:{dailyUsd:n("daily"),monthlyUsd:n("monthly"),perUserDailyUsd:n("perUser"),perTagDailyUsd:b.perTagDailyUsd},budgetAction:f.budgetAction.value,
   loopBreaker:{action:f.loopAction.value,maxRepeats:n("loopMax"),windowSec:n("loopWin")},spikeAlert:{action:f.spikeAction.value,factor:n("spikeFactor"),minHourlyUsd:n("spikeMin")},
   alertEmail:f.alertEmail.value.trim(),alertWebhookUrl:f.alertWebhookUrl.value.trim(),allowedOptimizations:allowed,autoShadow:f.autoShadow.checked,autoPromote:f.autoPromote.checked,
   minQuality:n("minQuality"),cacheTags:f.cacheTags.value.split(",").map(x=>x.trim()).filter(Boolean),keepTestSamples:f.keepTestSamples.checked,storeEndUserIds:f.storeEndUserIds.checked,planPrices:plans};
  try{await api("/settings",{method:"PATCH",body:JSON.stringify(body)});$("#msg").innerHTML='<span class="ok">Saved</span>'}catch(e){$("#msg").innerHTML='<span class="err">'+esc(e.message)+'</span>'}};};
R.keys=async()=>{const {keys}=await api("/keys");
 view.innerHTML='<p class="muted small">Use a separate key per app or environment. A key is shown once when created.</p><div id="newkey"></div>'+table(keys,[["Name",k=>esc(k.label)],["Key",k=>'<code>'+esc(k.hint||"")+'</code>'],["Created",k=>when(k.createdAt)],["Last used",k=>when(k.lastUsedAt)],["",k=>k.revokedAt?'<span class="tag grey">revoked</span>':'<button class="btn sm alt" data-rv="'+k.id+'">Revoke</button>']])+
 '<form id="kf" class="row"><input name="label" placeholder="Name, e.g. production" style="max-width:280px"><button class="btn" type="submit">Create key</button></form>';
 $("#kf").onsubmit=async(ev)=>{ev.preventDefault();try{const r=await api("/keys",{method:"POST",body:JSON.stringify({label:ev.target.label.value})});await R.keys();$("#newkey").innerHTML='<div class="notice"><strong>Copy this key now; it won\\'t be shown again:</strong><pre>'+esc(r.apiKey)+'</pre></div>'}catch(e){alert(e.message)}};
 view.querySelectorAll("[data-rv]").forEach(b=>b.onclick=async()=>{if(!confirm("Revoke this key? Apps using it will stop working."))return;try{await api("/keys/"+b.dataset.rv,{method:"DELETE"});R.keys()}catch(e){alert(e.message)}});};
R.billing=async()=>{const r=await api("/invoices");const c=r.card||{};
 view.innerHTML='<div class="card"><h3>Payment card</h3><p>'+(c.hasCard?esc(c.cardBrand||"Card")+' ending '+esc(c.cardLast4||""):'No card saved yet.')+'</p>'+(r.cardPayments?'<button class="btn sm" id="card">'+(c.hasCard?'Update card':'Add a card')+'</button>':'<p class="small muted">Card payments are not switched on yet.</p>')+'</div>'+
 '<h2>Invoices</h2>'+table(r.invoices,[["Month",i=>esc(i.period)],["Saved",i=>usd(i.savingsUsd)],["Fee",i=>usd(i.feeUsd)],["Usage",i=>usd(i.usageUsd||0)],["Total",i=>'<strong>'+usd(i.totalUsd??i.feeUsd)+'</strong>'],["Status",i=>'<span class="tag '+(i.status==="paid"?"":"warn")+'">'+esc(i.status)+'</span>'],["",i=>'<a target="_blank" href="/app/api/invoices/'+i.id+'">View</a>']])+
 '<p class="small" style="margin-top:12px">Statements: '+[0,1,2].map(k=>{const d=new Date();d.setUTCDate(1);d.setUTCMonth(d.getUTCMonth()-k);const p=d.toISOString().slice(0,7);return '<a href="/app/api/statement.csv?period='+p+'">'+p+'</a>'}).join(" · ")+'</p>';
 const b=$("#card");if(b)b.onclick=async()=>{try{const {url}=await api("/card-link",{method:"POST"});location.href=url}catch(e){alert(e.message)}};};
R.setup=async()=>{const o=await api("/overview");
 view.innerHTML=(o.firstRequestAt?'<p><span class="tag">Connected</span> first request '+when(o.firstRequestAt)+'</p>':'<div class="notice"><strong>Waiting for your first request…</strong> This page updates by itself.</div>')+
 '<h2 style="margin-top:10px">1. Point your SDK at WasteZero</h2><pre>from openai import OpenAI\\nclient = OpenAI(\\n    base_url="'+esc(BASE)+'/v1",\\n    api_key="wz_...",   # a key from the API keys tab\\n    default_headers={"X-Upstream-Authorization": "Bearer sk-...",  # your provider key\\n                     "X-WasteZero-Tag": "support-bot"},\\n)</pre>'+
 '<h2>2. Or Claude, with the Anthropic SDK</h2><pre>from anthropic import Anthropic\\nclient = Anthropic(base_url="'+esc(BASE)+'", api_key="wz_...",\\n                   default_headers={"X-Upstream-Authorization": "sk-ant-..."})</pre>'+
 '<h2>3. Test from a terminal</h2><pre>curl '+esc(BASE)+'/v1/chat/completions \\\\\\n  -H "Authorization: Bearer wz_..." \\\\\\n  -H "X-Upstream-Authorization: Bearer sk-..." \\\\\\n  -H "content-type: application/json" \\\\\\n  -d \\'{"model":"gpt-4o-mini","messages":[{"role":"user","content":"hi"}]}\\'</pre><p class="small"><a href="/docs">Full docs</a></p>';
 if(!o.firstRequestAt)setTimeout(()=>{if(location.hash==="#setup")tab("setup")},8000);};
tab((location.hash||"#overview").slice(1));`;
}
