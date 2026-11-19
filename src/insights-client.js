/* WasteZero dashboard: the Security and Insights tabs. Plain browser script. */
(function () {
  "use strict";
  const money = (n, d) => (n == null ? "–" : "$" + Number(n).toLocaleString("en-US", { minimumFractionDigits: d == null ? 2 : d, maximumFractionDigits: d == null ? 2 : d }));
  const pct = (n) => (n == null ? "–" : Math.round(n * 10) / 10 + "%");
  const counts = (o) => Object.entries(o || {}).map(([k, v]) => k.replace(/_/g, " ") + " ×" + v).join(", ") || "–";

  // ------------------------------------------------------------ Security
  window.WZSecurity = async function (h) {
    const { view, api, esc, table, when } = h;
    const period = new Date().toISOString().slice(0, 7);
    async function render() {
      const r = await api("/security?period=" + period);
      const fw = r.firewall, br = r.breaker;
      const opt = (v, cur, label) => '<option value="' + v + '"' + (v === cur ? " selected" : "") + ">" + label + "</option>";
      const modes = (cur) => opt("off", cur, "Off") + opt("monitor", cur, "Log only") + opt("mask", cur, "Mask before sending") + opt("block", cur, "Block the request");
      let html = "";
      html += '<h2>Circuit breaker</h2><div class="card"><p class="small muted">Pauses one runaway agent session (a stuck Claude Code run, a looping script) without stopping the rest of your account. The engineer and their manager get an alert with a resume link.</p>' +
        '<div class="grid"><div><label>When a session trips</label><select id="brAction">' + opt("pause", br.action, "Pause that session") + opt("alert", br.action, "Alert only") + opt("off", br.action, "Off") + '</select></div>' +
        '<div><label>Spend limit per session, per 10 minutes ($)</label><input id="brUsd" type="number" min="0.5" step="0.5" value="' + br.usdPer10Min + '"></div>' +
        '<div><label>Same failing step, times in a row</label><input id="brRep" type="number" min="3" value="' + br.repeatLimit + '"></div>' +
        '<div><label>Pause length (minutes)</label><input id="brMin" type="number" min="5" value="' + br.pauseMinutes + '"></div></div>' +
        '<button class="btn sm" id="saveBr" style="margin-top:10px">Save</button></div>';
      html += r.paused.length ? '<h3>Paused now</h3>' + table(r.paused, [["Session", (s) => esc(s.label || "–")], ["Why", (s) => '<span class="small">' + esc(s.reason || "") + '</span>'], ["Until", (s) => when(s.until)], ["", (s) => '<button class="btn sm" data-resume="' + esc(s.key) + '">Resume</button>']]) : '<p class="small muted">No sessions paused.</p>';

      html += '<h2>Secrets &amp; personal-data firewall</h2><div class="card"><p class="small muted">Every prompt is checked before it leaves for the AI provider: API keys, passwords, private keys and connection strings (secrets), and emails, phone numbers, card numbers and ID numbers (personal data). Only the type and count are recorded, never the value.</p>' +
        '<div class="grid"><div><label>Secrets</label><select id="fwS">' + modes(fw.settings.secrets) + '</select></div><div><label>Personal data</label><select id="fwP">' + modes(fw.settings.pii) + '</select></div></div>' +
        '<button class="btn sm" id="saveFw" style="margin-top:10px">Save</button></div>';
      html += '<h3>This month (' + esc(period) + ')</h3><div class="grid4">' + [[fw.requestsWithFindings, "requests with findings"], [fw.byAction.masked, "values masked"], [fw.byAction.blocked, "values blocked"], [fw.byAction.logged, "values logged"]].map(([n, l]) => '<div class="card"><h3 style="margin:0">' + n + '</h3><p class="small muted">' + l + '</p></div>').join("") + '</div>';
      const types = Object.entries(fw.byType).map(([t, v]) => ({ t, ...v })).sort((a, b) => b.count - a.count);
      if (types.length) html += table(types, [["Found", (x) => esc(x.t.replace(/_/g, " "))], ["Kind", (x) => (x.kind === "secrets" ? '<span class="tag warn">secret</span>' : '<span class="tag grey">personal data</span>')], ["Count", (x) => x.count]]);
      if (fw.top.length) html += '<h3>Where it comes from</h3>' + table(fw.top, [["Person or feature", (x) => esc(x.who)], ["Requests", (x) => x.requests]]);
      html += '<p class="small"><a href="/app/api/security.csv?period=' + period + '">Download the compliance report (CSV)</a> for your auditors.</p>';
      view.innerHTML = html;
      const $ = (s) => view.querySelector(s);
      const save = (body) => api("/settings", { method: "PATCH", body: JSON.stringify(body) }).then(render).catch((e) => alert(e.message));
      $("#saveBr").onclick = () => save({ breaker: { action: $("#brAction").value, usdPer10Min: Number($("#brUsd").value), repeatLimit: Number($("#brRep").value), pauseMinutes: Number($("#brMin").value) } });
      $("#saveFw").onclick = () => save({ firewall: { secrets: $("#fwS").value, pii: $("#fwP").value } });
      view.querySelectorAll("[data-resume]").forEach((b) => (b.onclick = () => api("/security/resume", { method: "POST", body: JSON.stringify({ key: b.dataset.resume }) }).then(render).catch((e) => alert(e.message))));
    }
    await render();
  };

  // ------------------------------------------------------------ Insights
  window.WZInsights = async function (h) {
    const { view, api, esc, table } = h;
    async function render() {
      const r = await api("/insights");
      const b = r.benchmarks, roi = r.roi, seats = r.seats, m = r.margins, batch = r.batch;
      let html = "";

      // Benchmarks
      html += '<h2>How you compare</h2>';
      if (b.insights.length) html += '<div class="notice">' + b.insights.map(esc).join("<br>") + '</div>';
      html += table(b.rows, [
        ["Measure", (x) => esc(x.label)],
        ["You", (x) => fmt(x, x.you)],
        ["Peers (median)", (x) => (x.enough ? fmt(x, x.median) + '<div class="tiny muted">middle half ' + fmt(x, x.p25) + "–" + fmt(x, x.p75) + '</div>' : '<span class="muted small">needs ' + b.minCompanies + '+ companies (' + x.companies + ' so far)</span>')],
        ["", (x) => (x.verdict === "worse" ? '<span class="tag warn">behind</span>' : x.verdict === "better" ? '<span class="tag">ahead</span>' : "")]
      ]);
      html += '<label class="row small" style="gap:6px"><input type="checkbox" id="share" ' + (b.sharing ? "checked" : "") + '> Share our anonymous totals with the benchmark (no prompts or names; shown only when 5+ companies take part)</label>';

      // ROI
      html += '<h2>What AI spend produced</h2>';
      const c = roi.company;
      html += '<div class="grid4">' + [[money(c.spentUsd), "AI spend this month"], [c.prs, "merged pull requests"], [c.tickets, "tickets done"], [c.usdPerPr != null ? money(c.usdPerPr) : (c.usdPerTicket != null ? money(c.usdPerTicket) : "–"), c.usdPerPr != null ? "AI cost per pull request" : "AI cost per ticket"]].map(([n, l]) => '<div class="card"><h3 style="margin:0">' + n + '</h3><p class="small muted">' + l + '</p></div>').join("") + '</div>';
      if (roi.teams.length) html += table(roi.teams, [["Team", (t) => esc(t.name)], ["Spend", (t) => money(t.spentUsd)], ["PRs", (t) => t.prs], ["Tickets", (t) => t.tickets], ["$ / PR", (t) => money(t.usdPerPr)]]);
      if (roi.people.length) html += '<details><summary class="small">By person</summary>' + table(roi.people.slice(0, 200), [["Person", (p) => esc(p.name || p.email)], ["Spend", (p) => money(p.spentUsd)], ["PRs", (p) => p.prs], ["Tickets", (p) => p.tickets], ["$ / PR", (p) => money(p.usdPerPr)]]) + '</details>';
      if (roi.unmatchedGithub.length) html += '<p class="small muted">GitHub users not matched to anyone (add a <code>github</code> column to your people CSV): ' + roi.unmatchedGithub.map(esc).join(", ") + '</p>';
      const gh = roi.connected.github, jr = roi.connected.jira;
      html += '<div class="card"><h3>Connections</h3><p class="small muted">Read-only. Tokens are stored encrypted. ' + (roi.syncedAt ? "Last synced " + esc(new Date(roi.syncedAt).toLocaleString()) + "." : "Not synced yet.") + (Object.keys(roi.errors).length ? ' <span class="err">' + esc(Object.entries(roi.errors).map(([k, v]) => k + ": " + v).join("; ")) + '</span>' : '') + '</p>' +
        '<div class="grid"><div><label>GitHub organisation</label><input id="ghOrg" value="' + esc(gh ? gh.org : "") + '" placeholder="acme"><label>GitHub token ' + (gh ? "(stored " + esc(gh.tokenHint || "") + ")" : "") + '</label><input id="ghTok" type="password" placeholder="' + (gh ? "leave blank to keep" : "fine-grained token, read-only: pull requests") + '"></div>' +
        '<div><label>Jira site</label><input id="jrSite" value="' + esc(jr ? jr.site : "") + '" placeholder="https://yourcompany.atlassian.net"><label>Jira account email</label><input id="jrEmail" value="' + esc(jr ? jr.email : "") + '"><label>Jira API token ' + (jr ? "(stored)" : "") + '</label><input id="jrTok" type="password" placeholder="' + (jr ? "leave blank to keep" : "") + '"></div></div>' +
        '<div class="row"><button class="btn sm" id="saveInt">Save connections</button><button class="btn sm alt" id="sync">Sync now</button></div></div>';

      // Seats
      html += '<h2>Seats or pay-per-use</h2><p>' + (seats.moveToSeat ? '<strong>' + seats.moveToSeat + '</strong> people would cost less on a subscription seat: about <strong>' + money(seats.totalMonthlySavingUsd, 0) + '/month</strong>.' : "Nobody would clearly save by switching to a seat right now.") + (seats.payingTwice ? ' <span class="tag warn">' + seats.payingTwice + ' paying twice</span>' : '') + '</p>';
      const advice = seats.people.filter((p) => p.action === "seat" || p.action === "check");
      if (advice.length) html += table(advice, [["Person", (p) => esc(p.name || p.email)], ["Pay-per-use (30 days)", (p) => money(p.spend30dUsd)], ["Advice", (p) => '<span class="small">' + esc(p.action === "seat" ? "Move to: " + p.plan : p.note) + '</span>'], ["Saves / month", (p) => (p.monthlySavingUsd ? money(p.monthlySavingUsd, 0) : "–")]]);
      html += '<p class="tiny muted">' + esc(seats.note) + ' Plans compared: ' + seats.plans.map((p) => esc(p.name) + " " + money(p.priceUsd, 0)).join(" · ") + '</p>';

      // Prepaid credits
      html += '<h2>Prepaid credits</h2>';
      if (r.credits.length) html += table(r.credits, [["Credit", (x) => esc((x.provider || "any") + (x.note ? " · " + x.note : ""))], ["Used", (x) => money(x.usedUsd, 0) + " / " + money(x.amountUsd, 0)], ["Expires", (x) => (x.expired ? "expired" : x.daysLeft + " days")],
        ["Forecast", (x) => (x.atRisk ? '<span class="tag warn">' + money(x.projectedUnusedUsd, 0) + ' unused</span><div class="tiny muted">use ' + money(x.neededPerDayUsd, 0) + '/day</div>' : '<span class="tag">on track</span>')]]);
      else html += '<p class="small muted">Bought prepaid credit or a commitment from a provider? Add it, and WasteZero warns you before any of it expires unused, and routes eligible traffic to it first.</p>';
      html += '<div class="row"><select id="crProv"><option>anthropic</option><option>openai</option><option>gemini</option><option>openrouter</option></select><input id="crAmt" type="number" min="1" placeholder="Amount $" style="max-width:110px"><input id="crStart" type="date" style="max-width:150px"><input id="crEnd" type="date" style="max-width:150px"><input id="crNote" placeholder="Note" style="max-width:140px"><button class="btn sm" id="addCr">Add</button></div>';

      // Batch
      html += '<h2>Work that can wait: half price</h2><p>' + (batch.possibleMonthlySavingUsd ? 'Background work could save about <strong>' + money(batch.possibleMonthlySavingUsd) + '/month</strong> through the providers’ batch services. ' : '') + (batch.deferredSavedUsd ? 'Saved so far with deferred requests: <strong>' + money(batch.deferredSavedUsd) + '</strong>.' : '') + '</p>';
      if (batch.tags.length) html += table(batch.tags, [["Feature (tag)", (t) => esc(t.tag)], ["Requests", (t) => t.requests], ["Cost (30 days)", (t) => money(t.costUsd)], ["Could save", (t) => money(t.possibleSavingUsd)]]);
      html += '<p class="small muted">Send requests that don’t need an instant answer (evaluations, reports, backfills) to <code>/v1/deferred/chat/completions</code> or <code>/v1/deferred/messages</code>. You get a job id back; fetch the result from <code>/v1/deferred/{id}</code>, or add <code>X-WasteZero-Callback: https://...</code> to be sent it. <a href="/docs#deferred">How it works</a>.</p>';

      // Margins
      html += '<h2>AI cost per customer and feature</h2>';
      html += '<p class="small">' + (m.atRiskUsers ? '<span class="tag warn">' + m.atRiskUsers + ' customers above ' + m.marginAlertPct + '% of their plan price</span> ' : '') + (m.losingUsers ? '<span class="tag warn">' + m.losingUsers + ' cost more than they pay</span>' : '') + '</p>';
      if (m.features.length) html += table(m.features.slice(0, 20), [["Feature", (f) => esc(f.feature)], ["Cost", (f) => money(f.costUsd)], ["Share", (f) => pct(f.sharePct)], ["Users", (f) => f.users], ["Per user", (f) => money(f.costPerUserUsd, 4)]]);
      const risky = m.users.filter((u) => u.atRisk);
      if (risky.length) html += '<h3>Customers to watch</h3>' + table(risky.slice(0, 50), [["Customer", (u) => esc(u.label || u.user.slice(0, 12))], ["Plan", (u) => esc(u.plan || "–")], ["AI cost", (u) => money(u.costUsd)], ["Of price", (u) => pct(u.costPctOfPrice)]]);
      html += '<div class="row small"><label style="margin:0">Alert when a customer’s AI cost passes</label><input id="mPct" type="number" min="1" value="' + m.marginAlertPct + '" style="max-width:80px">% of their plan price <button class="btn sm alt" id="saveM">Save</button></div><p class="tiny muted">Send <code>X-WasteZero-User</code> and <code>X-WasteZero-Plan</code> with requests, and set plan prices under Protection &amp; settings.</p>';

      view.innerHTML = html;
      const $ = (s) => view.querySelector(s);
      const patch = (body) => api("/insights/settings", { method: "PATCH", body: JSON.stringify(body) }).then(render).catch((e) => alert(e.message));
      $("#share").onchange = (e) => patch({ shareBenchmarks: e.target.checked });
      $("#saveM").onclick = () => patch({ marginAlertPct: Number($("#mPct").value) });
      $("#addCr").onclick = () => {
        const start = $("#crStart").value, end = $("#crEnd").value;
        if (!start || !end) return alert("Pick the start and expiry dates");
        patch({ credits: [...(r.policy.credits || []), { provider: $("#crProv").value, amountUsd: Number($("#crAmt").value), startAt: start, expiresAt: end, note: $("#crNote").value }] });
      };
      $("#saveInt").onclick = () => {
        const body = {};
        if ($("#ghOrg").value.trim()) body.github = { org: $("#ghOrg").value.trim(), token: $("#ghTok").value.trim() };
        if ($("#jrSite").value.trim()) body.jira = { site: $("#jrSite").value.trim(), email: $("#jrEmail").value.trim(), token: $("#jrTok").value.trim() };
        if (!Object.keys(body).length) return alert("Fill in GitHub or Jira first");
        api("/insights/integrations", { method: "PUT", body: JSON.stringify(body) }).then(render).catch((e) => alert(e.message));
      };
      $("#sync").onclick = () => api("/insights/roi/sync", { method: "POST" }).then(render).catch((e) => alert(e.message));
    }
    function fmt(row, v) {
      if (v == null) return "–";
      return row.unit === "pct" ? pct(v) : row.unit === "usd4" ? money(v, 4) : money(v);
    }
    await render();
  };
})();
