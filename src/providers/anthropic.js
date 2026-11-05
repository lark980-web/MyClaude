/**
 * Anthropic Messages API provider.
 *
 * 为什么单独一个类：Anthropic 的 /v1/messages 与 OpenAI 的 /chat/completions
 * 是两套线协议 —— 认证头不同（x-api-key + anthropic-version vs Bearer）、
 * system 是顶层字段而不是消息、工具 schema 叫 input_schema、tool 结果要放进
 * user 消息的 tool_result 块、SSE 是 event 化的块流而不是 choices[].delta。
 *
 * 但**传输层继承自 OpenAIProvider**：独占连接、TTFB 超时、abort 后销毁 socket
 * 这些是修「断连后下一回合挂死 90s」换来的，重写一份等于把这个坑再埋一次。
 */

import { OpenAIProvider, ProviderError, repairToolJson } from "./openai.js";

const ANTHROPIC_VERSION = "2023-06-01";

/** OpenAI stop_reason -> 内部 finishReason（GUI 靠 length 弹「继续生成」）。 */
function finishReasonOf(stop) {
  if (stop === "tool_use") return "tool_calls";
  if (stop === "max_tokens") return "length";
  return "stop";
}

/** 内部 OpenAI 风格工具 schema -> Anthropic {name, description, input_schema}。 */
export function toAnthropicTools(tools) {
  return (tools || []).map((t) => (
    t && t.function
      ? { name: t.function.name, description: t.function.description || "", input_schema: t.function.parameters || { type: "object", properties: {} } }
      : { name: t.name, description: t.description || "", input_schema: t.input_schema || t.parameters || { type: "object", properties: {} } }
  ));
}

/** 多模态 parts：data: URL 转成 Anthropic 的 base64 image source。 */
function userBlocks(content) {
  if (typeof content === "string") return content ? [{ type: "text", text: content }] : [];
  const blocks = [];
  for (const part of (Array.isArray(content) ? content : [])) {
    if (!part) continue;
    if (part.type === "text") { if (part.text) blocks.push({ type: "text", text: part.text }); continue; }
    const url = part.image_url && part.image_url.url;
    if (!url) continue;
    const m = /^data:([^;,]+);base64,([\s\S]+)$/i.exec(String(url));
    if (m) { blocks.push({ type: "image", source: { type: "base64", media_type: m[1], data: m[2] } }); continue; }
    if (/^https?:\/\//i.test(String(url))) { blocks.push({ type: "image", source: { type: "url", url: String(url) } }); }
  }
  return blocks;
}

/**
 * 内部消息历史 -> Anthropic {system, messages}。
 * Anthropic 要求 user/assistant 交替，且 tool_result 必须挂在 user 消息上，
 * 所以同角色的连续消息在这里合并成一条（agent 的空正文催写会连着推 user）。
 */
export function toAnthropicMessages(messages) {
  const systemParts = [];
  const out = [];
  const push = (msg) => {
    if (!msg.content || !msg.content.length) return;
    const last = out[out.length - 1];
    if (last && last.role === msg.role) { last.content = last.content.concat(msg.content); return; }
    out.push({ role: msg.role, content: msg.content.slice() });
  };
  for (const m of (messages || [])) {
    if (!m) continue;
    if (m.role === "system") {
      const s = typeof m.content === "string" ? m.content : "";
      if (s.trim()) systemParts.push(s);
      continue;
    }
    if (m.role === "assistant") {
      const blocks = [];
      const txt = typeof m.content === "string" ? m.content : "";
      if (txt.trim()) blocks.push({ type: "text", text: txt });
      for (const tc of (m.tool_calls || [])) {
        let input = {};
        const raw = tc.function && tc.function.arguments;
        try { input = raw ? JSON.parse(raw) : {}; }
        catch { input = repairToolJson(raw) || {}; }
        blocks.push({ type: "tool_use", id: tc.id, name: (tc.function && tc.function.name) || "", input: input });
      }
      push({ role: "assistant", content: blocks });
      continue;
    }
    if (m.role === "tool") {
      const body = typeof m.content === "string" ? m.content : JSON.stringify(m.content == null ? "" : m.content);
      push({ role: "user", content: [{ type: "tool_result", tool_use_id: m.tool_call_id, content: body }] });
      continue;
    }
    push({ role: "user", content: userBlocks(m.content) });
  }
  return { system: systemParts.join("\n\n"), messages: out };
}

/**
 * 打 prompt caching 断点（依据 Claude Code 2.1.302 的 prompt-caching 文档：
 * 07-assets/docs/prompt-caching-485cdf9d.md）。
 *
 * 唯一不变量：**缓存是前缀匹配** —— 前缀里任何一个字节变化，它之后的所有断点全部失效。
 * 渲染顺序固定为 tools -> system -> messages，因此：
 *   1. 最后一个 system 块打点，同时缓存 tools + system（不必单独给 tools 打点）；
 *   2. 最后一条消息的最后一个内容块打点，后续请求复用整段前缀，命中率随对话增长累积。
 * 上限 4 个断点，这里只用 2 个。最小可缓存前缀因模型而异（512~4096 tokens），
 * 不足时服务端静默不缓存，不报错。
 *
 * toAnthropicMessages 每次请求都新建块对象，因此就地打点不会污染 agent 的历史。
 */
function withCacheBreakpoints(body, enabled) {
  if (!enabled) return body;
  if (typeof body.system === "string" && body.system) {
    body.system = [{ type: "text", text: body.system, cache_control: { type: "ephemeral" } }];
  }
  const msgs = body.messages;
  if (Array.isArray(msgs) && msgs.length) {
    const last = msgs[msgs.length - 1];
    const blocks = last && Array.isArray(last.content) ? last.content : null;
    const tail = blocks && blocks.length ? blocks[blocks.length - 1] : null;
    if (tail && typeof tail === "object" && !Array.isArray(tail) && !tail.cache_control) {
      tail.cache_control = { type: "ephemeral" };
    }
  }
  return body;
}

export class AnthropicProvider extends OpenAIProvider {
  headers() {
    const h = { "Content-Type": "application/json", "anthropic-version": ANTHROPIC_VERSION };
    if (this.apiKey) h["x-api-key"] = this.apiKey;
    return h;
  }

  buildBody({ messages, tools, maxTokens, stream }) {
    const { system, messages: converted } = toAnthropicMessages(messages);
    const body = {
      model: this.model,
      messages: converted,
      max_tokens: Number(maxTokens || this.config.maxTokens) || 4096,
    };
    if (system) body.system = system;
    const effort = ["high", "medium", "low"].includes(this.config.effort) ? this.config.effort : null;
    if (effort) {
      // Anthropic 要求开 thinking 时 temperature 必须为 1。
      const budget = effort === "high" ? 8000 : effort === "medium" ? 4000 : 2000;
      const ceiling = Number(body.max_tokens) || 4096;
      body.thinking = { type: "enabled", budget_tokens: Math.max(1024, Math.min(budget, ceiling - 1024)) };
      body.temperature = 1;
    } else if (this.config.temperature != null) {
      body.temperature = Number(this.config.temperature);
    }
    if (tools && tools.length) body.tools = toAnthropicTools(tools);
    if (stream) body.stream = true;
    return withCacheBreakpoints(body, this.config.promptCaching !== false);
  }

  async streamChat({ messages, tools, signal, onDelta, onToolCall, onReasoning, maxTokens }) {
    const res = await this.request(`${this.baseUrl}/messages`, {
      method: "POST", headers: this.headers(), body: JSON.stringify(this.buildBody({ messages, tools, maxTokens, stream: true })), signal,
    }, { stream: true });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new ProviderError(`chat failed: ${res.status} ${text.slice(0, 500)}`, { status: res.status, body: text });
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let text = "";
    let reasoning = "";
    const blocks = new Map();
    const toolAccum = new Map();
    let finishReason = null;
    let usage = null;

    const idleMs = this.streamIdleMs > 0 ? Math.max(this.streamIdleMs, 250) : 0;
    let idle = null; let stalled = false;
    const armIdle = () => {
      if (!idleMs) return;
      if (idle) clearTimeout(idle);
      idle = setTimeout(() => { stalled = true; reader.cancel().catch(() => {}); }, idleMs);
      idle.unref?.();
    };
    armIdle();

    const handle = (payload) => {
      let json;
      try { json = JSON.parse(payload); } catch { return; }
      if (!json || !json.type) return;
      switch (json.type) {
        case "message_start": {
          const u = json.message && json.message.usage;
          if (u) usage = {
            promptTokens: u.input_tokens ?? null,
            completionTokens: u.output_tokens ?? null,
            cachedTokens: u.cache_read_input_tokens ?? null,
            totalTokens: (u.input_tokens || 0) + (u.output_tokens || 0),
          };
          return;
        }
        case "content_block_start": {
          const b = json.content_block || {};
          blocks.set(json.index, { type: b.type || "text", json: "" });
          if (b.type === "tool_use") toolAccum.set(json.index, { id: b.id, name: b.name, arguments: "" });
          return;
        }
        case "content_block_delta": {
          const d = json.delta || {};
          if (d.type === "text_delta" && d.text) { text += d.text; onDelta?.(d.text); return; }
          if (d.type === "thinking_delta" && d.thinking) { reasoning += d.thinking; onReasoning?.(d.thinking); return; }
          if (d.type === "input_json_delta" && d.partial_json) {
            const acc = toolAccum.get(json.index);
            const slot = blocks.get(json.index);
            if (acc) acc.arguments += d.partial_json;
            if (slot) slot.json += d.partial_json;
          }
          return;
        }
        case "message_delta": {
          if (json.delta && json.delta.stop_reason) finishReason = finishReasonOf(json.delta.stop_reason);
          const u = json.usage;
          if (u && usage) { usage.completionTokens = u.output_tokens ?? usage.completionTokens; usage.totalTokens = (usage.promptTokens || 0) + (usage.completionTokens || 0); }
          else if (u) usage = { promptTokens: u.input_tokens ?? null, completionTokens: u.output_tokens ?? null, totalTokens: null };
          return;
        }
        case "error":
          throw new ProviderError(`anthropic stream error: ${json.error && json.error.message ? json.error.message : "unknown"}`, { status: 502 });
        default:
          return;
      }
    };

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (idle) { clearTimeout(idle); idle = null; }
        if (done) break;
        armIdle();
        buffer += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, idx).trim();
          buffer = buffer.slice(idx + 1);
          // Anthropic 用 `event:` + `data:` 双行；type 已在 data 的 JSON 里，
          // 所以只取 data 行即可，event 行忽略。
          if (!line.startsWith("data:")) continue;
          const payload = line.slice(5).trim();
          if (!payload || payload === "[DONE]") continue;
          handle(payload);
        }
      }
    } catch (e) {
      if (idle) { clearTimeout(idle); idle = null; }
      if (e && e.name === "AbortError") { try { await reader.cancel(); } catch {} throw e; }
      const emitted = text.length > 0 || reasoning.length > 0 || toolAccum.size > 0;
      const err = e instanceof ProviderError ? e
        : new ProviderError(`stream interrupted: ${e && e.message ? e.message : e}`, { status: 502 });
      if (emitted) err.noRetry = true;
      throw err;
    }
    if (idle) { clearTimeout(idle); idle = null; }
    if (stalled) throw new ProviderError(`stream idle: no data for ${Math.round(idleMs / 1000)}s (timed out)`, { status: 408 });

    const toolCalls = [...toolAccum.values()].filter((t) => t.name).map((t) => {
      let args = {};
      try { args = t.arguments ? JSON.parse(t.arguments) : {}; }
      catch { args = repairToolJson(t.arguments) || { __raw: t.arguments, __parseError: true }; }
      return { id: t.id, name: t.name, arguments: args, raw: t.arguments };
    });
    for (const call of toolCalls) onToolCall?.(call);
    return { text, reasoning, toolCalls, finishReason, usage };
  }

  async complete({ messages, tools, signal, maxTokens }) {
    const res = await this.request(`${this.baseUrl}/messages`, {
      method: "POST", headers: this.headers(), body: JSON.stringify(this.buildBody({ messages, tools, maxTokens, stream: false })), signal,
    });
    if (!res.ok) {
      const t = await res.text().catch(() => "");
      throw new ProviderError(`chat failed: ${res.status} ${t.slice(0, 500)}`, { status: res.status });
    }
    const json = await res.json();
    let text = "";
    const toolCalls = [];
    for (const b of (json.content || [])) {
      if (b.type === "text") text += b.text || "";
      else if (b.type === "tool_use") toolCalls.push({ id: b.id, name: b.name, arguments: b.input || {}, raw: JSON.stringify(b.input || {}) });
    }
    const u = json.usage || null;
    return {
      text,
      toolCalls,
      finishReason: finishReasonOf(json.stop_reason),
      usage: u ? { promptTokens: u.input_tokens ?? null, completionTokens: u.output_tokens ?? null, totalTokens: (u.input_tokens || 0) + (u.output_tokens || 0) } : null,
    };
  }
}