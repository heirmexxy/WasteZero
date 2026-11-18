import { sha256, stableStringify } from "./util.js";

/**
 * Automatic prompt caching for Anthropic.
 *
 * Anthropic only caches what a request marks with cache_control, and bills a cache write at more
 * than the normal input price. So a breakpoint is added only where a later read is likely:
 *   - the fixed prefix (tools + system prompt), once the same prefix has been seen recently
 *   - the conversation so far, in multi-turn conversations (the next turn re-sends it)
 * Requests that already use cache_control are left alone: the customer manages their own caching,
 * and WasteZero claims no saving for it.
 */
const CACHE_TTL_MS = 5 * 60 * 1000;
const EPHEMERAL = { type: "ephemeral" };
const NOT_CACHEABLE = new Set(["thinking", "redacted_thinking"]);

const textLength = (content) =>
  typeof content === "string" ? content.length
    : Array.isArray(content) ? content.reduce((n, b) => n + (typeof b?.text === "string" ? b.text.length : JSON.stringify(b ?? "").length), 0)
      : 0;

/** Remembers recent prompt prefixes, so a cache write is only paid for when a read is likely to follow. */
export class PrefixTracker {
  constructor(max = 20000) { this.seen = new Map(); this.max = max; }
  /** True if this prefix was seen within the cache lifetime. Records the sighting either way. */
  seenRecently(key, now = Date.now()) {
    const last = this.seen.get(key);
    this.seen.delete(key);
    this.seen.set(key, now);
    while (this.seen.size > this.max) this.seen.delete(this.seen.keys().next().value);
    return last != null && now - last < CACHE_TTL_MS;
  }
}

export function addCacheBreakpoints(body, { tenantId, tracker, minChars = 4096, now = Date.now() }) {
  if (JSON.stringify(body).includes('"cache_control"')) return { body, added: 0 };
  const out = structuredClone(body);
  let added = 0;

  // 1. Fixed prefix: tools, then system prompt.
  const prefixChars = textLength(out.system) + (out.tools ? JSON.stringify(out.tools).length : 0);
  if (prefixChars >= minChars) {
    const key = `${tenantId}:${out.model}:${sha256(stableStringify({ tools: out.tools ?? null, system: out.system ?? null }))}`;
    if (tracker.seenRecently(key, now)) {
      if (typeof out.system === "string" && out.system) {
        out.system = [{ type: "text", text: out.system, cache_control: EPHEMERAL }];
        added++;
      } else if (Array.isArray(out.system) && out.system.length) {
        out.system[out.system.length - 1] = { ...out.system[out.system.length - 1], cache_control: EPHEMERAL };
        added++;
      } else if (Array.isArray(out.tools) && out.tools.length) {
        out.tools[out.tools.length - 1] = { ...out.tools[out.tools.length - 1], cache_control: EPHEMERAL };
        added++;
      }
    }
  }

  // 2. Conversation so far: in a multi-turn exchange the next request re-sends all of it.
  const msgs = out.messages;
  if (Array.isArray(msgs) && msgs.length >= 3 && msgs.reduce((n, m) => n + textLength(m?.content), 0) >= minChars) {
    const last = msgs[msgs.length - 1];
    if (typeof last?.content === "string" && last.content) {
      msgs[msgs.length - 1] = { ...last, content: [{ type: "text", text: last.content, cache_control: EPHEMERAL }] };
      added++;
    } else if (Array.isArray(last?.content) && last.content.length) {
      const i = last.content.length - 1;
      if (!NOT_CACHEABLE.has(last.content[i]?.type)) {
        const content = [...last.content];
        content[i] = { ...content[i], cache_control: EPHEMERAL };
        msgs[msgs.length - 1] = { ...last, content };
        added++;
      }
    }
  }
  return { body: added ? out : body, added };
}

/** Anthropic's stop reasons, in the words the rest of WasteZero uses. */
export const finishReasonOf = (stop) => (stop === "max_tokens" ? "length" : stop === "end_turn" ? "stop" : stop ?? null);

/**
 * An Anthropic Messages response in OpenAI chat-completion shape, so the quality tests can compare
 * answers the same way for every provider. Used only for comparison; customers get the original.
 */
export function toOpenAIShape(msg) {
  const blocks = Array.isArray(msg?.content) ? msg.content : [];
  const text = blocks.filter((b) => b.type === "text").map((b) => b.text).join("");
  const tools = blocks.filter((b) => b.type === "tool_use").map((b) => ({ type: "function", function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) } }));
  const u = msg?.usage || {};
  const cached = Number(u.cache_read_input_tokens) || 0;
  return {
    model: msg?.model,
    choices: [{ index: 0, message: { role: "assistant", content: text, ...(tools.length ? { tool_calls: tools } : {}) }, finish_reason: finishReasonOf(msg?.stop_reason) }],
    usage: {
      prompt_tokens: (Number(u.input_tokens) || 0) + cached + (Number(u.cache_creation_input_tokens) || 0),
      completion_tokens: Number(u.output_tokens) || 0,
      prompt_tokens_details: { cached_tokens: cached }
    }
  };
}

/** Anthropic-style error body, so the Anthropic SDK shows the message. */
export function anthropicErrorBody(status, message) {
  const type = status === 401 ? "authentication_error" : status === 403 ? "permission_error" : status === 404 ? "not_found_error"
    : status === 413 ? "request_too_large" : status === 429 ? "rate_limit_error" : status >= 500 ? "api_error" : "invalid_request_error";
  return { type: "error", error: { type, message } };
}
