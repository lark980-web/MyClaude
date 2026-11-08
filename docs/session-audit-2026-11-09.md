# 会话问题系统审计（2026-11-09）

> 任务：task-8（WS-C，只读审计）。审计对象 = `C:\Users\Admin\.myclaude\sessions\*.json`。
> 唯一写入文件：`docs/session-audit-2026-11-09.md`。`src/` 全程只读，未运行 build-exe / bundle-gui，未 commit。
> 结论分三档标注：**【观察】**= 可直接复现/引用的事实；**【推断】**= 由观察推导，有替代解释；**【未知】**= 现有证据不足以判定。

> **行号冻结声明**：本文所有 `src/` 行号以 **2026-11-09 01:03（本地）** 读取的内容为准。审计期间并行任务（P2/P3 修复）**同时改动了** `src/ui/gui-server.js`（行号整体 +6～+9）、`src/engines/upstream-chat.js`、`src/engines/claude-code.js`、`src/main.js`。
> 收尾时已对 P5 相关引用**逐条复核并更新**（§1 全部、§4.4、§4.5、§5 N4/N5、§6）。
> `src/agent/agent.js`、`src/providers/openai.js`、`src/tools/index.js`、`src/session.js` 本次未被并行改动（`agent.js:745/744/571` 复核后不变），相关行号仍然有效。
> **请以本文的代码行号为准前先复核**：若 `gui-server.js` 行号对不上，说明该文件又被改动过，应重新 `grep` 定位而不是按本文行号跳转。

---

## 0. 审计范围与方法

**数据源**

| 项 | 值 |
|---|---|
| 会话目录 | `C:\Users\Admin\.myclaude\sessions\` |
| 文件总数 | 50 个 `.json`，合计 4.68 MB（`Get-ChildItem` + `Measure-Object`） |
| JSON 解析失败 | 0 / 50 |
| 主审会话 | `2026-11-08T11-44-52_9d93d2.json`（190,640 B，49 条消息，`engine:"upstream"`，`provider:"openai"`，`ui:"web"`，`turnCount:18`） |

**最近 15 个会话（LastWriteTime 降序，观察）**

| # | 文件 | 字节 | 消息 | engine | ui | model |
|---|---|---|---|---|---|---|
| 1 | 2026-11-08T11-44-52_9d93d2 | 190,640 | 49 | upstream | web | codebuddy/hy4free |
| 2 | final-default | 523 | 2 | upstream | web | codebuddy/hy4free |
| 3 | final-e2e-75 | 584 | 2 | upstream | web | codebuddy/hy4free |
| 4 | 2026-11-08T11-25-19_b2bbdc | 7,386 | 9 | — | gui | codebuddy/hy4free |
| 5 | 2026-11-05T18-24-45_55b5f8 | 990 | 6 | upstream | web | codebuddy/hy4free |
| 6 | real-upchat-1 | 607 | 2 | upstream | web | codebuddy/hy4free |
| 7 | 2026-11-03T16-59-42_4ec450 | 134,400 | 37 | — | gui | codebuddy/hy4free |
| 8 | 2026-11-03T23-20-11_bbc776 | 3,177 | 6 | — | gui | zcode/GLM-5.3-Flash |
| 9 | 2026-11-03T16-55-37_baafc1 | 659 | 2 | — | gui | loomy/DeepSeek-V4.1-Flash |
| 10 | 2026-11-02T14-26-15_e3a909 | 487,311 | 150 | — | gui | loomy/DeepSeek-V4.1-Flash |
| 11 | 2026-11-02T09-51-35_e826aa | 646,963 | 640 | — | gui | trae-cn/deepseek-v4.1-flash-max |
| 12 | 2026-11-02T09-36-33_0082c4 | 480 | 1 | — | gui | zcode/GLM-5.3-Flash |
| 13 | 2026-11-01T02-57-42_25f041 | 1,172 | 2 | — | gui | zcode/GLM-5.3-Flash |
| 14 | 2026-11-01T02-14-58_9a2887 | 2,110 | 6 | — | gui | zcode/GLM-5.3-Flash |
| 15 | 2026-11-01T01-43-01_96591c | 6,463 | 6 | — | gui | zcode/GLM-5.3-Flash |

合计 920 条消息 / 481 次工具调用 / 479 条 tool 结果。**15 个里只有 5 个含真实工具执行**（#1 #4 #7 #10 #11），其余 10 个是 1–6 条消息的冒烟/单轮会话，统计价值有限 —— 见 §2 口径说明。

**方法**

- 会话读取一律用 node（`fs.readFileSync` + `JSON.parse`），不动 shell 大 JSON 管线。
- 每次 grep 都带 `path` 限定（`src` 或具体文件），**未对仓库做递归 grep**（仓库含 2.8 GB apk 与 14.5 GB mitm-logs）。
- 工具失败判定口径：tool 消息内容以 `ERROR:` / `[stderr]` / `tool threw:` / `ERR_[A-Z]` 开头，或含 `[exit N]`（N≥1）。
- 编码提示：会话 JSON 是 UTF-8，但主审文件含 **485 个 U+FFFD 替换字符**，全部来自 cmd.exe 输出的 GBK 字节被按 UTF-8 解码（见 §4.2）。这些乱码**不是**产品 bug 本身，而是 §4.2 那条 bug 的症状，已在分析中区分处理。

---

## 1. P5（重点定论）：连续三条「[系统] 上一条回复只有思考过程、没有正文…」

### 1.0 先更正任务描述里的两处行号

**【观察】**

- 注入文案只存在于 **一处**：`src/agent/agent.js:745`。grep「上一条回复只有思考过程」在 `src` 下唯一命中 `src/agent/agent.js:745`。
- 但 `:745` 位于 **`runLoop()`** 内，**不在** `ensureFinalAnswer()` 内。`ensureFinalAnswer()` 定义在 `src/agent/agent.js:587`，于 `src/agent/agent.js:576` 被调用，函数体为 587–637，其中没有任何「上一条回复…」文案。
- 任务描述「注入代码在 :745（ensureFinalAnswer，定义在 :587，调用点 :576）」把**两条不同的补救链**混成了一句话。实际是两条：

| 机制 | 位置 | 触发条件 | 文案 |
|---|---|---|---|
| **A. 循环内空正文重试**（P5 的真正来源） | `src/agent/agent.js:737–757`，注入在 `:743–747` | `toolCalls.length === 0` 且 `stripReasoning(text).trim()` 为空 | `[系统] 上一条回复只有思考过程、没有正文…`（:745） |
| **B. 回合收尾补问** | `src/agent/agent.js:569–578` 调 `:587–637` | `runLoop` 正常返回后 | `[系统] 这一轮已经结束。请用中文直接写出给用户的最终结论…`（:596） |

判断依据：会话 `2026-11-08T11-44-52_9d93d2.json` 中下标 37/38/41 的文本与 `:745` 的字符串**逐字节相同**（55 字符），与 `:596` 的收尾指令不同。

### 1.1 (a) 这个机制是否也作用于 upstream 引擎回合？

**结论：【观察】否 —— 该补救机制属于自研 agent（agent.js），在 upstream 引擎路径上根本不可能运行。该会话实际跑的是自研引擎，文件里的 `engine:"upstream"` 是过期残留标记。**

**(a-1) upstream 路径完全绕过 agent.js —— 观察**

`src/ui/gui-server.js:2377–2385`：

```js
if (currentEngineBackend() === "upstream") {
  running.add(key);
  try { await runUpstreamChatTurn(res, body, key); }
  finally { running.delete(key); }
  return;                 // ← 直接 return，后面 agentFor()/agent.run() 全部不执行
}
```

- `currentEngineBackend()` 定义在 `src/ui/gui-server.js:216–220`。
- upstream 分支走 `runUpstreamChatTurn`（`src/ui/gui-server.js:227–277`）→ `streamUpstreamTurn`（`src/engines/upstream-chat.js:83–168`）。
- `streamUpstreamTurn` 只 spawn 上游 CLI、翻译 NDJSON（`src/engines/upstream-chat.js:27–70`），**不构造 Agent、不调用 `runLoop` / `ensureFinalAnswer`**。
- **关键反证**：upstream 路径写会话只有两行 push（`src/ui/gui-server.js:265–266`）：

```js
messages.push({ role: "user", content: message });
messages.push({ role: "assistant", content: finalText });
```

  它**永远不会**产生 `role:"tool"` 的消息。而 9d93d2 有 **26 条 `role:"tool"`** 消息（下标 2,3,5,6,8,…,36），且存在带 `tool_calls` 的 assistant 消息（下标 1,18,22,29,33…）。这类历史只有 `agent.js` 的 `runLoop` 写得出来（`src/agent/agent.js:779–787` 写 assistant+tool_calls，`:909` 写 `role:"tool"`）。

**(a-2) 为什么文件上还写着 `engine:"upstream"` —— 推断（机制已确证，触发时序未确证）**

机制：`saveSession` 是**读旧文件、用 `...meta` 合并覆盖**，从不删除旧字段。`src/session.js:95–114`：

```js
let prev = null;
if (existsSync(file)) { try { prev = JSON.parse(readFileSync(file, "utf8")); } catch {} }
const payload = {
  id, savedAt: prev?.savedAt || now, updatedAt: now,
  ...(prev?.title !== undefined ? { title: prev.title } : {}),
  ...(prev?.pinned !== undefined ? { pinned: prev.pinned } : {}),
  ...(prev?.archived !== undefined ? { archived: prev.archived } : {}),
  ...(prev?.unarchived !== undefined ? { unarchived: prev.unarchived } : {}),
  ...meta,                       // ← meta 里没有 engine 时，旧 engine 原样留下
  messages: messages || [],
};
```

而两条写路径的 meta 里，**只有 upstream 会写 `engine`**：

- upstream：`src/ui/gui-server.js:267–271` → `engine: "upstream"`（全仓库唯一写入点：grep `engine: "upstream"` 只命中 gui-server.js:270）。
- 自研 agent（GUI）：`src/ui/gui-server.js:286–295` 的 `saverFor` → `getMeta` 返回 `{cwd, model, provider, permissionMode, turnCount, version, ui:"gui", todos}`，**无 `engine`**。
- 自研 agent（TUI）：`src/main.js:161–170` 的 `sessionMeta()` 返回 `{cwd, model, provider, permissionMode, turnCount, version}`，**无 `engine`**。

因此：同一个 session key 只要**先**跑过至少一个成功的 upstream 回合（`finalText` 非空才会进 `src/ui/gui-server.js:261` 分支），随后再跑自研 agent 回合，文件就会**永久**保留 `engine:"upstream"`。

旁证：

- `C:\Users\Admin\.myclaude\engine-sessions.json:7` 有 `"2026-11-08T11-44-52_9d93d2": "dce1998f-453a-47ea-b0da-3e83ceff046f"` —— 该 session key **确实**绑定过上游会话，即确实跑过 upstream 回合。
- `C:\Users\Admin\.myclaude\config.json:32` 当前是 `"engineBackend": "upstream"`，而 `MYCLAUDE_ENGINE_BACKEND` 环境变量优先于它（`src/ui/gui-server.js:217–219`，未变动），用户可以在不改配置的情况下切换后端 —— 混合写入因此完全可能。
- 主审会话的 `provider:"openai"` / `model:"codebuddy/hy4free"` / `baseUrl:"http://127.0.0.1:3425/v1"` 全部是自研路径参数；upstream 路径会把同样的值透传给 CLI（`src/ui/gui-server.js:241–244`），所以这条只作弱旁证。

**【未知】** 无法从现有落盘数据判定「upstream 回合」与「自研回合」各自的先后与次数。原因：`saveSession` 每次全量覆盖 `messages`，历史分区信息已被抹掉；`turnCount` 在两条路径里语义也不同（upstream 是 `prev.turnCount + 1`，`src/ui/gui-server.js:269`；自研是 `agent.turnCount`，累计模型轮次）——本会话 `turnCount:18` 与 8 条 user 消息更吻合自研口径，但不足以定量。

### 1.2 (b) 为什么连续触发 3 次都没收敛？有没有次数上限？上限是多少？在哪一行？

**(b-1) 有上限，而且很小 —— 观察**

`src/agent/agent.js:737–757`：

```js
737  if (!toolCalls.length) {
738    const visible = stripReasoning(text).trim();
739    if (!visible) {
743      this._emptyBodyRetries = (this._emptyBodyRetries || 0) + 1;
744      if (this._emptyBodyRetries <= 2) {
745        this.messages.push({ role: "user", content: "[系统] 上一条回复只有思考过程、没有正文。请直接写出给用户的最终结论（中文正文，不要只思考，不要调用工具）。" });
746        continue;
747      }
748      const fromReasoning = lastReasoningParagraph(reasoning);
750      if (fromReasoning) { /* push + return */ }
756      return { text: "", done: true, turns: this.turnCount, finishReason: this.lastFinishReason };
757    }
```

- **上限行：`src/agent/agent.js:744`**，写法是 `count <= 2`，等价于上限 **N = 2**（每回合最多注入 2 次）。
- 计数器在**每次 `run()` 开头归零**：`src/agent/agent.js:569–571`，其中 `:571` 是 `this._emptyBodyRetries = 0;`。
- 每回合的上限序列：第 1 次空正文 → 注入（count=1）；第 2 次 → 注入（count=2）；第 3 次 → count=3 > 2 → 走 `:748` / `:756` 退出。

**(b-2) 主审会话的实际序列 —— 观察（消息下标）**

| 下标 | role | 内容/性质 |
|---|---|---|
| 33 | assistant | 带 3 个 `tool_calls`，正文 167 字 |
| 34, 35, 36 | tool | 36 = `ERR_INVALID_ARG_TYPE: path must be a string or TypedArray`（57 字符） |
| **37** | **user** | **注入 #1（55 字符）** |
| **38** | **user** | **注入 #2（55 字符，与 37 逐字节相同）** |
| 39 | assistant | `本轮共执行 26 个工具操作，模型未输出文字结论。` + 最后一步工具输出节选 |
| 40 | user | 真实用户消息：`展开说说实现方案和步骤` |
| **41** | **user** | **注入（第 3 次，逐字节相同）** |
| 42 | assistant | 5,961 字正文 —— 这次成功了 |

- 37 与 38 **相邻且之间没有任何 assistant / tool 消息**，说明两次注入之间模型都返回了「无 tool_calls 且正文为空」的回合（inject → empty → inject → empty）。
- 39 不是模型写的，是**确定性兜底摘要**：`src/agent/agent.js:89–100` 的 `summarizeTurn()`，模板见 `src/agent/agent.js:100`（`"本轮共执行 " + names.length + " 个工具操作，模型未输出文字结论。"`）。26 = 本会话 tool 消息总数，与观察一致。

**所以「连续 3 次」是两个回合、两次独立耗尽，不是一次重试跑了 3 轮：**

- **回合 X**：注入 37（count=1）→ 仍空 → 注入 38（count=2）→ 仍空 → count=3 → 超限 → 兜底摘要 39。
- **回合 Y**（用户消息 40 触发）：`run()` 把 count 归零 → 空正文 → 注入 41（count=1）→ 模型这次写出了 42。

**(b-3) 为什么不收敛 —— 观察 + 推断**

1. **【观察】注入文案每次完全相同。** 37/38/41 三条 55 字符逐字节相同，没有「这是第 N 次」「上次失败原因是 X」的增量信息。同一 prompt、同样条件，对采样固定的模型大概率复现同一行为。
2. **【观察】上限是「每回合 2 次」，不是「每会话」。** 计数器在 `src/agent/agent.js:571` 每次 `run()` 归零，用户每发一条消息就重新获得 2 次注入配额。会话级、时间窗级、跨回合预算都不存在（全仓库 grep `_emptyBodyRetries` 仅命中 :571 归零与 :743/:744 使用，无其它读取点）。
3. **【观察】`maxTurns` 挡不住它。** 空正文分支在 `src/agent/agent.js:746` 直接 `continue`，越过了循环计数检查 —— 即补救自身的次数也绕过 `maxTurns`（`config.json:10` 与 `:10` 为 `"maxTurns": 1000`，实际风险不大，但语义上是「计数豁免」而非有界补丁）。
4. **【推断】触发根因更像上游/网关输出形态，而不是提示词没写好。** 该回合最后一条工具结果是 `Read` 的 `ERR_INVALID_ARG_TYPE`（见 §4.3），由**模型自己产出的非法 JSON 工具参数**造成。模型随后进入「只思考、不写正文」状态，很可能就是推理通道有内容、`content` 为空 —— `src/agent/agent.js:740–742` 的注释正是在描述这一现象。

**(b-4) 结论一句话**

> 有上限，`src/agent/agent.js:744` `_emptyBodyRetries <= 2`（每回合 2 次），计数器在 `:571` 每回合归零。
> 用户看到的「连续 3 次」= 2 个回合：第 1 回合耗尽 2 次配额后落到确定性摘要（`:756` → `:628` 调 `summarizeTurn`），第 2 回合重新计时、注入第 3 条并成功。
> 不收敛的**直接**原因是配额只算「每回合」且文案无增量；**根本**原因是模型持续产出「只有 reasoning、content 为空」的回合（同回合还产出了非法 JSON 工具参数，见 §4.3）。

### 1.3 (c) 修复建议（**只给方案，未改任何代码**）

按「收益/风险/改动面」排序。以下均为位置引用，不代表已修改。

**R1（首选，改动面最小）：给注入文案加「第几次 + 上次失败形态」的增量信息。**
- 改哪里：`src/agent/agent.js:743–746`。
- 怎么改：`this._emptyBodyRetries` 已有值可直接用；注入文本拼上 `第 N 次`，并带差异化约束（如「这次请只输出一段不超过 200 字的中文正文」）。可选把 `reasoning` 尾段（`lastReasoningParagraph(reasoning)`，`:77–87`，同回合已有变量）截断后回喂，给模型一个可改写的草稿。
- 为什么：低成本直击 (b-3) 第 1 条；失败时不再产生两条逐字节相同的用户可见消息。
- 风险：注入变长、多耗 token。**【未知】** 对 `content` 恒空的上游网关是否有效，建议先用 3–5 个真实回合验证。

**R2：把配额从「每回合」提到「每会话时间窗」。**
- 改哪里：`src/agent/agent.js:571`（归零点）+ `:743–744`（判断点）。
- 怎么改：不要每回合重置；记录「同一 Agent 实例最近 N 秒内注入次数」（如 `this._emptyBodyInjectedAt`），注入前剔除 60 s 外的记录，超过 4 次不再注入、直接走 `:748/:756` 兜底。
- 为什么：这正是用户感知到的「连续 3 次」。当前设计下，模型只要对每条用户消息都犯同样的病，用户就会在每条回复前看到一模一样的系统消息。
- 风险：极端情况下更早放弃重试、更早落摘要。摘要至少可读（`:628`），比空回合好。

**R3：把「每回合 2 次」做成可配 + 把兜底从「沉默」改成「显式」。**
- 改哪里：常量在 `src/agent/agent.js:744`；兜底文案在 `src/agent/agent.js:628` 与 `:100`。
- 怎么改：提到 `this.config.emptyBodyRetries`（默认 2，在 `src/config.js` 加默认值），并按 `src/agent/agent.js:596` 收尾指令的风格，在摘要里明确告知「这是自动摘要，不是模型正文；可以让我重说一遍」。
- 为什么：用户看到下标 39 时无法分辨它是模型写的还是系统编的，这是可感知的信任问题。
- 风险：措辞需与上游 Claude Code 对齐。**【未知】** 上游是否有对应文案，本次未查。

**R4（治本，需先定性）：在 provider 层区分「reasoning-only 结束」与「真空回复」。**
- 改哪里：`src/agent/agent.js:738–742`（判定点）与 `src/providers/openai.js:322–337`（`text` / `reasoning` 汇聚处）。
- 怎么改：当 `finishReason` 表示正常结束、`reasoning` 非空而 `text` 为空时，可以在 `:748` 之前就把 `lastReasoningParagraph(reasoning)` 交给用户（现在只有 count>2 才走这条路），把「重试」降为「次选」。
- 为什么：`:740–742` 的注释已承认这是已知输出形态；先给用户 reasoning 尾段比连着问两次同一句话更划算。
- 风险：reasoning 尾段可能不是面向用户的成品文。**【未知】** `baseUrl` 指向的本地网关 `127.0.0.1:3425` 对 `reasoning_content` 的处理本次未审计。

**R5（防回归）：把「空正文 → 注入 → 兜底」做成 1 个可测纯函数。**
- 改哪里：把 `:737–757` 拆成 `decideEmptyBody(state)` → `{action: "inject"|"summarize"|"reasoning", reason}`，`runLoop` 只做副作用。`test/` 下已有 `gui-turn-closure.test.js` 等同族测试可挂。

**不推荐的改法**：单纯把 `:744` 的 `2` 调大。它会让模型病态时**更多**条一模一样的中文系统消息涌进对话历史（历史又被整段重发），是把症状加深。

---

## 2. 工具调用失败率

**【观察】口径**：分母 = tool 消息条数（= 已执行工具调用数，481 次调用 / 479 条 tool 结果）；分子 = 内容以 `ERROR:` / `[stderr]` / `tool threw:` / `ERR_[A-Z]` 开头或含 `[exit N]`(N≥1) 的 tool 消息。故这是**结果级失败率**（含模型自己选错命令），不是产品缺陷率。

| 会话 | tool 结果 | 失败 | 失败率 |
|---|---|---|---|
| 2026-11-08T11-44-52_9d93d2 | 26 | 3 | 11.5% |
| 2026-11-08T11-25-19_b2bbdc | 4 | 1 | 25.0% |
| 2026-11-03T16-59-42_4ec450 | 24 | 2 | 8.3% |
| 2026-11-02T14-26-15_e3a909 | 89 | 12 | 13.5% |
| 2026-11-02T09-51-35_e826aa | 329 | 21 | 6.4% |
| 其余 10 个会话 | 0–3 | 0 | 0% |
| **合计（15 个）** | **479** | **39** | **8.1%** |

**失败分布（观察，人工归类）**：Windows 上调用 Unix-only 命令（`ls` / `head` / `tail` / `grep` / `cat`）≈ 15 次；模型自写 `node -e` 脚本报 ENOENT / 内存溢出（`e3a909 [16]`）；测试用例本身红（`e826aa [497]/[513]` 的 `test/skills.test.js` 3 个 case ✖）；`curl` 连不上本地端口（`[exit 7]`）；`taskkill` / `timeout /` 在非交互 shell 下的用法问题（`e826aa [630]/[638]`）。**绝大多数是模型选错命令，不是工具坏了。**

### 2.1 超时 / 中止次数

**【观察】**

- `reached max turns`（`src/agent/agent.js:930`）：最近 15 个会话 **0 次**。
- `provider error:`（`src/agent/agent.js:722`）：**0 次**。
- `stream idle` / `stream interrupted`（`src/providers/openai.js:312/319`）：**0 次**。
- `结语生成失败`（`src/agent/agent.js:630`）：**0 次**。
- `(interrupted)`（`src/agent/agent.js:691/719`）：**0 次**。
- **工具超时（真实晋升）**：最近 15 个会话中 **1 次**。`2026-11-01T02-14-58_9a2887.json` 下标 **2** 的命令 `ping -n 9 127.0.0.1 > nul`（180 s 内未结束，实际撞上 3000 ms 默认上限），输出首行为 `[timeout after 3000ms — the command is still running as background task task_6413efe0]`（模板 `src/tools/index.js:810`）。
  这是**设计内行为，不是缺陷**：`src/tools/index.js:769–794` 明确选择「不 kill 超时命令，转而 adoptProcess 晋升为后台任务」。
- **全部 50 个会话里的真实工具超时**：**3 次**，全部产出晋升提示，无一次被误杀。另两处为 `2026-10-27T10-38-03_a3acb4.json [89]`（`node --test … | findstr` 用例）与 `2026-11-02T09-51-35_e826aa.json [632]`（`node bin/myclaude.js --gui --port 3000`），后者是启动 GUI 的正常长驻进程。
- **更正**：本次审计初稿曾把 `9d93d2` 下标 6 记为工具超时 —— 复核后确认那是 `Read` 读到的源码/git diff 文本里的 `timeout` 字样，**不是**运行期超时事件。以本条为准。

**【重要否证】** 「原生引擎超时」「原生引擎失败」这两条用户可见错误事件，在**全部 50 个会话里出现 0 次**（`role !== "tool"` 口径）。9d93d2 里出现的这几行字全部来自工具结果中的 **git diff 上下文行**（下标 8 的偏移 :14362 / :16207 / :16265 / :18265；下标 24 的 :1251），是被删行与新增行，不是运行期错误。

> 修正后统计：最近 15 个会话**没有任何一次** upstream 引擎回合以超时或失败告终。由于会话目录只保留 50 个文件（`src/session.js:63` `DEFAULT_SESSION_KEEP = 50`），更早的引擎超时事件已随文件清理丢失。**【未知】** 引擎超时的历史频率无法从落盘数据恢复。

### 2.2 错误事件文本分布（15 个会话）

| 文本 | 次数 | 性质 |
|---|---|---|
| `ERR_INVALID_ARG_TYPE: path must be a string or TypedArray` | 1（9d93d2 [36]） | **产品缺陷**，见 §4.3 |
| `[exit N]`(N≥1) / `[stderr]` | 39 中的绝大多数 | 模型命令选错（§4.1） |
| `原生引擎超时` / `原生引擎失败` | 0（仅 diff 上下文里出现） | 否证，见上 |
| `[系统] 上一条回复只有思考过程…` | 3（9d93d2 [37] [38] [41]） | P5 |
| `only thinking` 英文变体 | 0 | — |

---

## 3. 「仓库太大导致搜索超时」

**【观察】整个会话库里只出现 1 次，而且是模型自述，不是 harness 事件。**

- 位置：`2026-11-08T11-44-52_9d93d2.json` 消息下标 **44**（assistant，偏移 645）：「另外几轮递归全文扫描因为仓库太大超时，我停掉了，不影响这个结论。」
- 与该自述**同回合**的具体工具调用（下标 33 → 结果 34/35/36）全部是 `Read`，读的是 `src/engines/upstream-chat.js`、`src/engines/claude-code.js`、`src/ui/web/js/app.js` —— **没有一条是递归全仓扫描**。

**【未知】** 「那几轮递归全文扫描」的具体命令行**未落在任何会话文件里**。可能原因：(i) 发生在更早的、已被 `DEFAULT_SESSION_KEEP = 50` 清理掉的会话；(ii) 用户中途停下，该回合未被保存。**现有数据无法给出命令原文，不做推测。**

**【观察】相邻会话里有同类风险的证据**：`2026-11-08T11-25-19_b2bbdc.json` 下标 3 的命令（模型尝试递归遍历）在 Windows 上直接死于 `head` 不存在，报 `[exit 255]`。

**【推断】仓库体量已在代码注释里被当作已知约束**：`src/engines/claude-code.js:26–27` 明确写「实测：一次全工作区搜索（本仓库含 2.8GB apk 与 14.5GB mitm-logs）就超过 180s，引擎已跑完 2 个工具调用却被杀掉」。这正是 commit `70143a3`（静默超时替换绝对墙钟）要修的问题。也就是说：**该问题在 2026-11-08 已修过一轮，但修复只覆盖「引擎被误杀」，没有覆盖「递归 grep 本身没有护栏」** —— 见 §5 的 N8。

---

## 4. 其它反复出现、用户可感知的缺陷

### 4.1 Windows 上系统性误用 Unix-only 命令（**高影响，出现最频繁**）

**【观察】** 15 个会话中 15 次工具调用的命令行里出现只在 Unix 存在的命令，其中 **6 次 `ls`、9 次 `head`、2 次 `tail`、1 次 `grep`、1 次 `cat` 明确以「不是内部或外部命令」失败**。失败样本：

- `9d93d2 [3]`：`ls -la && echo "--- docs ---" && ls docs 2>/dev/null …` → `'ls' 不是内部或外部命令`，`[exit 1]`
- `e3a909 [10]`：`node --test test/skills.test.js 2>&1 | tail -30` → `'tail' 不是内部或外部命令`，`[exit 255]`（**测试其实跑完了，只是结果被管道吃掉**）
- `e3a909 [20]`：`git show --stat a2b4cfc | head -40` → `'head' 不是内部或外部命令`，`[exit 255]`
- `e826aa [12]`：`cd "E:\…" && grep -n "CONFIG_DIR" src/config.js | head -20`
- `e826aa [495]`：`node --check … && node --test test/skills.test.js 2>&1 | tail -20`

**【观察】机制**：`src/tools/index.js:744–747`

```js
const isWin = process.platform === "win32";
const shell = isWin ? "cmd.exe" : "/bin/sh";
const args = isWin ? ["/d", "/s", "/c", command] : ["-c", command];
```

选择本身有充分理由（`:738–743` 注释：cmd.exe ~80ms vs powershell 3–8s），但 `cmd.exe` 里**不存在** `ls/head/tail/grep/cat`，而系统提示词没有告诉模型「你在 Windows 的 cmd.exe 里」（Bash 工具描述 `src/tools/index.js:~700` 附近，未含 platform/shell 事实）。

**【推断】** 这是**信息缺口**而非模型能力问题：`echo` 被用 39 次，其中 16 次「失败」都是被同一条命令里的 `ls` / `head` 连坐。修复成本极低，收益是 15 个会话里约 15 条工具结果，以及「测试跑完了却报 255」这类**误导性失败**。

**建议（方案，未改代码）**：在 Bash 工具描述里注入运行时事实（`process.platform`、实际 shell、cmd.exe 下的等价命令对照：`dir` / `type` / `findstr` / `more`），或按 `src/engines/claude-code.js:26–27` 已确立的风格在 `src/agent/prompt.js` 加平台段。不要改 shell 选择本身（性能理由成立）。

### 4.2 cmd.exe 输出按 UTF-8 解码 → 乱码进入对话历史（**高影响**）

**【观察】**

- 主审会话 JSON 含 **485 个 U+FFFD**，全部集中在 `[stderr]` 文本里。例 `9d93d2 [3]` 的原文为 GBK(cp936) 的「'ls' 不是内部或外部命令，也不是可运行的程序」，解码后成片乱码。
- 机制：`src/tools/index.js:795–800`

```js
child.stdout.on("data", (c) => { if (stdout.length < 10*1024*1024) { stdout += c; } });
child.stderr.on("data", (c) => { if (stderr.length < 10*1024*1024) { stderr += c; } });
```

  **没有 `setEncoding`**，Buffer 走 `toString()` 即按 UTF-8 解码；中文 Windows 上 `cmd.exe` 的错误信息是 cp936 字节。
- 更严重的一例：`e3a909 [634]` 的 `taskkill` / `timeout` 报错是 UTF-16LE，按 UTF-8 解码后**几乎完全不可读**。

**【观察】影响面**：乱码文本被写进 `this.messages`（`src/agent/agent.js:909`），下一回合整段重发给模型。模型看到乱码，无法据此纠正命令 —— 与 §4.1 形成闭环，让同一错误反复出现。

**建议**：`src/tools/index.js:795–800` 按平台解码（`chcp` 探测或 `new TextDecoder("gbk")`），或 spawn 前先 `chcp 65001`。**【未知】** 改动对 `windowsVerbatimArguments` 路径的影响未评估，需回归。

### 4.3 非法 JSON 工具参数被静默吞掉 → 工具收到 undefined 路径（**中高影响**）

**【观察】完整链路（这是 P5 触发回合的直接原因）**

1. 下标 33 的 assistant 产出 3 个 `Read` 调用，第 3 个 `arguments` 是**非法 JSON**（被 EOF 截断）：`{"file_path": "E:\\WorkSpaces\\Test09\\MyClaude\\src\\ui\\web\\js\\app.js", "limit": 35` → `JSON.parse` 抛 `Expected ',' or '}' after property value in JSON at position 87`。
2. `src/providers/openai.js:326–331` 兜底为 `args = repaired || { __raw: t.arguments, __parseError: true }`。`repairToolJson`（`src/providers/openai.js:395–421`）只修**控制字符**，修不了**结构截断**，返回 null → **没有 `file_path` 键**。
3. `src/agent/agent.js:824` 与 `:857` 都会照常执行该调用。
4. `src/tools/index.js:89–91` 的 `readTool.run` 首行就是 `const st = await stat(file_path);` —— **没有** `typeof file_path !== "string"` 前置校验。
5. `stat(undefined)` 抛 `ERR_INVALID_ARG_TYPE`，被 `src/tools/index.js:133–135` 的 `catch (e) { return err(\`${e.code || "ERR"}: ${e.message}\`); }` 变成工具结果 → 下标 36 那条 57 字符消息 → 模型只思考不写正文 → P5。

**【观察】同仓库对比**：`writeTool.run` 在 `src/tools/index.js:190–192` **有**显式守卫（`typeof file_path !== "string"` 时返回「缺少 file_path 参数…」）。该守卫正是为同一个 bug 加的 —— `src/providers/openai.js:390–393` 的注释明确写「Write crashed with ERR_INVALID_ARG_TYPE on an undefined path」。**`readTool` 与 `editTool` / `multiEditTool` 没有跟着补**（grep `typeof file_path` 在 `src/tools` 下只命中 index.js:190 一处）。

**建议**：把 `writeTool` 的守卫抽成共用前置校验，接到所有带 `file_path` 的工具（`readTool :89`、`editTool :218`、`multiEditTool :672`）；或在 `src/providers/openai.js:330` 就让 `__parseError` 的调用走 error 分支，由 `src/agent/agent.js:795–801` 统一回 `ERROR: unknown tool arguments`（`:798` 已有同类分支可套用）。

### 4.4 `persistedOutputPath` 在自研路径上被丢弃（**中影响，静默**）

**【观察】**

- 生产端：`src/tools/index.js:823–826`，超过 `PERSIST_THRESHOLD = 30000`（`:32`）时把完整输出写盘并附 `persistedOutputPath` / `.persistedOutputSize`。
- 消费端只有一处：**upstream** 路径 `src/ui/gui-server.js:592–594`。
- 自研路径 `src/agent/agent.js:879–883` 的 `extra` 白名单只含 `attachments` / `git` / `diff` / `taskId`，**没有 `persistedOutputPath`** → GUI 上「输出太大已存盘」的入口在自研模式不出现，用户只看到被截断的前 30000 字符。

**【推断】** 这是两条执行路径的**契约漂移**：同一个 Bash 工具，走 upstream 有落盘入口，走自研没有。与任务已知的 P3（`additionalDirectories` 只传上游 TUI 路径、不传 GUI 上游路径：`src/ui/gui-server.js:240–245` 未传 vs `src/engines/claude-code.js:135/153` 接收）属同一类问题。

### 4.5 `engine` 会话标记是永久的、会说谎的残留字段（**中影响，误导排障**）

已在 §1.1(a-2) 给全证据。补充用户可感知的后果：

- `src/session.js:100–112` 的 `...meta` 合并语义意味着**任何一次**被写入的字段都永久保留。
- 打开会话文件看到 `engine:"upstream"` 会得到「这个会话跑的是原生引擎」的错误结论 —— 本次审计的 P5 就差点被它带偏。
- 全仓库只有 1 处写 `engine`（`src/ui/gui-server.js:270`），没有清零点。

**建议**：把 `engine` 纳入**每次** save 的必写 meta（`src/ui/gui-server.js:286–295` 与 `src/main.js:161–170` 各补 `engine: currentEngineBackend()` / `"self"`），或在 `saveSession`（`src/session.js:108`）把「路径相关标记」显式置空。

### 4.6 `engine-sessions.json` 不随会话文件清理而收缩（**低影响，卫生问题**）

**【观察】** `C:\Users\Admin\.myclaude\engine-sessions.json`（376 B，7 个键）含 `"ctx-test"`（第 2 行）、`"real-upchat-1"` 等**测试用 session key**，而 `sessions/` 目录已按 `DEFAULT_SESSION_KEEP = 50`（`src/session.js:63`）清理。`forgetEngineSession` 虽在 `src/engines/claude-code.js:5` 被导出，但全仓库 grep 显示**无调用点**。

**【未知】** 这些 session id 是否仍在上游侧有效、`--resume` 命中失效 id 的降级路径（`MISSING_SESSION_RE`，`src/engines/claude-code.js:77`）是否已在 upstream 路径接好 —— 本次未验证。

### 4.7 工作树里的可感知噪音（**用户可见，非 src 缺陷**）

**【观察】** `git status --short`（只读执行）：

- 未跟踪：**仓库根目录 48 个 `_*.txt` / `_*.mjs` / `_*.json` / `_*.png` 临时文件**（`_cfg-full.txt`、`_p10..\_p20.txt`、`_r1-full.txt`、`_rea_probe*.txt`、`_style-*.txt`、`_engine_gui.png` …），另有 `.re/`、`.myclaude/skills/`。
- 已修改未提交：`src/engines/claude-code.js`、`src/ui/web/css/styles.css`、`src/ui/web/js/app.js`、`test/gui-command-parity.test.js`、`test/gui-turn-closure.test.js`；**`test/followup-chips.test.js` 被删除（D）**。
- 最近 commit：`70143a3 fix(engine): 静默超时替换绝对墙钟 + 本地网关绕过代理；超时语义按 P10 标注结果未知`。

**【推断】** 这些 `_*` 文件正是会话里 `node _rea_probe.mjs` / `_q8.mjs` / `_rail-dump.mjs` 等命令的产物 —— 模型把调试脚本直接写在仓库根（`e826aa [61]`、`[297]`、`[329]`；`e3a909 [134]`）。它们同时是 §3「递归扫描变慢」的帮凶。

> **注意**：`test/followup-chips.test.js` 的删除**不是本次审计所为**（全程只读 `src/`，只新建了本文件与一个临时探针脚本，后者已删除）。该删除属并行任务（P1 追问卡）的改动范围。

---

## 5. 新发现问题清单（按影响排序）

| 编号 | 问题 | 证据 | 影响 | 置信度 |
|---|---|---|---|---|
| **N1** | Windows 上系统性把 Unix 命令交给 `cmd.exe`，提示词未告知平台/shell | `src/tools/index.js:744–747`；15 次命令、18 次二分失败；示例 `9d93d2[3]`、`e3a909[10][20]` | 工具失败率 8.1% 的主因；出现「测试跑完却报 exit 255」的误导性失败 | **观察** |
| **N2** | `cmd.exe` 输出按 UTF-8 解码，中文 Windows 下 stderr 变乱码并被重发给模型 | `src/tools/index.js:795–800` 无 `setEncoding`；主审 JSON 含 485 个 U+FFFD；`9d93d2[3]`、`e3a909[634]`（UTF-16） | 乱码污染历史，模型无法自我纠正 → 与 N1 形成复发闭环 | **观察** |
| **N3** | 非法 JSON 工具参数退化为 `{__parseError:true}`，无 `file_path` 守卫的工具直接崩 | `src/providers/openai.js:326–331`、`:395–421`；`src/tools/index.js:89–91` 无守卫 vs `:190–192` 有守卫；结果 `9d93d2[36]` | 用户可见错误文本 + 直接触发 P5 的重试风暴 | **观察** |
| **N4** | `persistedOutputPath` 在自研路径被丢弃 | 产出 `src/tools/index.js:823–826`；唯一消费点 `src/ui/gui-server.js:592–594`；`src/agent/agent.js:879–883` 白名单无此键 | 大输出落盘入口在自研模式不出现 | **观察**（代码路径）／**推断**（GUI 表现，未实机验证） |
| **N5** | `engine` 会话标记永久残留、会说谎 | `src/session.js:100–112` 的 `...meta` 合并；唯一写入点 `src/ui/gui-server.js:270`；两条自研 meta 均无该键（`gui-server.js:286–295`、`main.js:161–170`） | 误导排障与审计（本次 P5 即被它带偏） | **观察**（机制）／**推断**（本会话具体时序为**未知**） |
| **N6** | 空正文重试配额只按「每回合 2 次」计，绕过 `maxTurns`，注入文案无增量 | `src/agent/agent.js:571`（归零）、`:743–746`（判断 + continue） | 用户每发一条消息都会重新看到相同的系统噪音 | **观察** |
| **N7** | 空正文兜底摘要在 UI 上与模型正文无法区分 | `src/agent/agent.js:628` → `:89–100`；实例 `9d93d2[39]` | 用户会把系统摘要当成模型的回答 | **观察** |
| **N8** | 递归 grep 没有护栏（工具层无默认排除大二进制 / 无提前清理） | `src/tools/index.js` 的 grep 工具未见 exclude 默认；用户自述 `9d93d2[44]`；体量问题见 `src/engines/claude-code.js:26–27` | 慢查询反复消耗回合 | **推断**（用户自述为唯一证据，具体命令**未知**） |
| **N9** | `engine-sessions.json` 无清理挂钩 | `engine-sessions.json:2–7` 含测试键；`forgetEngineSession` 无调用点 | 绑定表无限增长；失效 resume 的降级行为未验证 | **观察**（无清理）／**未知**（实际危害） |
| **N10** | 仓库根目录 48 个 `_*` 调试产物未清理 | `git status --short` | 噪音 + 拖慢全仓扫描 | **观察** |

---

## 6. 分档汇总：观察 / 推断 / 未知

**观察（可直接引用行号或下标复现）**

`:745` 是唯一注入点且在 `runLoop` 内（非 `ensureFinalAnswer`）；`:744` 上限 = 2；`:571` 每回合归零；`gui-server.js:2377–2385` upstream 分支直接 return；`gui-server.js:265–266` upstream 只写 user/assistant；`session.js:100–112` 的 `...meta` 合并；`config.json:32` `engineBackend:"upstream"`；`engine-sessions.json:7` 绑定记录；下标 33–42 的完整序列；15 会话 / 481 调用 / 479 结果 / 39 失败 / 8.1%；`9d93d2[36]` 的非法 JSON；`tools/index.js:190–192` 有守卫而 `:89` 无守卫；50 个会话里真实工具超时 3 次、全部正确晋升为后台任务（`src/tools/index.js:769–794`）。

**推断（有替代解释，已注明）**

主审会话实际由自研引擎执行（upstream 不可能产出 `role:"tool"`，故必为自研；但具体切换时序未知）；N1 的根因是提示词缺平台信息而非模型能力；N4 的 GUI 表现；N8 的护栏缺失；N2 与 N1 构成复发闭环。

**未知（明确不凑结论）**

1. `engine:"upstream"` 写入该会话的具体时刻与次数。
2. 「几轮递归全文扫描」的**具体命令行**（自述见 `9d93d2[44]`，无落盘证据）。
3. 引擎超时的历史频率（`DEFAULT_SESSION_KEEP = 50` 已清理旧文件；最近 50 个会话中为 0 次）。
4. 本地网关 `127.0.0.1:3425` 对 `reasoning_content` 的处理（P5 根因的关键一环）。
5. R1–R4 修复方案对「`content` 恒空」型网关的实际有效性。
6. `engine-sessions.json` 中失效 id 在上游侧的降级行为。

---

## 附录 A：复现命令（全部只读）

```powershell
# 1) 最近 15 个会话（按 LastWriteTime）
Get-ChildItem 'C:\Users\Admin\.myclaude\sessions\*.json' |
  Sort-Object LastWriteTime -Descending | Select-Object -First 15 LastWriteTime,Length,Name

# 2) 唯一注入点（应只命中 src/agent/agent.js:745）
#    用 grep 工具，pattern: 上一条回复只有思考过程   path: src

# 3) P5 三问的代码位置（全部只读）
#    read src/agent/agent.js      offset 569 limit 20    → run() 归零 + ensureFinalAnswer 调用点
#    read src/agent/agent.js      offset 737 limit 21    → 上限与注入
#    read src/agent/agent.js      offset 580 limit 60    → ensureFinalAnswer 全 body
#    read src/ui/gui-server.js    offset 2366 limit 12   → upstream 分流
#    read src/session.js          offset 84  limit 31    → saveSession 的 ...meta 合并

# 4) 会话消息下标（node，不经 shell 处理大 JSON）
node -e "const j=require('C:/Users/Admin/.myclaude/sessions/2026-11-08T11-44-52_9d93d2.json');
j.messages.forEach((m,i)=>console.log(i,m.role,(m.tool_calls||[]).length,String(m.content||'').slice(0,60)))"
```

## 附录 B：本次审计的边界

- `src/` 全程只读；未修改任何源码；未运行 `build-exe` / `bundle-gui`；未 `git commit`。
- 唯一写入：本文件。过程中为读 JSON 曾在 `docs/_audit_probe.cjs` 落过一个临时 node 脚本，**已在收尾前删除**。
- 未对仓库做递归 grep（仓库含 2.8 GB apk 与 14.5 GB mitm-logs）。所有 grep 均带 `path` 限定。
- 会话统计覆盖「按 LastWriteTime 最近的 15 个」；「原生引擎超时 / 失败 = 0 次」这一否证覆盖全部 50 个会话文件。
