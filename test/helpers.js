import http from "node:http";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadConfig } from "../src/config.js";
import { createApp } from "../src/app.js";

export const ADMIN = "admin-key-for-tests-0123456789";
export const RATES = {
  "gpt-4o": { input: 2.5, cachedInput: 1.25, output: 10 },
  "gpt-4o-mini": { input: 0.15, cachedInput: 0.075, output: 0.6 }
};

/** Fake OpenAI. Answers name the model; the grader verdict is switchable. */
export async function startMockProvider() {
  const state = { calls: [], judgeAcceptable: true, failNext: 0 };
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      if (req.url.endsWith("/models")) { res.writeHead(200, { "content-type": "application/json", "x-request-id": "req_models" }); return res.end(JSON.stringify({ object: "list", data: [{ id: "gpt-4o", object: "model" }] })); }
      const body = JSON.parse(raw);
      state.calls.push({ body, auth: req.headers.authorization });
      if (state.failNext > 0) { state.failNext--; res.writeHead(500, { "content-type": "application/json" }); return res.end('{"error":{"message":"boom"}}'); }
      const isJudge = body.messages?.[0]?.content?.includes?.("quality reviewer");
      const content = isJudge ? JSON.stringify({ acceptable: state.judgeAcceptable, score: state.judgeAcceptable ? 9 : 3 })
        : `answer from ${body.model} to ${body.messages.at(-1).content}`;
      const usage = { prompt_tokens: 1000, completion_tokens: 200, total_tokens: 1200, prompt_tokens_details: { cached_tokens: 0 } };
      const model = `${body.model}-2024-07-18`;
      if (body.stream) {
        res.writeHead(200, { "content-type": "text/event-stream", "x-request-id": "req_stream" });
        res.write(`data: ${JSON.stringify({ model, choices: [{ index: 0, delta: { content } }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
        if (body.stream_options?.include_usage) res.write(`data: ${JSON.stringify({ model, choices: [], usage })}\n\n`);
        res.end("data: [DONE]\n\n");
        return;
      }
      res.writeHead(200, { "content-type": "application/json", "x-request-id": "req_123", "x-ratelimit-remaining-requests": "99", "x-internal": "hidden" });
      res.end(JSON.stringify({ id: "c1", model, choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }], usage }));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { state, server, url: `http://127.0.0.1:${server.address().port}/v1`, close: () => new Promise((r) => { server.closeAllConnections(); server.close(r); }) };
}

export async function startApp(env = {}, opts = {}) {
  const dataDir = env.DATA_DIR || await mkdtemp(path.join(tmpdir(), "wz-"));
  const config = loadConfig({
    WASTEZERO_ADMIN_KEY: ADMIN, OPENAI_API_KEY: "sk-wastezero", DATA_DIR: dataDir,
    MODEL_RATES_JSON: JSON.stringify(RATES), DOWNGRADE_MAP_JSON: JSON.stringify({ "gpt-4o": "gpt-4o-mini" }),
    ...env
  });
  const app = await createApp(config, { random: () => 0, logger: { error() {}, warn() {}, log() {} }, ...opts });
  await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const call = async (method, p, { key, body, headers = {}, raw } = {}) => {
    const res = await fetch(base + p, {
      method, headers: { ...(key ? { authorization: `Bearer ${key}` } : {}), "content-type": "application/json", ...headers },
      body: raw ?? (body === undefined ? undefined : JSON.stringify(body))
    });
    const text = await res.text();
    let json = null; try { json = JSON.parse(text); } catch {}
    return { status: res.status, headers: res.headers, json, text };
  };
  const admin = (method, p, body) => call(method, p, { key: ADMIN, body });
  const chat = (key, body, headers) => call("POST", "/v1/chat/completions", { key, body, headers });
  return { app, ctx: app.ctx, base, call, admin, chat, dataDir, close: () => new Promise((r) => { app.server.closeAllConnections?.(); app.server.close(r); }) };
}

export async function waitFor(check, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await check()) return true; await new Promise((r) => setTimeout(r, 20)); }
  throw new Error("timed out waiting");
}

export const ask = (text, extra = {}) => ({ model: "gpt-4o", temperature: 0, messages: [{ role: "user", content: text }], ...extra });
