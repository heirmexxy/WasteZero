import { layout } from "./ui.js";
import { DEFAULT_POLICY } from "./tenants.js";
import { escapeHtml } from "./util.js";

// Static public pages: pricing, docs, privacy, terms.
export const PAGE_PATHS = new Set(["/pricing", "/docs", "/privacy", "/terms", "/teams"]);

const who = (config) => escapeHtml(config.operatorName || "WasteZero");
const contact = (config) => escapeHtml(config.contactEmail || config.email?.replyTo || config.email?.from || "");

const seatLine = (config) => (config.billing?.teamsSeatUsd > 0
  ? `$${config.billing.teamsSeatUsd} per employee per month, only for employees who used AI that month, plus your usual share of verified savings.`
  : "Included at no extra cost during early access. You pay only the usual share of the savings we verify.");

function teams(config) {
  return layout("WasteZero for Teams · AI budgets for every employee", `
<span class="tag">WasteZero for Teams</span>
<h1 style="margin-top:10px">AI budgets for every employee, without slowing anyone down</h1>
<p class="muted" style="font-size:18px;max-width:680px">Coding agents and AI assistants can cost thousands of dollars a month per person. Salesforce now gives every role a monthly token budget, Coinbase caps weekly AI spend by role and JPMorgan limits Claude Code per engineer. WasteZero gives your company the same controls on day one, and moves routine work to cheaper models automatically so people stay under budget.</p>
<div class="row" style="margin:18px 0 8px"><a class="btn" href="/signup">Set up Teams</a><a class="btn alt" href="/signin">Already a customer? Sign in</a></div>
<p class="small muted">Then open <strong>Team budgets</strong> in your dashboard.</p>

<h2>How it works</h2>
<div class="grid4">
<div class="card"><span class="tag">1</span><h3>Import your people</h3><p class="muted small">Paste a CSV: email, role, team, manager. Set a monthly budget per role, for example $1,000 technical and $100 non-technical.</p></div>
<div class="card"><span class="tag">2</span><h3>Everyone gets a key</h3><p class="muted small">Each employee creates their own WasteZero key and points Claude Code, Cursor or their scripts at it. Store your provider key once, encrypted.</p></div>
<div class="card"><span class="tag">3</span><h3>Spend is tracked live</h3><p class="muted small">By person, team and role. Alerts at 80% and 100% go to the employee and their manager, by email or Slack.</p></div>
<div class="card"><span class="tag">4</span><h3>No hard stops</h3><p class="muted small">A team's budgets pool together. At the limit, requests move to a cheaper model, or stop until more is approved, as you choose.</p></div>
</div>

<h2>Built in</h2>
<div class="grid">
<div class="card"><h3>Approval chain</h3><p class="small muted">Need more? Up to +20% goes to the person's manager's manager. Up to 3× needs an ROI note and one level higher. Above that, an executive and finance. Approvers decide from a link in their email. Extra budget expires and comes back for review.</p></div>
<div class="card"><h3>Automatic savings</h3><p class="small muted">Answer reuse, prompt caching and tested cheaper models apply to every request. You don't have to ask people to "match the model to the task".</p></div>
<div class="card"><h3>Privacy mode</h3><p class="small muted">For works-council countries: managers see team totals only, never one person's spend.</p></div>
<div class="card"><h3>Any provider</h3><p class="small muted">Anthropic, OpenAI, Gemini, DeepSeek, Kimi and OpenRouter, in their own formats. Claude Code works with two settings.</p></div>
<div class="card"><h3>Dashboards</h3><p class="small muted">Employees see their own budget. Managers see their team. Finance sees the whole company, and what was saved.</p></div>
<div class="card"><h3>Fair billing</h3><p class="small muted">A request moved to a cheaper model because of a budget is never counted as savings, so you're never charged a fee on it.</p></div>
</div>

<h2>Pricing</h2>
<p>${seatLine(config)}</p>
<p class="small muted">Works with API-billed AI usage (for example Claude Code with an API key, or your own apps). Flat-fee seat subscriptions don't route through WasteZero.</p>
<div class="row"><a class="btn" href="/signup">Set up Teams</a><a class="btn alt" href="/contact">Talk to us</a></div>`, { active: "/teams", desc: "Monthly AI budgets per employee, team pools, approval chains and automatic savings for Claude Code, Cursor and every AI tool." });
}

function pricing(config) {
  const pct = DEFAULT_POLICY.revenueSharePct;
  return layout("Pricing · WasteZero", `
<h1>You pay from what we save</h1>
<p class="muted" style="font-size:18px;max-width:640px">No subscription to start. WasteZero earns ${pct}% of the savings it can prove on your provider bill. If it saves nothing, you pay nothing.</p>
<div class="grid" style="margin-top:24px">
<div class="card"><span class="tag">Free</span><h3 style="margin-top:8px">Waste audit</h3><p class="small muted">Upload a usage export or connect read-only usage data. See waste in dollars per month. No code change.</p><a class="btn sm" href="/audit">Run an audit</a></div>
<div class="card"><span class="tag">Free</span><h3 style="margin-top:8px">Observe-only</h3><p class="small muted">Route traffic through WasteZero. Spend by feature, customer and model, runaway-spend protection and alerts, with no changes to your traffic.</p><a class="btn sm" href="/signup">Start</a></div>
<div class="card"><span class="tag">${pct}% of verified savings</span><h3 style="margin-top:8px">Savings</h3><p class="small muted">Answer reuse, prompt caching, cheaper models after quality tests, cheapest provider for open models. Each saved request is listed in a statement you can check.</p></div>
<div class="card"><span class="tag">For companies</span><h3 style="margin-top:8px">Teams: AI budgets per employee</h3><p class="small muted">Budgets by role, team pools, alerts, an approval chain and per-person keys for Claude Code and Cursor. ${seatLine(config)}</p><a class="btn sm" href="/teams">See Teams</a></div>
</div>
<h2>Questions</h2>
<p><strong>How is a saving measured?</strong> For each request WasteZero changed: what it would have cost at the model and price you asked for, minus what it actually cost. Losses net against gains.</p>
<p><strong>Who pays the AI provider?</strong> Normally you do, with your own key, as today. If you choose to use WasteZero's provider keys instead, that usage is billed to you at cost on the same monthly invoice.</p>
<p><strong>Can quality drop?</strong> Changes go live only after they pass quality tests on your real traffic, and they are re-checked continuously. If quality slips, they switch off on their own.</p>
<p><strong>How do I pay?</strong> By card, monthly, through Stripe or Paystack. Paystack lets African customers pay in local currency.</p>
<div class="row"><a class="btn" href="/audit">Get a free audit</a><a class="btn alt" href="/signup">Create account</a></div>`, { active: "/pricing" });
}

function docs(config) {
  const base = escapeHtml(config.publicBaseUrl || "https://wastezero.tech");
  return layout("Docs · WasteZero", `
<h1>Connect in two minutes</h1>
<p class="muted">Keep your SDK and your provider key. Change the base URL and add your WasteZero key. Your provider still bills you directly.</p>
<h2>OpenAI SDK (OpenAI, Gemini, Kimi, DeepSeek, OpenRouter)</h2>
<pre>from openai import OpenAI
client = OpenAI(
    base_url="${base}/v1",
    api_key="wz_...",                                   # your WasteZero key
    default_headers={
        "X-Upstream-Authorization": "Bearer sk-...",     # your key for the provider
        "X-WasteZero-Tag": "support-bot",                # feature name (optional)
        "X-WasteZero-User": "customer-123",              # your end user (optional)
    },
)</pre>
<p class="small muted">WasteZero picks the provider from the model name: <code>gpt-…</code> OpenAI, <code>claude-…</code> Anthropic, <code>gemini-…</code> Google, <code>kimi-…</code> Moonshot, <code>deepseek-…</code> DeepSeek, <code>org/model</code> OpenRouter. To choose yourself, send <code>X-WasteZero-Provider</code>.</p>
<h2>Anthropic SDK (Claude)</h2>
<pre>from anthropic import Anthropic
client = Anthropic(
    base_url="${base}",
    api_key="wz_...",
    default_headers={"X-Upstream-Authorization": "sk-ant-..."},
)</pre>
<h2>Keep working if WasteZero is ever unreachable</h2>
<pre>try:
    reply = client.chat.completions.create(**params)
except (openai.APIConnectionError, openai.APITimeoutError):
    reply = direct_openai_client.chat.completions.create(**params)</pre>
<p class="small muted">Don't catch WasteZero's 429 replies: those are the budget caps, loop breaker and pauses you set.</p>
<h2>Headers</h2>
<table>
<tr><th>Header</th><th>What it does</th></tr>
<tr><td><code>Authorization: Bearer wz_…</code> or <code>x-api-key</code></td><td>Your WasteZero key</td></tr>
<tr><td><code>X-Upstream-Authorization</code></td><td>Your key for the provider being called. Used for the request and never stored.</td></tr>
<tr><td><code>X-WasteZero-Tag</code></td><td>Feature name: spend, budgets and answer reuse per feature</td></tr>
<tr><td><code>X-WasteZero-User</code></td><td>Your end user: per-user budgets and profit per customer</td></tr>
<tr><td><code>X-WasteZero-Plan</code></td><td>That user's plan (for example <code>pro</code>): profit per plan</td></tr>
<tr><td><code>X-WasteZero-Provider</code></td><td>Choose the provider yourself</td></tr>
</table>
<p class="small muted" style="margin-top:12px">Every answer carries <code>X-WasteZero-Overhead-Ms</code>, the delay WasteZero added.</p>
<h2>Your dashboard</h2>
<p>Everything else (settings, budgets, approvals, keys, invoices) is in the <a href="/signin">dashboard</a>.</p>`, { active: "/docs" });
}

function privacy(config) {
  return layout("Privacy · WasteZero", `
<h1>Privacy</h1>
<p class="muted">Plain-language summary of what ${who(config)} ("WasteZero") collects and why.</p>
<h2>What passes through and what is kept</h2>
<ul>
<li><strong>Prompts and answers pass through</strong> WasteZero on their way to your AI provider. They are <strong>not written to disk</strong>.</li>
<li>If you allow <em>answer reuse</em>, recent answers are held <strong>in memory only</strong>, for the time you set, to answer identical repeat requests.</li>
<li>If you allow <em>quality testing</em>, a sample of requests is also sent to a second model and to a grading model. Scores are kept. Example answers are kept only if you turn on <em>keep test samples</em>, to show you side-by-side comparisons, and you can turn it off at any time.</li>
<li>For every request we keep: time, model, provider, token counts, cost, savings, status, delay, the feature tag you send, a one-way hash of the request, and a one-way hash of your end-user ID (or the ID itself if you turn on <em>show end-user IDs</em>).</li>
<li>Provider keys you send in <code>X-Upstream-Authorization</code> are used for that request and never stored. WasteZero API keys are stored only as hashes.</li>
</ul>
<h2>Messages you send us</h2>
<p>Emails and contact-form messages are kept so we can answer them. An AI assistant may read them to sort them and draft a reply; a person approves replies before they are sent unless you've asked us something routine.</p>
<h2>Account and billing</h2>
<p>We keep your company name, billing email and website. Card details are held by our payment provider (Stripe or Paystack), not by us. We keep a reference to the saved card and the last four digits.</p>
<h2>Audits</h2>
<p>Free audits keep the summary report and, if you give one, your email. An OpenAI admin key used for an audit is used once and never stored.</p>
<h2>Retention and deletion</h2>
<p>Request records are kept for as long as you have an account, so savings can be checked against invoices. To delete your account and data, email ${contact(config) || "us"}.</p>
<h2>Sharing</h2>
<p>We share data only with the services needed to run WasteZero: your chosen AI providers, our payment provider and our email provider. We don't sell data.</p>
${contact(config) ? `<p>Questions: ${contact(config)}</p>` : ""}`);
}

function terms(config) {
  const pct = DEFAULT_POLICY.revenueSharePct;
  return layout("Terms · WasteZero", `
<h1>Terms of service</h1>
<p class="muted">The key terms for using WasteZero, operated by ${who(config)}.</p>
<h2>The service</h2>
<p>WasteZero sits between your application and your AI providers. It measures usage, protects against runaway spend, and, only where you allow it, changes how requests are handled to reduce cost.</p>
<h2>Your consent controls changes</h2>
<p>Accounts start observe-only. WasteZero applies an optimisation only after you allow it in your settings or approve it in your dashboard. You can withdraw that at any time, and live changes stop at the next check.</p>
<h2>Fees</h2>
<p>The fee is ${pct}% of verified savings each month, unless your order form says otherwise. A saving is the cost at the model and price you requested minus the actual cost, for requests WasteZero changed. Losses net against gains, and the fee is never negative. If you use WasteZero's provider keys, that usage is billed at cost. Invoices are charged to your saved card.</p>
<h2>Your responsibilities</h2>
<p>You keep your provider accounts in good standing, follow your providers' usage policies, and don't use WasteZero to process data you're not allowed to process.</p>
<h2>Availability</h2>
<p>We aim for high availability but don't guarantee it. Use the fallback shown in the docs so your application reaches the provider directly if WasteZero is unreachable. WasteZero's budget caps and loop breaker can block requests when they trigger, as you configure.</p>
<h2>Liability</h2>
<p>To the extent the law allows, our total liability in any month is limited to the fees you paid us for that month.</p>
${contact(config) ? `<p>Questions: ${contact(config)}</p>` : ""}`);
}

export function handlePages(config, req, res, url) {
  const render = { "/pricing": pricing, "/docs": docs, "/privacy": privacy, "/terms": terms, "/teams": teams }[url.pathname];
  if (!render || req.method !== "GET") return null;
  res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=300" });
  res.end(render(config));
  return true;
}
