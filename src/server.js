import http from "node:http";
import { config } from "./config.js";
import { isAuthorized } from "./auth.js";
import { estimateCost, aggregateEvents } from "./costs.js";
import { EventStore } from "./store.js";
import { recommendations } from "./policy.js";

const store = new EventStore(config.dataDir);

function send(res, status, body) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}
function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    let size = 0, chunks = [];
    req.on("data", chunk => {
      size += chunk.length;
      if (size > maxBytes) { reject(Object.assign(new Error("Request body too large"), { status: 413 })); req.destroy(); }
      else chunks.push(chunk);
    });
    req.on("end", () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
      catch { reject(Object.assign(new Error("Body must be valid JSON"), { status: 400 })); }
    });
    req.on("error", reject);
  });
}
function authorized(req, res) {
  if (!isAuthorized(req, config.apiKey)) { send(res, 401, { error: "Unauthorized" }); return false; }
  return true;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  if (req.method === "GET" && url.pathname === "/health") return send(res, 200, { ok: true, service: "wastezero" });
  if (!authorized(req, res)) return;

  if (req.method === "GET" && url.pathname === "/admin/summary") {
    const events = await store.list(100000);
    return send(res, 200, { ...aggregateEvents(events), recommendations: recommendations(events) });
  }
  if (req.method === "GET" && url.pathname === "/admin/events") {
    const limit = Math.min(500, Math.max(1, Number(url.searchParams.get("limit") || 50)));
    return send(res, 200, { events: await store.list(limit) });
  }
  if (req.method !== "POST" || url.pathname !== "/v1/chat/completions") {
    return send(res, 404, { error: "Not found" });
  }
  if (!config.upstreamKey) return send(res, 503, { error: "OPENAI_API_KEY is not configured" });

  let body;
  try { body = await readBody(req, config.maxBodyBytes); }
  catch (error) { if (!res.headersSent && !res.destroyed) send(res, error.status || 400, { error: error.message }); return; }
  if (!body || typeof body !== "object" || Array.isArray(body) || typeof body.model !== "string" || !Array.isArray(body.messages)) {
    return send(res, 400, { error: "Expected a chat-completions JSON body with model and messages" });
  }
  if (body.stream === true) return send(res, 400, { error: "Streaming is not supported in this MVP" });

  const started = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
  let upstream;
  try {
    upstream = await fetch(`${config.upstreamBaseUrl}/chat/completions`, {
      method: "POST",
      headers: { "authorization": `Bearer ${config.upstreamKey}`, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    const raw = await upstream.text();
    let data;
    try { data = JSON.parse(raw); } catch { data = { error: { message: "Provider returned a non-JSON response" } }; }
    const usage = data.usage || {};
    const event = {
      timestamp: new Date().toISOString(),
      model: data.model || body.model,
      promptTokens: Number(usage.prompt_tokens || 0),
      completionTokens: Number(usage.completion_tokens || 0),
      totalTokens: Number(usage.total_tokens || 0),
      estimatedCostUsd: estimateCost(data.model || body.model, usage, config.modelRates),
      status: upstream.status,
      latencyMs: Date.now() - started
    };
    await store.add(event);
    return send(res, upstream.status, data);
  } catch (error) {
    const event = { timestamp: new Date().toISOString(), model: body.model, promptTokens: 0, completionTokens: 0, totalTokens: 0, estimatedCostUsd: null, status: 502, latencyMs: Date.now() - started };
    await store.add(event).catch(() => {});
    return send(res, error.name === "AbortError" ? 504 : 502, { error: error.name === "AbortError" ? "Upstream request timed out" : "Upstream request failed" });
  } finally { clearTimeout(timeout); }
});

if (config.apiKey && config.upstreamKey) {
  server.listen(config.port, "127.0.0.1", () => console.log(`WasteZero listening on http://127.0.0.1:${config.port}`));
} else {
  console.error("Set WASTEZERO_API_KEY and OPENAI_API_KEY before starting WasteZero.");
  process.exitCode = 1;
}
