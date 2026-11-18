import { isAdminSession, adminSigninPage } from "./accounts.js";
import { layout, sendHtml } from "./ui.js";
import { summarize } from "./reports.js";
import { latestInvoices } from "./billing.js";
import { isHalted } from "./operator.js";

// Admin console: /console (page). It uses the /admin/* API, signed in by cookie.

export async function adminOverview(ctx) {
  const events = await ctx.events.all();
  const month = new Date().toISOString().slice(0, 7);
  const thisMonth = events.filter((e) => e.timestamp?.startsWith(month));
  const s = summarize(thisMonth);
  const tenants = ctx.tenants.listCustomers();
  const internal = ctx.tenants.list().find((t) => t.internal);
  const activeIds = new Set(thisMonth.map((e) => e.tenantId));
  let feesThisMonth = 0;
  for (const t of tenants) {
    const saved = thisMonth.filter((e) => e.tenantId === t.id && e.status >= 200 && e.status < 300).reduce((a, e) => a + (e.savingsUsd || 0), 0);
    feesThisMonth += Math.max(0, saved) * t.policy.revenueSharePct / 100 + (t.policy.monthlyBaseFeeUsd || 0);
  }
  const invoices = latestInvoices(await ctx.invoices.all());
  const audit = await ctx.audit.query((a) => a.level === "escalation", 15);
  const perTenant = tenants.map((t) => {
    const ev = thisMonth.filter((e) => e.tenantId === t.id);
    const ts = summarize(ev);
    return { id: t.id, name: t.name, email: t.billing?.email || "", paused: !!t.paused, hasCard: t.billing?.status === "card_on_file",
      requests: ts.calls, spendUsd: ts.actualCostUsd, savingsUsd: ts.savingsUsd, allowed: t.policy.allowedOptimizations,
      lastRequestAt: events.filter((e) => e.tenantId === t.id).at(-1)?.timestamp || null, createdAt: t.createdAt };
  });
  return {
    month,
    customers: tenants.length, activeCustomers: activeIds.size, payingCustomers: tenants.filter((t) => t.billing?.status === "card_on_file").length,
    requests: s.calls, spendUsd: s.actualCostUsd, savingsUsd: s.savingsUsd, feesThisMonthUsd: Number(feesThisMonth.toFixed(2)),
    collectedUsd: Number(invoices.filter((i) => i.status === "paid").reduce((a, i) => a + (i.totalUsd ?? i.feeUsd ?? 0), 0).toFixed(2)),
    unpaidUsd: Number(invoices.filter((i) => ["ready", "payment_failed", "awaiting_card", "needs_review", "draft"].includes(i.status)).reduce((a, i) => a + (i.totalUsd ?? i.feeUsd ?? 0), 0).toFixed(2)),
    pendingApprovals: ctx.rules.list((r) => r.state === "proposed" || r.state === "shadow").length,
    outreachWaiting: ctx.prospects.list("drafted").length,
    operator: { halted: isHalted(ctx.config), intervalMs: ctx.config.operatorIntervalMs },
    escalations: audit, tenants: perTenant,
    ownUse: internal ? (() => { const ev = thisMonth.filter((e) => e.tenantId === internal.id); const x = summarize(ev); return { requests: x.calls, spendUsd: x.actualCostUsd, savingsUsd: x.savingsUsd, blocked: ev.filter((e) => e.blocked).length }; })() : null
  };
}

export function handleConsole(ctx, req, res, url) {
  if (url.pathname !== "/console" && url.pathname !== "/console/") return null;
  if (!isAdminSession(ctx, req)) return sendHtml(res, 200, adminSigninPage("", ctx.config.agents?.adminEmail));
  return sendHtml(res, 200, layout("Admin · WasteZero", `
<div class="row" style="justify-content:space-between;margin:6px 0 0"><h1 style="margin:10px 0 0;font-size:28px">Admin console</h1><span id="op"></span></div>
<div class="tabs" id="tabs"><button data-t="overview" class="on">Overview</button><button data-t="team">Team &amp; brief <span id="wait"></span></button><button data-t="customers">Customers</button><button data-t="approvals">Approvals</button>
<button data-t="invoices">Invoices</button><button data-t="prospects">Prospects</button><button data-t="activity">Activity</button></div>
<div id="view"><p class="muted">Loading…</p></div>`, { nav: `<a href="/">Site</a><a href="/console/signout">Sign out</a>`, script: SCRIPT }));
}

const SCRIPT = `
const $=(s)=>document.querySelector(s);
const esc=(s)=>String(s??"").replace(/[&<>"']/g,(c)=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const usd=(n)=>n==null?"–":"$"+Number(n).toLocaleString("en-US",{minimumFractionDigits:Math.abs(n)<100?2:0,maximumFractionDigits:Math.abs(n)<100?2:0});
const when=(t)=>t?new Date(t).toLocaleString():"–";
async function api(path,opt={}){const r=await fetch("/admin"+path,{...opt,headers:{"content-type":"application/json","x-wz-ui":"1"}});
 if(r.status===401){location.reload();throw new Error("signed out")}const ct=r.headers.get("content-type")||"";const j=ct.includes("json")?await r.json():{};if(!r.ok)throw new Error(j.error||("Error "+r.status));return j;}
const view=$("#view");
function tab(t){document.querySelectorAll("#tabs button").forEach(b=>b.classList.toggle("on",b.dataset.t===t));view.innerHTML='<p class="muted">Loading…</p>';(R[t]||R.overview)().catch(e=>view.innerHTML='<p class="err">'+esc(e.message)+'</p>');history.replaceState(null,"","#"+t);}
document.querySelectorAll("#tabs button").forEach(b=>b.onclick=()=>tab(b.dataset.t));
function table(rows,cols){if(!rows.length)return '<p class="muted small">Nothing here.</p>';return '<table><tr>'+cols.map(c=>'<th>'+c[0]+'</th>').join("")+'</tr>'+rows.map(r=>'<tr>'+cols.map(c=>'<td>'+c[1](r)+'</td>').join("")+'</tr>').join("")+'</table>';}
const act=async(fn,again)=>{try{await fn();again()}catch(e){alert(e.message)}};
const R={};
R.overview=async()=>{const o=await api("/overview");
 $("#op").innerHTML=o.operator.halted?'<span class="tag bad">Operator halted</span> <button class="btn sm good" id="opr">Resume</button>':'<span class="tag">Operator on'+(o.operator.intervalMs?' · every '+Math.round(o.operator.intervalMs/60000)+' min':' · manual')+'</span> <button class="btn sm alt" id="oprun">Run now</button> <button class="btn sm bad" id="opk">Kill switch</button>';
 const a=$("#opr"),b=$("#oprun"),c=$("#opk");if(a)a.onclick=()=>act(()=>api("/operator/resume",{method:"POST"}),()=>tab("overview"));
 if(b)b.onclick=()=>act(async()=>{const r=await api("/operator/run",{method:"POST"});alert("Operator run: "+r.proposals.length+" proposals, "+r.actions.length+" actions, "+r.invoices.length+" invoices, "+r.escalations.length+" escalations")},()=>tab("overview"));
 if(c)c.onclick=()=>{if(confirm("Stop the autonomous operator? Live optimisations keep running."))act(()=>api("/operator/kill",{method:"POST"}),()=>tab("overview"))};
 view.innerHTML='<div class="grid4">'+[[o.customers,"customers ("+o.activeCustomers+" active this month)"],[o.payingCustomers,"with a card on file"],[usd(o.spendUsd),"AI spend through WasteZero this month"],[usd(o.savingsUsd),"saved for customers this month"],[usd(o.feesThisMonthUsd),"fees earned this month"],[usd(o.collectedUsd),"collected all time"],[usd(o.unpaidUsd),"invoiced, not yet paid"],[o.pendingApprovals+" / "+o.outreachWaiting,"changes pending / outreach to approve"]].concat(o.ownUse?[[usd(o.ownUse.spendUsd)+" / "+usd(o.ownUse.savingsUsd),"WasteZero's own AI: spent / saved this month"]]:[]).map(x=>'<div class="card"><div class="stat">'+x[0]+'</div><div class="small muted">'+x[1]+'</div></div>').join("")+'</div>'+
 '<h2>Needs your attention</h2>'+table(o.escalations,[["When",e=>when(e.timestamp)],["What",e=>esc(e.message)]]);};
R.team=async()=>{const t=await api("/team");const w=t.tasks.filter(x=>x.status==="needs_approval");$("#wait").innerHTML=w.length?'<span class="tag warn">'+w.length+'</span>':'';
 const g=t.goals;const f=t.facts;
 view.innerHTML='<div class="row"><button class="btn sm" id="runall">Run the team now</button><button class="btn sm alt" id="newbrief">Write a fresh brief</button></div>'+
 (t.brief?'<div class="card"><h3>Daily brief · '+esc(t.brief.date)+' <span class="tag grey">'+(t.brief.writtenBy==="ai"?"written by Chief of Staff":"template")+'</span></h3><p style="white-space:pre-wrap">'+esc(t.brief.text)+'</p></div>':'<p class="muted">No brief yet. It is written once a day by the Chief of Staff.</p>')+
 (g?'<h2>This week · '+esc(g.week)+'</h2><div class="grid4">'+[["Signups",f.signupsLastWeek,g.targets.signups],["Activated",f.activatedLastWeek,g.targets.activations],["Outreach sent",f.outreachSentLastWeek,g.targets.outreach],["Fees",usd(f.lastWeek.feesUsd),usd(g.targets.feesUsd)]].map(x=>'<div class="card"><div class="stat">'+x[1]+'</div><div class="small muted">'+x[0]+' · target '+x[2]+'</div></div>').join("")+'</div><p class="small muted" style="white-space:pre-wrap;margin-top:10px">'+esc(g.focus)+'</p>':'')+
 '<h2>Waiting for your approval</h2>'+(w.length?w.map(x=>'<div class="card" style="margin:10px 0"><span class="tag warn">'+esc(x.owner)+'</span><h3 style="margin-top:6px">'+esc(x.title)+'</h3><p class="small" style="white-space:pre-wrap">'+esc(x.detail)+'</p>'+(x.approval&&x.approval.type==="send_email"?'<label>Reply to '+esc(x.approval.payload.to)+'</label><input data-sub="'+x.id+'" value="'+esc(x.approval.payload.subject)+'"><textarea data-txt="'+x.id+'" style="font-family:inherit;font-size:14px;min-height:140px">'+esc(x.approval.payload.text)+'</textarea>':'')+'<div class="row"><button class="btn sm good" data-ap="'+x.id+'">'+(x.approval&&x.approval.type==="send_email"?"Send":"Approve")+'</button><button class="btn sm alt" data-dc="'+x.id+'">Decline</button></div></div>').join(""):'<p class="muted small">Nothing waiting.</p>')+
 '<h2>The team</h2><div class="grid">'+t.agents.map(a=>'<div class="card"><h3>'+esc(a.name)+'</h3><p class="small muted">'+esc(a.role)+'</p><p class="small">'+(a.lastRunAt?'Last run '+when(a.lastRunAt)+': '+esc(a.lastSummary||""):'Not run yet')+(a.lastError?'<br><span class="err">'+esc(a.lastError)+'</span>':'')+'</p></div>').join("")+'</div>'+
 '<h2>Incidents</h2>'+table(t.incidents,[["Opened",i=>when(i.openedAt)],["What",i=>esc(i.title)],["Status",i=>i.closedAt?'<span class="tag">resolved '+when(i.closedAt)+'</span>':'<span class="tag bad">open</span>']])+
 '<h2>Task board</h2>'+table(t.tasks.filter(x=>x.status!=="needs_approval").slice(0,80),[["When",x=>when(x.createdAt)],["Owner",x=>esc(x.owner)],["Task",x=>esc(x.title)],["Status",x=>esc(x.status)],["",x=>x.status==="todo"?'<button class="btn sm alt" data-dn="'+x.id+'">Done</button>':'']]);
 $("#runall").onclick=()=>act(async()=>{const r=await api("/agents/run",{method:"POST",body:"{}"});alert(Object.entries(r.agents).map(([k,v])=>k+": "+v).join("\\n"))},()=>tab("team"));
 $("#newbrief").onclick=()=>act(()=>api("/brief",{method:"POST"}),()=>tab("team"));
 view.querySelectorAll("[data-ap]").forEach(b=>b.onclick=()=>{const id=b.dataset.ap;const s=view.querySelector('[data-sub="'+id+'"]'),x=view.querySelector('[data-txt="'+id+'"]');act(()=>api("/tasks/"+id+"/approve",{method:"POST",body:JSON.stringify(s?{edits:{subject:s.value,text:x.value}}:{})}),()=>tab("team"))});
 view.querySelectorAll("[data-dc]").forEach(b=>b.onclick=()=>act(()=>api("/tasks/"+b.dataset.dc+"/decline",{method:"POST",body:"{}"}),()=>tab("team")));
 view.querySelectorAll("[data-dn]").forEach(b=>b.onclick=()=>act(()=>api("/tasks/"+b.dataset.dn+"/done",{method:"POST",body:"{}"}),()=>tab("team")));};
R.customers=async()=>{const o=await api("/overview");
 view.innerHTML='<form id="nc" class="row"><input name="name" placeholder="Company" style="max-width:220px" required><input name="email" type="email" placeholder="Billing email" style="max-width:240px"><button class="btn" type="submit">Add customer</button></form><div id="nk"></div>'+
 table(o.tenants,[["Customer",t=>'<a href="#" data-c="'+t.id+'">'+esc(t.name)+'</a><div class="tiny muted">'+esc(t.email)+'</div>'],["Requests",t=>t.requests],["Spend",t=>usd(t.spendUsd)],["Saved",t=>usd(t.savingsUsd)],["Allowed",t=>esc(t.allowed.join(", ")||"observe-only")],["Card",t=>t.hasCard?"✓":"–"],["Status",t=>t.paused?'<span class="tag bad">paused</span>':'<span class="tag">active</span>'],["Last request",t=>when(t.lastRequestAt)]])+'<div id="detail"></div>';
 $("#nc").onsubmit=(ev)=>{ev.preventDefault();act(async()=>{const r=await api("/tenants",{method:"POST",body:JSON.stringify({name:ev.target.name.value,email:ev.target.email.value})});await R.customers();$("#nk").innerHTML='<div class="notice">API key for '+esc(r.tenant.name)+' (shown once):<pre>'+esc(r.apiKey)+'</pre></div>'},()=>{})};
 view.querySelectorAll("[data-c]").forEach(a=>a.onclick=(ev)=>{ev.preventDefault();detail(a.dataset.c)});};
async function detail(id){const {tenants}=await api("/tenants");const t=tenants.find(x=>x.id===id);const w=await api("/waste-report?tenant="+id);
 $("#detail").innerHTML='<div class="card" style="margin-top:18px"><h2 style="margin-top:0">'+esc(t.name)+'</h2><p class="small muted">'+esc(t.id)+' · '+esc(t.billing.email||"")+' · created '+when(t.createdAt)+'</p>'+
 '<div class="row"><button class="btn sm '+(t.paused?'good':'alt')+'" id="pz">'+(t.paused?'Resume traffic':'Pause traffic')+'</button><button class="btn sm alt" id="cl">Card link</button><button class="btn sm alt" id="rk">Rotate API key</button></div>'+
 '<h3>Waste found: '+usd(w.monthlyWasteUsd)+'/month</h3>'+table(w.findings,[["Finding",f=>esc(f.title)],["$/month",f=>usd(f.monthlyUsd)],["",f=>'<span class="tag '+(f.confidence==="estimated"?"est":"")+'">'+f.confidence+'</span>']])+
 '<h3 style="margin-top:16px">Policy</h3><textarea id="pol" style="min-height:260px">'+esc(JSON.stringify(t.policy,null,2))+'</textarea><div class="row"><button class="btn sm" id="sp">Save policy</button><span id="pm" class="small"></span></div></div>';
 $("#pz").onclick=()=>act(()=>api("/tenants/"+id+"/"+(t.paused?"resume":"pause"),{method:"POST",body:JSON.stringify({reason:"admin"})}),()=>detail(id));
 $("#cl").onclick=()=>act(async()=>{const r=await api("/tenants/"+id+"/card-link",{method:"POST"});prompt("Send this card link to the customer:",r.url)},()=>{});
 $("#rk").onclick=()=>{if(confirm("Revoke all of this customer's keys and issue a new one?"))act(async()=>{const r=await api("/tenants/"+id+"/rotate-key",{method:"POST"});prompt("New key (shown once):",r.apiKey)},()=>{})};
 $("#sp").onclick=()=>act(async()=>{await api("/tenants/"+id,{method:"PATCH",body:JSON.stringify({policy:JSON.parse($("#pol").value)})});$("#pm").innerHTML='<span class="ok">Saved</span>'},()=>{});
 $("#detail").scrollIntoView({behavior:"smooth"});}
R.approvals=async()=>{const [{rules:p},{rules:s},{tenants}]=await Promise.all([api("/rules?state=proposed"),api("/rules?state=shadow"),api("/tenants")]);
 const name=(id)=>esc((tenants.find(t=>t.id===id)||{}).name||id);const rows=[...p,...s];
 view.innerHTML='<p class="small muted">Customers approve their own changes in their dashboard. Use this to act on their behalf when they have asked you to.</p>'+table(rows,[["Customer",r=>name(r.tenantId)],["Change",r=>esc(r.type)+': '+esc(r.match.model)+(r.target?' → '+esc(r.target):'')+(r.match.tag?' ['+esc(r.match.tag)+']':'')],["≈ $/month",r=>usd(r.estMonthlySavingsUsd)],["State",r=>esc(r.state)+(r.state==="shadow"?' '+r.stats.shadow.passed+'/'+r.stats.shadow.n:'')],["",r=>'<button class="btn sm good" data-r="'+r.id+'" data-to="'+(r.state==="proposed"&&r.type==="route"?"shadow":"active")+'">'+(r.state==="proposed"&&r.type==="route"?"Start test":"Go live")+'</button> <button class="btn sm alt" data-r="'+r.id+'" data-to="rejected">Reject</button>']]);
 view.querySelectorAll("[data-r]").forEach(b=>b.onclick=()=>act(()=>api("/rules/"+b.dataset.r+"/transition",{method:"POST",body:JSON.stringify({to:b.dataset.to,reason:"admin console"})}),()=>tab("approvals")));};
R.invoices=async()=>{const [{invoices},{tenants}]=await Promise.all([api("/invoices"),api("/tenants")]);const name=(id)=>esc((tenants.find(t=>t.id===id)||{}).name||id);
 view.innerHTML='<form id="rc" class="row"><select name="t" style="max-width:220px">'+tenants.map(t=>'<option value="'+t.id+'">'+esc(t.name)+'</option>').join("")+'</select><input name="p" placeholder="YYYY-MM" style="max-width:120px" required><input name="b" type="number" step="0.01" placeholder="Provider bill $" style="max-width:160px" required><button class="btn" type="submit">Reconcile</button></form>'+
 table(invoices.slice().reverse(),[["Customer",i=>name(i.tenantId)],["Month",i=>esc(i.period)],["Saved",i=>usd(i.savingsUsd)],["Total",i=>usd(i.totalUsd??i.feeUsd)],["Status",i=>esc(i.status)],["",i=>'<a target="_blank" href="/admin/invoices?tenant='+i.tenantId+'&period='+i.period+'&format=html">View</a> '+(i.status!=="paid"?'<button class="btn sm alt" data-paid="'+i.id+'">Mark paid</button>':'')]]);
 $("#rc").onsubmit=(ev)=>{ev.preventDefault();const f=ev.target;act(async()=>{const r=await api("/reconcile",{method:"POST",body:JSON.stringify({tenantId:f.t.value,period:f.p.value,providerBilledUsd:Number(f.b.value)})});alert("Invoice "+r.invoice.id+": "+r.invoice.status)},()=>tab("invoices"))};
 view.querySelectorAll("[data-paid]").forEach(b=>b.onclick=()=>{if(confirm("Mark this invoice paid (paid outside the card system)?"))act(()=>api("/invoices/"+b.dataset.paid+"/status",{method:"POST",body:JSON.stringify({status:"paid",reason:"marked paid in console"})}),()=>tab("invoices"))});};
R.prospects=async()=>{const {prospects}=await api("/prospects");const drafted=prospects.filter(p=>p.state==="drafted");
 view.innerHTML='<div class="row"><button class="btn sm good" id="aa" '+(drafted.length?'':'disabled')+'>Approve all '+drafted.length+' drafted</button><button class="btn sm alt" id="pr">Run prospecting now</button></div>'+
 '<form id="imp" class="row"><input name="d" placeholder="Import domains: acme.ai, other.com" style="max-width:420px"><button class="btn sm" type="submit">Import</button></form>'+
 table(prospects.slice().reverse().slice(0,200),[["Company",p=>esc((p.company&&p.company.title)||p.domain)+'<div class="tiny muted">'+esc(p.domain)+'</div>'],["Contact",p=>esc(p.contactEmail||"–")],["Fit",p=>p.fit??"–"],["State",p=>esc(p.state)],["Why",p=>'<span class="small">'+esc(p.reason||"")+'</span>'],["",p=>p.state==="drafted"?'<button class="btn sm good" data-p="'+p.id+'" data-a="approve">Send</button> <button class="btn sm alt" data-p="'+p.id+'" data-a="reject">Skip</button>':'']]);
 $("#aa").onclick=()=>act(()=>api("/prospects/approve-all",{method:"POST"}),()=>tab("prospects"));
 $("#pr").onclick=()=>act(async()=>{const r=await api("/prospecting/run",{method:"POST"});alert(JSON.stringify(r.prospecting||r))},()=>tab("prospects"));
 $("#imp").onsubmit=(ev)=>{ev.preventDefault();act(()=>api("/prospects",{method:"POST",body:JSON.stringify({domains:ev.target.d.value.split(",").map(x=>x.trim()).filter(Boolean)})}),()=>tab("prospects"))};
 view.querySelectorAll("[data-p]").forEach(b=>b.onclick=()=>act(()=>api("/prospects/"+b.dataset.p+"/"+b.dataset.a,{method:"POST"}),()=>tab("prospects")));};
R.activity=async()=>{const {audit}=await api("/audit?limit=200");
 view.innerHTML=table(audit,[["When",a=>when(a.timestamp)],["Who",a=>esc(a.actor||"")],["",a=>a.level==="escalation"?'<span class="tag warn">needs you</span>':''],["What",a=>esc(a.message||a.action)]]);};
tab((location.hash||"#overview").slice(1));`;
