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

export class OpenAIProvider {
  constructor(config) {
    this.config = config;
    this.baseUrl = normalizeBase(config.baseUrl);
    this.apiKey = config.apiKey;
    this.model = config.model;
    // Abort a request that never answers, so a hung endpoint can fail over
    // instead of blocking the conversation forever. 0 disables the timer.
    this.timeoutMs = Number(config.requestTimeoutMs ?? 90_000);
  }

  /**
   * Fetch with an inactivity timeout.
   *
   * The timer is reset on the first byte only: once a stream starts, the
   * provider is clearly alive and long generations must not be cut off.
   */
  async request(url, init, { stream = false } = {}) {
    const caller = init.signal;
    if (!this.timeoutMs || this.timeoutMs <= 0) {
      return fetch(url, init);
    }
    const controller = new AbortController();
    let timer = setTimeout(() => controller.abort(new Error("provider timeout")), this.timeoutMs);
    const onAbort = () => controller.abort(caller?.reason ?? new Error("aborted"));
    if (caller) {
      if (caller.aborted) onAbort();
      else caller.addEventListener("abort", onAbort, { once: true });
    }
    const clear = () => {
      if (timer) { clearTimeout(timer); timer = null; }
    };
    try {
      const res = await fetch(url, { ...init, signal: controller.signal });
      // Headers arrived: stop policing the whole request.
      if (stream) clear();
      return res;
    } catch (e) {
      clear();
      if (controller.signal.aborted && e?.name === "AbortError") {
        const reason = controller.signal.reason;
        if (caller?.aborted) throw Object.assign(new Error("aborted"), { name: "AbortError" });
        throw new ProviderError(`request timed out after ${Math.round(this.timeoutMs / 1000)}s`, { status: 408 });
      }
      throw e;
    } finally {
      caller?.removeEventListener?.("abort", onAbort);
    }
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

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
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

    const toolCalls = [...toolAccum.values()]
      .filter((t) => t.name)
      .map((t) => {
        let args = {};
        try {
          args = t.arguments ? JSON.parse(t.arguments) : {};
        } catch {
          args = { __raw: t.arguments, __parseError: true };
        }
        return { id: t.id, name: t.name, arguments: args, raw: t.arguments };
      });

    for (const call of toolCalls) onToolCall?.(call);

    return { text, reasoning, toolCalls, finishReason, usage };
  }

  async complete({ messages, tools, signal }) {
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

export function createProvider(config) {
  switch (config.provider) {
    case "openai":
    case "workbuddy":
    case "qoder":
    default:
      return new OpenAIProvider(config);
  }
}
