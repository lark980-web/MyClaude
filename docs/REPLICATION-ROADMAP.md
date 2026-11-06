# 完全复刻路线图

> 目标（用户 2026-11-06）：**完全复刻 Claude Code 2.1.302**。
> 本文件定义「完全复刻」的可达终点、分阶段计划、每阶段验收标准，以及**物理不可达**的部分。
> 所有数字以 `node scripts/parity-metrics.mjs --json` 现测为准，不手抄。

## 0. 「完全复刻」的定义（先消除歧义）

Claude Code 是两部分：**客户端程序**（这个 exe / 提取树）与**服务端**（Anthropic 账号、模型 API、
marketplace、遥测、远程会话）。本机只有前者。所以：

- **可达**：客户端的全部行为 —— 命令、工具、提示词、权限、会话、界面、引擎循环。
- **不可达**：服务端代码本身（不在本机），以及依赖它才能工作的功能（登录、云会话、插件市场）。

⇒ **「完全复刻」= 客户端 100% 对齐**；服务端相关功能只能做到「有对应的本地降级」。
这不是努力问题，是数据边界。下面每一阶段都标注了它属于哪一类。

## 1. 已完成（阶段 0，均实测）

| 项 | 状态 | 证据 |
|---|---|---|
| 上游引擎可独立运行 | ✅ | `/engine` 端到端、真实工具调用 |
| 引擎会话连续（--resume） | ✅ | 两轮实测答出记住的词，sessionId 一致 |
| 上游工具契约（描述词 + schema） | ✅ 11 个 | 9 个静态 + 2 个运行时取（Agent/AskUserQuestion） |
| 上游真实代码参与权限判定 | ✅ | `isReadOnly` 进程内调用（Bun 下） |
| 上游完整权限引擎 | ✅ 经 B 路线 | 实测拦下 `rm -rf` 并给理由 |
| 系统提示词六段结构 | ✅ | 13,192 字符，结构齐全 |
| 复刻度量脚本 | ✅ | `scripts/parity-metrics.mjs`，运行时取数、双口径 |

## 2. 阶段 1（✅ 本轮已完成）：执行后端统一 —— 最高价值

**问题**：目前 MyClaude 的日常 `/api/chat` 仍跑自研 agent，只有手动打 `/engine` 才用上游。
用户明确质疑过「界面没有任何改动，底层用了原生 Claude 吗」。

**目标**：让 MyClaude 的主对话路径可切换为上游引擎，且**结果进入 MyClaude 自己的会话历史**
（可恢复、可导出、界面按正常消息气泡渲染），而不是一条 notice。

| 子项 | 交付 | 验收 |
|---|---|---|
| NDJSON→SSE 翻译器 | `src/engines/upstream-chat.js` | 上游 `assistant`/`tool_use`/`result` → MyClaude `delta`/`tool_start`/`tool_end`/`done` |
| `/api/chat` 分流 | `src/ui/gui-server.js` | 环境变量 `MYCLAUDE_ENGINE_BACKEND=upstream` 时走上游；默认不变（零回归） |
| GUI 开关 | 模式按钮旁 | 一键切换后端，`/api/config` 持久化 |
| 会话落盘 | 服务端 | 上游回合的 user/assistant 文本写进 MyClaude session |

**设计底线**：默认 `self`，已有测试必须全绿；切换后才是上游。

**本轮实测结果**：

- `/api/chat` 在 upstream 后端下，SSE 事件序列为
  `session → reasoning → tool_start → tool_end → delta → assistant_end → done`；
- 真实界面（无头浏览器实测）渲染出**思考面板**与
  **「读取 package.json」工具卡**，助手回复作为正常消息气泡 —— 前端零改动；
- 会话落盘 `engine: "upstream"`，上游 sessionId 绑定后下一回合自动 `--resume`；
- 测试 5 项全绿（含假引擎全流程，不依赖 bun/B: 映射）。

## 3. 阶段 1 并行项：覆盖面（✅ 本轮已完成）

| 项 | 现状 | 目标 |
|---|---|---|
| 命令面（TUI） | ~~37/81 = 46%~~ → **81/81 = 100%** | ✅ |
| 命令面（GUI） | ~~31/81 = 38%~~ → **81/81 = 100%** | ✅ |
| 上游工具契约 | ~~11/96~~ → **12 个已接入**；schema 覆盖 **95/96 = 98.96%** | ✅ |

## 4. 阶段 2：交互与视觉细节

消息目录、工具卡渲染、diff 视图、状态行 `/statusline`、
编辑器模式 `/vim`、输出样式 —— 按界面价值排序，**逐轮**推进。

## 5. 阶段 3：物理边界（如实标注，不假装能做）

以下命令在上游内置表里，但**依赖本机没有的服务**：

- 账号/登录：`login`、`logout`、`setup-bedrock`、`setup-vertex`
- 云会话/远程：`remote-control`、`remote-env`、`teleport`、`desktop`、`mobile`
- 插件市场：`cloud-plugins`、`install-github-app`、`install-slack-app`
- 计费/用量：`usage-credits`、`extra-usage`、`rate-limit-options`

⇒ 这些可以做成「本地降级提示」（告诉用户该能力需要服务端），**不能做成真功能**。

## 6. 每轮验收（固定）

1. `node --test "test/*.test.js"` 全绿
2. `node scripts/parity-metrics.mjs` 数字不回退
3. `node scripts/verify-features.mjs` + `npm run inspect:prompt`
4. `node scripts/build-exe.mjs` + smoke 46 命令
5. 端到端：通过 7788 跑一个真实回合
6. 提交，工作树 0 未提交
## 7. 本轮（阶段 1）完成清单

- ✅ 执行后端统一：`/api/chat` 可切换上游，NDJSON→SSE 翻译，界面正常渲染消息/思考/工具卡
- ✅ 会话连续：`--resume` 绑定 + 失效降级
- ✅ 命令面本地相关 81/81 = 100%（TUI + GUI）
- ✅ 运行时 schema 普查 95/96，WebSearch 等 12 个工具采用上游契约
- ✅ GUI 后端开关、abort/断连清理
- ✅ 639/639 测试、exe 重建、端到端真实回合验证

**下一轮（阶段 2）**：交互与视觉细节（/statusline 真执行、/vim 键位、消息目录、工具卡渲染）
以及把 12 → 更多工具契约接入（多数云侧件本机无对应实现，需逐个判断）。