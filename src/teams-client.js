/* WasteZero for Teams: the "Team budgets" tab of the customer dashboard. Plain browser script. */
(function () {
  "use strict";
  window.WZTeams = async function (h) {
    const { view, api, esc, usd, table, when } = h;
    const pct = (x) => (x == null ? "–" : Math.round(x * 100) + "%");
    const bar = (x) => {
      if (x == null) return "";
      const w = Math.min(100, Math.round(x * 100));
      const c = x >= 1 ? "var(--bad)" : x >= 0.8 ? "var(--warn)" : "var(--accent)";
      return '<div style="background:#eef0f3;border-radius:99px;height:6px;width:90px;display:inline-block;vertical-align:middle;margin-left:6px"><div style="height:6px;border-radius:99px;width:' + w + '%;background:' + c + '"></div></div>';
    };
    const act = async (fn) => { try { await fn(); await render(); } catch (e) { alert(e.message); } };
    const send = (path, method, body) => api(path, { method, body: JSON.stringify(body || {}) });

    async function render() {
      const r = await api("/teams");
      const s = r.settings;
      const roleName = (id) => (r.roles.find((x) => x.id === id) || {}).name || id || "–";
      const teamName = (id) => (r.teams.find((x) => x.id === id) || {}).name || "–";
      const pending = r.exceptions.filter((x) => x.state === "pending");
      let html = "";

      html += '<div class="card"><div class="row" style="justify-content:space-between"><h3 style="margin:0">WasteZero for Teams</h3>' +
        '<label class="row" style="gap:6px;margin:0"><input type="checkbox" id="tEnabled" ' + (r.enabled ? "checked" : "") + '> On</label></div>' +
        '<p class="small muted">Monthly AI budgets for each employee, set by role. Each person gets their own WasteZero key for Claude Code, Cursor or scripts. Alerts go to them and their manager, and requests for more go up the approval chain.</p>' +
        (r.enabled ? '<p><strong>' + r.total.people + '</strong> people · budget <strong>' + usd(r.total.budgetUsd) + '</strong>/month · spent <strong>' + usd(r.total.spentUsd) + '</strong> this month' +
          (r.total.fallbacksThisMonth ? ' · ' + r.total.fallbacksThisMonth + ' requests moved to a cheaper model at the limit' : '') + '</p>' : '') + '</div>';

      if (pending.length) {
        html += '<h2>Waiting for approval</h2>' + table(pending, [
          ["Person", (x) => esc(x.person)], ["Extra", (x) => usd(x.amountUsd)], ["Term", (x) => '<span class="small">' + esc(x.term) + '</span>'],
          ["Why", (x) => '<span class="small">' + esc(x.reason) + (x.roi ? '<br><em>ROI:</em> ' + esc(x.roi) : '') + '</span>'],
          ["Approvers", (x) => '<span class="small">' + x.groups.map((g) => esc(g.name) + (g.approvedBy ? " ✓" : "")).join(", ") + '</span>'],
          ["", (x) => '<button class="btn sm good" data-ex="' + x.id + '" data-d="approve">Approve</button> <button class="btn sm alt" data-ex="' + x.id + '" data-d="decline">Decline</button>']
        ]);
      }

      html += '<h2>Teams</h2>' + table(r.teams, [
        ["Team", (t) => esc(t.name) + '<div class="tiny muted">' + t.members + ' people' + (t.lead ? ' · lead ' + esc(t.lead) : '') + '</div>'],
        ["Spent", (t) => usd(t.spentUsd) + ' / ' + usd(t.budgetUsd) + bar(t.pct)],
        ["Over budget", (t) => (t.overBudgetMembers ? '<span class="tag warn">' + t.overBudgetMembers + '</span>' : '0')]
      ]);

      html += '<h2>People</h2>' + (s.privacyMode ? '<p class="small muted">Privacy mode is on: individual spend is hidden. Team totals only.</p>' : '') +
        '<div id="newPersonKey"></div><div style="overflow-x:auto">' +
        table(r.people.slice(0, 500), [
          ["Person", (p) => esc(p.name || p.email) + '<div class="tiny muted">' + esc(p.email) + (p.managerEmail ? ' · reports to ' + esc(p.managerEmail) : '') + '</div>'],
          ["Role / team", (p) => esc(roleName(p.roleId)) + '<div class="tiny muted">' + esc(teamName(p.teamId)) + '</div>'],
          ["Budget", (p) => usd(p.budgetUsd) + (p.extraUsd ? '<div class="tiny muted">incl. ' + usd(p.extraUsd) + ' extra</div>' : '')],
          ["Spent", (p) => (s.privacyMode ? '<span class="muted">private</span>' : usd(p.spentUsd) + bar(p.pct))],
          ["Key", (p) => (p.hasKey ? '<span class="tag">yes</span>' : '<span class="tag grey">no</span>')],
          ["", (p) => '<button class="btn sm alt" data-inv="' + p.id + '">Email link</button> <button class="btn sm alt" data-key="' + p.id + '">New key</button>']
        ]) + '</div>' +
        (r.people.some((p) => !p.hasKey) ? '<p><button class="btn sm" id="invAll">Email everyone without a key</button></p>' : '');

      html += '<h2>Add or update people</h2><p class="small muted">Paste CSV with a header row: <code>email,name,role,team,manager_email,monthly_usd</code> (only email is required). New roles and teams are created automatically. Each team\'s lead is the manager most members report to.</p>' +
        '<textarea id="csv" rows="5" placeholder="email,name,role,team,manager_email\nada@acme.com,Ada,Technical,Platform,lin@acme.com\nlin@acme.com,Lin,Technical,Platform,cto@acme.com"></textarea>' +
        '<div class="row"><label class="row small" style="gap:6px;margin:0"><input type="checkbox" id="deact"> Deactivate people not in this list</label><button class="btn sm" id="imp">Import</button></div><div id="impOut"></div>';

      html += '<h2>Budgets by role</h2><div id="roles">' + r.roles.map((x) => '<div class="row" data-role><input value="' + esc(x.name) + '" data-n style="max-width:220px"> <span>$</span><input type="number" min="0" step="10" value="' + x.monthlyUsd + '" data-v style="max-width:120px"><span class="small muted">per month</span></div>').join("") +
        '</div><div class="row"><button class="btn sm alt" id="addRole">Add role</button><button class="btn sm" id="saveRoles">Save budgets</button></div>';

      html += '<h2>Rules</h2><div class="card">' +
        '<label>At the limit (after the team pool)</label><select id="onLimit"><option value="downgrade"' + (s.onLimit === "downgrade" ? " selected" : "") + '>Move to a cheaper model (work continues)</option><option value="block"' + (s.onLimit === "block" ? " selected" : "") + '>Stop until more budget is approved</option></select>' +
        '<label class="row" style="gap:6px"><input type="checkbox" id="usePool" ' + (s.usePool ? "checked" : "") + '> Pool each team\'s budgets, so one person\'s spike can be covered by others</label>' +
        '<label class="row" style="gap:6px"><input type="checkbox" id="privacy" ' + (s.privacyMode ? "checked" : "") + '> Privacy mode (works councils): managers see team totals only</label>' +
        '<label>Alert at (% of budget)</label><input id="alerts" value="' + esc(s.alertPcts.join(", ")) + '">' +
        '<label>Slack incoming webhook (optional)</label><input id="slack" value="' + esc(s.slackWebhookUrl || "") + '" placeholder="https://hooks.slack.com/services/...">' +
        '<label>Executive approvers for big requests (emails)</label><input id="execs" value="' + esc((s.execEmails || []).join(", ")) + '">' +
        '<label>Finance approvers (emails)</label><input id="fin" value="' + esc((s.financeEmails || []).join(", ")) + '">' +
        '<p class="small muted">Requests up to +20%: the person\'s second-line manager approves (this month). Up to 3× the budget: third-line manager, with an ROI note (90 days). Above 3×: an executive and finance (30 days, reviewed monthly). If a manager is missing, your account email approves.</p>' +
        '<button class="btn" id="saveRules">Save rules</button></div>';

      html += '<h2>Provider keys</h2><p class="small muted">Store your company\'s Anthropic or OpenAI key here (encrypted), so employees only need their WasteZero key. ' +
        (r.providerKeys.length ? 'Stored: ' + r.providerKeys.map((n) => '<code>' + esc(n) + '</code> <a href="#" data-delpk="' + esc(n) + '">remove</a>').join(" · ") : 'None stored yet.') + '</p>' +
        '<div class="row"><select id="pkName"><option>anthropic</option><option>openai</option><option>gemini</option><option>openrouter</option><option>deepseek</option><option>kimi</option></select><input id="pkKey" type="password" placeholder="Provider API key" style="max-width:320px"><button class="btn sm" id="savePk">Store key</button></div>';

      if (r.exceptions.some((x) => x.state !== "pending")) {
        html += '<h2>Past requests</h2>' + table(r.exceptions.filter((x) => x.state !== "pending").slice(0, 50), [
          ["Person", (x) => esc(x.person)], ["Extra", (x) => usd(x.amountUsd)], ["Status", (x) => '<span class="tag ' + (x.state === "approved" ? "" : "grey") + '">' + esc(x.state) + '</span>'],
          ["Until", (x) => (x.expiresAt ? esc(x.expiresAt.slice(0, 10)) : "–")], ["Asked", (x) => when(x.createdAt)]
        ]);
      }
      view.innerHTML = html;

      const $ = (sel) => view.querySelector(sel);
      $("#tEnabled").onchange = (e) => act(() => send("/teams/settings", "PATCH", { enabled: e.target.checked }));
      view.querySelectorAll("[data-ex]").forEach((b) => (b.onclick = () => act(() => send("/teams/exceptions/" + b.dataset.ex + "/" + b.dataset.d, "POST"))));
      view.querySelectorAll("[data-inv]").forEach((b) => (b.onclick = () => act(async () => { await send("/teams/people/" + b.dataset.inv + "/invite", "POST"); alert("Link sent."); })));
      view.querySelectorAll("[data-key]").forEach((b) => (b.onclick = async () => {
        if (!confirm("Create a new key for this person? Their old key stops working.")) return;
        try { const k = await send("/teams/people/" + b.dataset.key + "/key", "POST"); $("#newPersonKey").innerHTML = '<div class="notice"><strong>Key for ' + esc(k.email) + ' (copy now; shown once):</strong><pre>' + esc(k.apiKey) + '</pre>Better: use "Email link", so they create their own key and you never see it.</div>'; } catch (e) { alert(e.message); }
      }));
      const ia = $("#invAll"); if (ia) ia.onclick = () => act(async () => { const x = await send("/teams/invite-all", "POST"); alert("Sent " + x.invited + " links."); });
      $("#imp").onclick = async () => {
        try { const x = await send("/teams/import", "POST", { csv: $("#csv").value, deactivateMissing: $("#deact").checked }); await render(); view.querySelector("#impOut").innerHTML = '<p class="ok">Added ' + x.result.added + ', updated ' + x.result.updated + (x.result.deactivated ? ', deactivated ' + x.result.deactivated : '') + '.</p>' + (x.result.errors.length ? '<p class="err small">' + x.result.errors.slice(0, 10).map(esc).join("<br>") + '</p>' : ''); } catch (e) { alert(e.message); }
      };
      $("#addRole").onclick = () => { const d = document.createElement("div"); d.className = "row"; d.setAttribute("data-role", ""); d.innerHTML = '<input placeholder="Role name" data-n style="max-width:220px"> <span>$</span><input type="number" min="0" step="10" value="100" data-v style="max-width:120px"><span class="small muted">per month</span>'; $("#roles").appendChild(d); };
      $("#saveRoles").onclick = () => act(() => {
        const roles = [...view.querySelectorAll("[data-role]")].map((d) => {
          const name = d.querySelector("[data-n]").value.trim();
          const existing = r.roles.find((x) => x.name === name);
          return { id: existing ? existing.id : name, name, monthlyUsd: Number(d.querySelector("[data-v]").value) };
        }).filter((x) => x.name);
        return send("/teams/roles", "PUT", { roles });
      });
      $("#saveRules").onclick = () => act(() => send("/teams/settings", "PATCH", {
        onLimit: $("#onLimit").value, usePool: $("#usePool").checked, privacyMode: $("#privacy").checked, alertPcts: $("#alerts").value,
        slackWebhookUrl: $("#slack").value, execEmails: $("#execs").value, financeEmails: $("#fin").value
      }));
      $("#savePk").onclick = () => act(async () => { await send("/teams/provider-keys", "PUT", { provider: $("#pkName").value, key: $("#pkKey").value }); });
      view.querySelectorAll("[data-delpk]").forEach((a) => (a.onclick = (e) => { e.preventDefault(); if (confirm("Remove the stored " + a.dataset.delpk + " key?")) act(() => api("/teams/provider-keys/" + a.dataset.delpk, { method: "DELETE" })); }));
    }
    await render();
  };
})();
