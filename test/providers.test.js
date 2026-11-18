import test from "node:test";
import assert from "node:assert/strict";
import { startApp, waitFor } from "./helpers.js";
import { loadProviders, resolveProvider } from "../src/providers.js";
import { addCacheBreakpoints, PrefixTracker, toOpenAIShape } from "../src/anthropic.js";
import { costForTokens, tokensFromUsage } from "../src/pricing.js";

const RATES = {
  "gpt-4o": { input: 2.5, output: 10 },
  "claude-sonnet-4-5": { input: 3, output: 15 },
  "claude-haiku-4-5": { input: 1, output: 5 },
  "kimi-k2": { input: 0.6, output: 2.5 },
  "gemini-2.5-flash": { input: 0.3, output: 2.5 }
};
const json = (d, status = 200, headers = {}) => new Response(JSON.stringify(d), { status, headers: { "content-type": "application/json", ...headers } });

/** One fake fetch that plays every provider, recording where each call went and with which key. */
function fakeProviders() {
  const calls = [];
  const fetch = async (url, init = {}) => {
    const u = new URL(url);
    const body = init.body ? JSON.parse(init.body) : {};
    calls.push({ host: u.host, path: u.pathname, headers: init.headers || {}, body });
    if (u.host === "api.anthropic.com" && u.pathname === "/v1/messages") {
      const cacheMarked = JSON.stringify(body).includes("cache_control");
      const usage = { input_tokens: cacheMarked ? 100 : 5100, cache_read_input_tokens: cacheMarked ? 5000 : 0, cache_creation_input_tokens: 0, output_tokens: 50 };
      if (body.stream) {
        const ev = (type, data) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
        const sse = ev("message_start", { message: { model: body.model + "-20250929", usage: { ...usage, output_tokens: 1 } } })
          + ev("content_block_delta", { index: 0, delta: { type: "text_delta", text: "hi" } })
          + ev("message_delta", { delta: { stop_reason: "max_tokens" }, usage: { output_tokens: 50 } })
          + ev("message_stop", {});
        return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream", "request-id": "req_ant_s" } });
      }
      const isJudgeless = body.messages?.at(-1)?.content === "same";
      return json({ id: "msg_1", type: "message", role: "assistant", model: body.model + "-20250929",
        content: [{ type: "text", text: isJudgeless ? "same answer" : `answer from ${body.model}` }], stop_reason: "end_turn", usage },
      200, { "request-id": "req_ant", "anthropic-ratelimit-requests-remaining": "49" });
    }
    if (u.pathname.endsWith("/chat/completions")) {
      return json({ id: "c", model: body.model, choices: [{ index: 0, message: { role: "assistant", content: `answer from ${body.model} via ${u.host}` }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1000, completion_tokens: 100, total_tokens: 1100 } });
    }
    if (u.pathname.endsWith("/models")) return json({ object: "list", data: [{ id: `model-of-${u.host}` }] });
    return json({ error: "unexpected " + url }, 404);
  };
  return { calls, fetch };
}

async function setup(env = {}, policy = {}) {
  const fake = fakeProviders();
  const s = await startApp({
    OPENAI_BASE_URL: "", MODEL_RATES_JSON: JSON.stringify(RATES), DOWNGRADE_MAP_JSON: JSON.stringify({ "claude-sonnet-4-5": "claude-haiku-4-5", "gpt-4o": "kimi-k2" }),
    ANTHROPIC_API_KEY: "sk-ant-wastezero", ...env
  }, { fetch: fake.fetch });
  const { json: t } = await s.admin("POST", "/admin/tenants", { name: "Multi", policy });
  return { ...s, ...fake, key: t.apiKey, tenantId: t.tenant.id };
}
const messages = (s, body, headers = {}) => s.call("POST", "/v1/messages", { body, headers: { "x-api-key": s.key, "anthropic-version": "2023-06-01", ...headers } });

test("providers are picked by model name, header, or slash; unknown provider header is refused", () => {
  const { providers, defaultProvider } = loadProviders({});
  const cfg = { providers, defaultProvider };
  const pick = (model, header) => resolveProvider(cfg, { model, header }).provider?.name;
  assert.equal(pick("gpt-4o"), "openai");
  assert.equal(pick("claude-sonnet-4-5"), "anthropic");
  assert.equal(pick("gemini-2.5-flash"), "gemini");
  assert.equal(pick("kimi-k2"), "moonshot");
  assert.equal(pick("deepseek-chat"), "deepseek");
  assert.equal(pick("meta-llama/llama-3.3-70b"), "openrouter");
  assert.equal(pick("something-unknown"), "openai");
  assert.equal(pick("gpt-4o", "gemini"), "gemini");
  assert.match(resolveProvider(cfg, { model: "x", header: "nope" }).error, /Unknown provider/);
  const custom = loadProviders({ PROVIDERS_JSON: JSON.stringify({ groq: { format: "openai", baseUrl: "https://api.groq.com/openai/v1", keyEnv: "GROQ_API_KEY", match: ["llama-"] } }), GROQ_API_KEY: "g" });
  assert.equal(resolveProvider(custom, { model: "llama-3.1-8b" }).provider.name, "groq");
  assert.throws(() => loadProviders({ DEFAULT_PROVIDER: "nope" }), /DEFAULT_PROVIDER/);
});

test("chat completions reach the right provider with the customer's own key", async () => {
  const s = await setup();
  const own = { "x-upstream-authorization": "Bearer sk-customer" };
  for (const [model, host] of [["gemini-2.5-flash", "generativelanguage.googleapis.com"], ["kimi-k2", "api.moonshot.ai"], ["deepseek-chat", "api.deepseek.com"],
    ["claude-sonnet-4-5", "api.anthropic.com"], ["meta-llama/llama-3.3-70b", "openrouter.ai"], ["gpt-4o", "api.openai.com"]]) {
    const r = await s.chat(s.key, { model, messages: [{ role: "user", content: "hi" }] }, own);
    assert.equal(r.status, 200, model);
    const call = s.calls.at(-1);
    assert.equal(call.host, host, model);
    assert.equal(call.headers.authorization, "Bearer sk-customer");
  }
  assert.equal(s.calls.find((c) => c.host === "api.anthropic.com").path, "/v1/chat/completions");   // Anthropic's OpenAI-compatible endpoint
  await waitFor(async () => (await s.ctx.events.all()).length === 6);
  const events = await s.ctx.events.all();
  assert.deepEqual(events.map((e) => e.provider), ["gemini", "moonshot", "deepseek", "anthropic", "openrouter", "openai"]);
  assert.equal(events.find((e) => e.provider === "moonshot").actualCostUsd, (1000 * 0.6 + 100 * 2.5) / 1e6);
  await s.close();
});

test("without a key for that provider, the customer gets a clear error", async () => {
  const s = await setup();
  const r = await s.chat(s.key, { model: "kimi-k2", messages: [{ role: "user", content: "hi" }] });
  assert.equal(r.status, 503);
  assert.match(r.json.error.message, /No moonshot key/);
  await s.close();
});

test("/v1/models goes to the provider named in the header", async () => {
  const s = await setup({ GEMINI_API_KEY: "gk" });
  const r = await s.call("GET", "/v1/models", { key: s.key, headers: { "x-wastezero-provider": "gemini" } });
  assert.equal(r.json.data[0].id, "model-of-generativelanguage.googleapis.com");
  await s.close();
});

test("native Anthropic Messages: Anthropic SDK auth, headers passed on, usage and cost recorded", async () => {
  const s = await setup();
  const r = await messages(s, { model: "claude-sonnet-4-5", max_tokens: 100, messages: [{ role: "user", content: "hello" }] }, { "anthropic-beta": "some-beta" });
  assert.equal(r.status, 200);
  assert.equal(r.json.content[0].text, "answer from claude-sonnet-4-5");
  assert.equal(r.headers.get("request-id"), "req_ant");
  assert.equal(r.headers.get("anthropic-ratelimit-requests-remaining"), "49");
  const call = s.calls.at(-1);
  assert.equal(call.headers["x-api-key"], "sk-ant-wastezero");
  assert.equal(call.headers["anthropic-beta"], "some-beta");
  await waitFor(async () => (await s.ctx.events.all()).length === 1);
  const [e] = await s.ctx.events.all();
  assert.equal(e.format, "anthropic");
  assert.equal(e.servedModel, "claude-sonnet-4-5-20250929");
  assert.equal(e.actualCostUsd, (5100 * 3 + 50 * 15) / 1e6);   // dated snapshot name still priced
  assert.equal(e.optimization, null);
  const bad = await s.call("POST", "/v1/messages", { body: { model: "claude-sonnet-4-5", messages: [] }, headers: { "x-api-key": "wrong" } });
  assert.equal(bad.status, 401);
  assert.equal(bad.json.type, "error");
  assert.equal(bad.json.error.type, "authentication_error");
  await s.close();
});

test("automatic prompt caching: marks a repeated long system prompt and books the saving; off without consent", async () => {
  const longSystem = "You are a support agent. ".repeat(300);
  const req = { model: "claude-sonnet-4-5", max_tokens: 100, system: longSystem, messages: [{ role: "user", content: "q" }] };

  const off = await setup();
  for (let i = 0; i < 2; i++) await messages(off, req);
  assert.ok(off.calls.every((c) => !JSON.stringify(c.body).includes("cache_control")));
  await off.close();

  const s = await setup({}, { allowedOptimizations: ["prompt_cache"] });
  const first = await messages(s, req);
  assert.equal(first.headers.get("x-wastezero-prompt-cache"), null);          // first sighting: no cache write paid for
  const second = await messages(s, req);
  assert.equal(second.headers.get("x-wastezero-prompt-cache"), "added");
  const sent = s.calls.at(-1).body;
  assert.equal(sent.system[0].cache_control.type, "ephemeral");
  assert.equal(sent.system[0].text, longSystem);                              // content unchanged
  await waitFor(async () => (await s.ctx.events.all()).length === 2);
  const e = (await s.ctx.events.all())[1];
  assert.equal(e.optimization, "prompt_cache");
  // baseline: 5,100 input at $3; actual: 100 at $3 + 5,000 cache reads at 0.1 × $3
  assert.equal(e.baselineCostUsd, (5100 * 3 + 50 * 15) / 1e6);
  assert.equal(e.actualCostUsd, (100 * 3 + 5000 * 0.3 + 50 * 15) / 1e6);
  assert.ok(e.savingsUsd > 0);
  await s.close();
});

test("prompt caching leaves customer-managed cache_control alone and claims nothing", async () => {
  const s = await setup({}, { allowedOptimizations: ["prompt_cache"] });
  const req = { model: "claude-sonnet-4-5", max_tokens: 10, system: [{ type: "text", text: "x".repeat(6000), cache_control: { type: "ephemeral" } }], messages: [{ role: "user", content: "q" }] };
  await messages(s, req); await messages(s, req);
  assert.deepEqual(s.calls.at(-1).body, req);
  await waitFor(async () => (await s.ctx.events.all()).length === 2);
  assert.ok((await s.ctx.events.all()).every((e) => e.optimization === null && e.savingsUsd === 0));
  await s.close();
});

test("multi-turn conversations get a breakpoint on the latest message; thinking blocks are never marked", () => {
  const tracker = new PrefixTracker();
  const long = "a".repeat(3000);
  const convo = { model: "claude-sonnet-4-5", messages: [{ role: "user", content: long }, { role: "assistant", content: long }, { role: "user", content: "next" }] };
  const r = addCacheBreakpoints(convo, { tenantId: "t", tracker });
  assert.equal(r.added, 1);
  assert.equal(r.body.messages[2].content[0].cache_control.type, "ephemeral");
  assert.equal(convo.messages[2].content, "next");                            // original untouched
  const thinking = { ...convo, messages: [...convo.messages.slice(0, 2), { role: "assistant", content: [{ type: "thinking", thinking: "..." }] }] };
  assert.equal(addCacheBreakpoints(thinking, { tenantId: "t", tracker }).added, 0);
  assert.equal(addCacheBreakpoints({ model: "m", messages: [{ role: "user", content: "short" }] }, { tenantId: "t", tracker }).added, 0);
});

test("Anthropic streaming passes events through untouched and records usage", async () => {
  const s = await setup();
  const r = await messages(s, { model: "claude-sonnet-4-5", max_tokens: 50, stream: true, messages: [{ role: "user", content: "hi" }] });
  assert.equal(r.status, 200);
  assert.match(r.text, /event: message_start/);
  assert.match(r.text, /event: message_stop/);
  await waitFor(async () => (await s.ctx.events.all()).length === 1);
  const [e] = await s.ctx.events.all();
  assert.equal(e.completionTokens, 50);
  assert.equal(e.promptTokens, 5100);
  assert.equal(e.finishReason, "length");                                     // max_tokens counts as a truncated answer
  await s.close();
});

test("budgets and the loop breaker protect Anthropic traffic too", async () => {
  const s = await setup({}, { loopBreaker: { maxRepeats: 2, windowSec: 60, action: "block" } });
  const req = { model: "claude-sonnet-4-5", max_tokens: 10, messages: [{ role: "user", content: "again" }] };
  const codes = [];
  for (let i = 0; i < 3; i++) codes.push((await messages(s, req)).status);
  assert.deepEqual(codes, [200, 200, 429]);
  const blocked = await messages(s, req);
  assert.equal(blocked.json.error.type, "rate_limit_error");
  await s.close();
});

test("routing stays within a provider: a cheaper model at another provider is never applied", async () => {
  const s = await setup({}, { allowedOptimizations: ["route"] });
  const r = (await s.admin("POST", "/admin/rules", { tenantId: s.tenantId, type: "route", match: { model: "gpt-4o" }, target: "kimi-k2" })).json.rule;
  await s.admin("POST", `/admin/rules/${r.id}/transition`, { to: "active", reason: "test" });
  const res = await s.chat(s.key, { model: "gpt-4o", messages: [{ role: "user", content: "hi" }] }, { "x-upstream-authorization": "Bearer sk-openai" });
  assert.equal(res.headers.get("x-wastezero-routed-from"), null);
  assert.equal(s.calls.at(-1).host, "api.openai.com");
  assert.equal(s.calls.at(-1).body.model, "gpt-4o");
  await s.close();
});

test("same-provider routing on Anthropic: claude-sonnet → claude-haiku, saving booked", async () => {
  const s = await setup({}, { allowedOptimizations: ["route"] });
  const r = (await s.admin("POST", "/admin/rules", { tenantId: s.tenantId, type: "route", match: { model: "claude-sonnet-4-5" }, target: "claude-haiku-4-5" })).json.rule;
  await s.admin("POST", `/admin/rules/${r.id}/transition`, { to: "active", reason: "test" });
  const res = await messages(s, { model: "claude-sonnet-4-5", max_tokens: 10, messages: [{ role: "user", content: "hi" }] });
  assert.equal(res.headers.get("x-wastezero-routed-from"), "claude-sonnet-4-5");
  assert.equal(s.calls.filter((c) => c.path === "/v1/messages")[0].body.model, "claude-haiku-4-5");
  await waitFor(async () => (await s.ctx.events.all()).length >= 1);
  const e = (await s.ctx.events.all())[0];
  assert.equal(e.optimization, "route");
  assert.ok(e.savingsUsd > 0);
  await s.close();
});

test("Anthropic usage and pricing: cache reads 0.1x, writes 1.25x unless the price list says otherwise", () => {
  const t = tokensFromUsage({ input_tokens: 100, cache_read_input_tokens: 1000, cache_creation_input_tokens: 400, output_tokens: 10 }, "anthropic");
  assert.deepEqual(t, { prompt: 1500, cached: 1000, cacheWrite: 400, completion: 10 });
  const defaults = { cacheRead: 0.1, cacheWrite: 1.25 };
  assert.equal(costForTokens("claude-sonnet-4-5", t, RATES, defaults), (100 * 3 + 1000 * 0.3 + 400 * 3.75 + 10 * 15) / 1e6);
  const explicit = { "claude-sonnet-4-5": { input: 3, output: 15, cachedInput: 0.5, cacheWriteInput: 4 } };
  assert.equal(costForTokens("claude-sonnet-4-5", t, explicit, defaults), (100 * 3 + 1000 * 0.5 + 400 * 4 + 10 * 15) / 1e6);
  const shaped = toOpenAIShape({ model: "m", content: [{ type: "text", text: "a" }, { type: "tool_use", name: "f", input: { x: 1 } }], stop_reason: "tool_use", usage: { input_tokens: 5, output_tokens: 2 } });
  assert.equal(shaped.choices[0].message.tool_calls[0].function.arguments, '{"x":1}');
});
