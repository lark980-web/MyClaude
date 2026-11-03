export class ProviderError extends Error {
  constructor(message, { status, body } = {}) {
    super(message);
    this.name = "ProviderError";
    this.status = status;
    this.body = body;
  }
}

function normalizeBase(baseUrl) {
  return baseUrl.replace(/\/+$/, "");
}

import http from "node:http";
import https from "node:https";

export class OpenAIProvider {
  constructor(config) {
    this.config = config;
    this.baseUrl = normalizeBase(config.baseUrl);
    this.apiKey = config.apiKey;
    this.model = config.model;
    // Abort a request that never answers, so a hung endpoint can fail over
    // instead of blocking the conversation forever. 0 disables the timer.
    this.timeoutMs = Number(config.requestTimeoutMs ?? 90_000);
    // Silence AFTER the first byte is a different failure from never answering:
    // the gateway took the request and its upstream died. Watched per read in
    // streamChat(); 0 disables the watchdog.
    this.streamIdleMs = Number(config.streamIdleTimeoutMs ?? 120_000);
    // 上一次 caller abort 的时间戳：abort 后短窗内的请求用短超时，
    // 防止复用 half-open 死连接时挂满整个超时（见 request() 注释）。
    this.lastAbortAt = 0;
  }

  /**
   * Request with a time-to-first-byte timeout, over node:http.
   *
   * The timer covers the wait for the response headers only: after that the
   * request is handed back as a stream, and a long generation must not be cut
   * off just for being long. Silence DURING the stream is watched separately
   * in streamChat().
   *
   * 为什么不用 fetch：undici 的全局连接池在「headers 已到、body 未读完就
   * abort」时会留下 half-open 连接（对端已关、client 未察觉），下一个请求
   * 复用它就是 90s 无响应——停止/断连后的下一回合曾稳定复现。这里
   * agent:false 每请求独占连接、用完即关，socket 生命周期完全可见，
   * 整类死连接问题不复存在；每次请求多一次 TCP 握手，对 agent 的请求
   * 频率（每回合个位数）完全无感。
   */
  async request(url, init, { stream = false } = {}) {
    const caller = init.signal;
    const u = new URL(url);
    const mod = u.protocol === "https:" ? https : http;
    // abort 后短窗内用短超时（保守：刚 abort 完的首字节通常不该久等）
    const recentAbort = this.lastAbortAt && (Date.now() - this.lastAbortAt < 10_000);
    const timeoutMs = this.timeoutMs > 0
      ? (recentAbort ? Math.min(this.timeoutMs, 3_000) : this.timeoutMs)
      : 0;

    return new Promise((resolve, reject) => {
      let settled = false;
      let timer = null;
      const clearTimer = () => { if (timer) { clearTimeout(timer); timer = null; } };
      const settle = (ok, value) => {
        if (settled) { return; }
        settled = true;
        clearTimer();
        if (ok) { resolve(value); } else { reject(value); }
      };

      const req = mod.request(u, {
        method: init.method || "GET",
        headers: init.headers || {},
        agent: false, // 永不池化——见方法注释
      }, (res) => {
        // 响应头到达：TTFB 计时到此为止，长生成不受影响
        clearTimer();
        const status = res.statusCode || 0;

        if (stream && status >= 200 && status < 300) {
          const rs = new ReadableStream({
            start(controller) {
              res.on("data", (c) => {
                try { controller.enqueue(new Uint8Array(c)); } catch {}
              });
              res.on("end", () => { try { controller.close(); } catch {} });
              res.on("error", (e) => { try { controller.error(e); } catch {} });
            },
            cancel() {
              try { res.destroy(); } catch {}
            },
          });
          settle(true, {
            ok: true,
            status,
            headers: res.headers,
            text: async () => "",
            json: async () => ({}),
            body: rs,
          });
          return;
        }

        // 错误响应或非流式：整包缓冲（错误体很小；JSON 响应本来就要整包）
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("error", (e) => settle(false, e));
        res.on("end", () => {
          const buf = Buffer.concat(chunks).toString("utf8");
          settle(true, {
            ok: status >= 200 && status < 300,
            status,
            headers: res.headers,
            text: () => Promise.resolve(buf),
            json: () => Promise.resolve(JSON.parse(buf || "null")),
            body: null,
          });
        });
      });

      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          const err = new ProviderError(`request timed out after ${Math.round(timeoutMs / 1000)}s`, { status: 408 });
          req.destroy(err);
        }, timeoutMs);
        // unref：请求在途时也不该拖住进程退出
        if (typeof timer.unref === "function") timer.unref();
      }

      const onCallerAbort = () => {
        // 记录 caller 主动 abort：下一个请求进入死连接怀疑窗口（短超时）
        this.lastAbortAt = Date.now();
        const err = new Error("aborted");
        err.name = "AbortError";
        req.destroy(err);
      };
      if (caller) {
        if (caller.aborted) { onCallerAbort(); }
        else caller.addEventListener("abort", onCallerAbort, { once: true });
      }

      req.on("error", (e) => {
        if (e && e.name === "AbortError") {
          if (caller && caller.aborted) { settle(false, e); return; }
          settle(false, new ProviderError(`request timed out after ${Math.round((timeoutMs || 0) / 1000)}s`, { status: 408 }));
          return;
        }
        settle(false, e);
      });

      if (init.body != null) { req.end(init.body); } else { req.end(); }
    });
    // caller-abort 监听不清理：方法返回后 body 还在流，abort 必须继续转发；
    // 监听器 {once:true} 挂在单回合的 caller signal 上，无泄漏。
  }

  headers() {
    const h = { "Content-Type": "application/json" };
    if (this.apiKey) h.Authorization = `Bearer ${this.apiKey}`;
    return h;
  }

  async listModels() {
    const res = await this.request(`${this.baseUrl}/models`, { headers: this.headers() });
    if (!res.ok) throw new ProviderError(`list models failed: ${res.status}`, { status: res.status });
    const json = await res.json();
    return (json.data || []).map((m) => m.id);
  }

  async streamChat({ messages, tools, signal, onDelta, onToolCall, onReasoning, maxTokens }) {
    const body = {
      model: this.model,
      messages,
      stream: true,
      max_tokens: maxTokens || this.config.maxTokens,
      temperature: this.config.temperature,
      // /effort wiring: high|medium|low forward as the standard reasoning_effort
      // field. off and unset send nothing, so gateways that do not know the
      // field keep seeing exactly the old request. Failover inherits it:
      // candidates spread over {...config, ...cfg} keep the setting.
      ...(["high", "medium", "low"].includes(this.config.effort)
        ? { reasoning_effort: this.config.effort }
        : {}),
      // Ask for a final usage chunk; endpoints that ignore it simply never
      // send one, and usage stays null instead of lying.
      stream_options: { include_usage: true },
    };
    if (tools && tools.length) {
      body.tools = tools;
      body.tool_choice = "auto";
    }

    const res = await this.request(
      `${this.baseUrl}/chat/completions`,
      { method: "POST", headers: this.headers(), body: JSON.stringify(body), signal },
      { stream: true }
    );

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new ProviderError(`chat failed: ${res.status} ${text.slice(0, 500)}`, {
        status: res.status,
        body: text
      });
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let text = "";
    let reasoning = "";
    let usage = null;
    const toolAccum = new Map();
    let finishReason = null;

    // Inactivity watchdog: a gateway that stops sending without closing the
    // connection must not stall the conversation forever. Long generations are
    // safe here - every delivered chunk resets the timer, so only true silence
    // trips it. On trip the pending read is cancelled and a retryable 408 is
    // raised, which sends the router to the next candidate.
    const idleMs = this.streamIdleMs > 0 ? Math.max(this.streamIdleMs, 250) : 0;
    let idle = null;
    let stalled = false;
    const armIdle = () => {
      if (!idleMs) return;
      if (idle) clearTimeout(idle);
      idle = setTimeout(() => { stalled = true; reader.cancel().catch(() => {}); }, idleMs);
      idle.unref?.();
    };
    armIdle();

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
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;

        let chunk;
        try {
          chunk = JSON.parse(payload);
        } catch {
          continue;
        }

        // The usage chunk carries no choices, so it must be read first.
        if (chunk.usage) {
          usage = {
            promptTokens: chunk.usage.prompt_tokens ?? null,
            completionTokens: chunk.usage.completion_tokens ?? null,
            totalTokens: chunk.usage.total_tokens ?? null,
          };
        }

        const choice = chunk.choices?.[0];
        if (!choice) continue;
        if (choice.finish_reason) finishReason = choice.finish_reason;

        const delta = choice.delta || {};

        // Reasoning models stream their thinking through a separate field. It
        // must not be concatenated into `text`: that is the answer, and mixing
        // them is what made reasoning leak into the transcript as body text.
        const thought = delta.reasoning_content ?? delta.reasoning;
        if (typeof thought === "string" && thought) {
          reasoning += thought;
          onReasoning?.(thought);
        }
        if (delta.content) {
          text += delta.content;
          onDelta?.(delta.content);
        }

        if (Array.isArray(delta.tool_calls)) {
          for (const tc of delta.tool_calls) {
            const key = tc.index ?? 0;
            if (!toolAccum.has(key)) {
              toolAccum.set(key, { id: tc.id || `call_${key}`, name: "", arguments: "" });
            }
            const entry = toolAccum.get(key);
            if (tc.id) entry.id = tc.id;
            if (tc.function?.name) entry.name += tc.function.name;
            if (tc.function?.arguments) entry.arguments += tc.function.arguments;
          }
        }
      }
    }
    } catch (e) {
      if (idle) { clearTimeout(idle); idle = null; }
      if (e && e.name === "AbortError") {
        // 主动取消 body：只 reject read 不销毁底层 socket 时，连接会带着
        // 半开状态回到 keep-alive 池，下一回合复用它就撞上 90s 无响应
        // （disconnect-abort 的第二个回合曾这样挂满超时）。cancel 触发
        // 连接销毁，下一个请求拿到的必然是新鲜连接。
        try { await reader.cancel(); } catch {}
        throw e;
      }
      // 流被掐断（网关/上游 socket 死亡）。分两种：
      //  - 还没吐过任何内容：重试是安全的，标 502 交给 router 换候选；
      //  - 已经向调用方输出过：重试会重复输出，标 noRetry 把决定权交回用户。
      const emitted = text.length > 0 || reasoning.length > 0 || toolAccum.size > 0;
      const err = e instanceof ProviderError ? e
        : new ProviderError(`stream interrupted: ${e && e.message ? e.message : e}`, { status: 502 });
      if (emitted) err.noRetry = true;
      throw err;
    }

    if (idle) { clearTimeout(idle); idle = null; }
    if (stalled) {
      throw new ProviderError(`stream idle: no data for ${Math.round(idleMs / 1000)}s (timed out)`, { status: 408 });
    }

    const toolCalls = [...toolAccum.values()]
      .filter((t) => t.name)
      .map((t) => {
        let args = {};
        try {
          args = t.arguments ? JSON.parse(t.arguments) : {};
        } catch {
          const repaired = repairToolJson(t.arguments);
          args = repaired || { __raw: t.arguments, __parseError: true };
        }
        return { id: t.id, name: t.name, arguments: args, raw: t.arguments };
      });

    for (const call of toolCalls) onToolCall?.(call);

    return { text, reasoning, toolCalls, finishReason, usage };
  }

  async complete({ messages, tools, signal, maxTokens }) {
    const body = {
      model: this.model,
      messages,
      max_tokens: maxTokens || this.config.maxTokens,
      temperature: this.config.temperature,
    };
    if (tools && tools.length) {
      body.tools = tools;
      body.tool_choice = "auto";
    }
    const res = await this.request(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(body),
      signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new ProviderError(`chat failed: ${res.status} ${text.slice(0, 500)}`, { status: res.status });
    }
    const json = await res.json();
    const msg = json.choices?.[0]?.message || {};
    const toolCalls = (msg.tool_calls || []).map((t) => {
      let args = {};
      try {
        args = t.function.arguments ? JSON.parse(t.function.arguments) : {};
      } catch {
        args = {};
      }
      return { id: t.id, name: t.function.name, arguments: args, raw: t.function.arguments };
    });
    return {
      text: msg.content || "",
      toolCalls,
      finishReason: json.choices?.[0]?.finish_reason,
      usage: json.usage ? {
        promptTokens: json.usage.prompt_tokens ?? null,
        completionTokens: json.usage.completion_tokens ?? null,
        totalTokens: json.usage.total_tokens ?? null,
      } : null,
    };
  }
}


/**
 * Repair a tool-call argument string that a model emitted as "almost JSON".
 *
 * Some providers (observed with spark-x2.6) stream real newlines/tabs INSIDE
 * string values instead of the \n escape, which makes JSON.parse throw and
 * the tool then runs with no arguments (Write crashed with
 * ERR_INVALID_ARG_TYPE on an undefined path). Escaping control characters
 * that sit inside a string literal recovers those calls.
 */
function repairToolJson(text) {
  if (typeof text !== "string" || !text.trim()) return null;
  let out = "";
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) { out += ch; escaped = false; continue; }
      if (ch === "\\") { out += ch; escaped = true; continue; }
      if (ch === '"') { out += ch; inString = false; continue; }
      const code = ch.charCodeAt(0);
      if (code === 10) { out += "\\n"; continue; }
      if (code === 13) { out += "\\r"; continue; }
      if (code === 9) { out += "\\t"; continue; }
      if (code < 0x20) { out += "\\u" + code.toString(16).padStart(4, "0"); continue; }
      out += ch;
      continue;
    }
    if (ch === '"') { inString = true; }
    out += ch;
  }
  try { return JSON.parse(out); } catch {}
  const stripped = out.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").replace(/,\s*([}\]])/g, "$1");
  try { return JSON.parse(stripped); } catch {}
  return null;
}

export function createProvider(config) {
  switch (config.provider) {
    case "openai":
    case "workbuddy":
    case "qoder":
    default:
      return new OpenAIProvider(config);
  }
}
