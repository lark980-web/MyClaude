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

## 4. 阶段 2：交互与视觉细节（进行中）

消息目录、工具卡渲染、diff 视图、状态行 `/statusline`（✅ 本轮已真执行）、
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
### 阶段 2 进度

- ✅ `/statusline`：上游 stdin 契约实测 + 真执行外部命令 + 三面接线 + 端到端验证
- ✅ `/vim`：上游 vim 引擎语义还原（`src/ui/vim.js` 纯状态机 + 39 项单测），
  TUI 输入框按 `editorMode==="vim"` 启用（NORMAL/INSERT/VISUAL/VISUAL LINE、
  操作符 d/c/y + 运动 + 计数乘法、文本对象 iw/aw/引号/括号、f/F/t/T + ;/,、
  寄存器 p/P、r/~/x/s/D/C/S、u 撤销、o/O/J 多行、双击 esc 清空、
  插入模式 remaps `vimInsertModeRemaps`（照上游 pn() 只收两字符→\<Esc\>））。
  已知差异如实标注在 vim.js 头注释（上游 NORMAL 的 X 无动作、无宏/搜索/redo、
  GUI 输入框暂为普通编辑）。
- ✅ 消息目录：长对话边缘情况清零（newChat 残留重放状态、恢复后新消息不进目录、
  「加载更早」重复 push、无文本死行）——无头 CDP 13 项端到端实测
- ✅ 工具卡渲染细节：折叠态 `⎿` 3 行预览 + `(+N lines)`（上游口径）、展开态
  30000 字符上限（上游 BASH_MAX_OUTPUT_LENGTH 默认值）

## 8. 夜航计划（2026-11-07 02:18 → 07:30）—— 已收账

| 轮 | 结果 | 提交 |
|---|---|---|
| R1 TUI Esc+Esc 编辑上一条消息 | ✅ 顺带修两个 P0（bridge.user 缺失、裸 dimColor 炸 TUI） | 969f37d |
| R2 工具契约扩容 | ✅ 12 → 17（EnterPlanMode/Skill 新工具；ExitPlanMode merge；MCP 资源契约） | 986f7cf |
| R3 测试环境加固 | ✅ GIT_CEILING_DIRECTORIES 解耦盘根 C:\.git → 全量首次满绿 | 4957a04 |
| R4 GUI vim 输入模式 | ✅ __MCVim 注入 + 全模式接管 + statusline vim.mode 契约（14 项 CDP） | 9a0bff8 |
| R5 视觉收尾 | ✅ 备用模型空池态核实为已完成；模态框经 audit-ui-consistency 无漂移 | （无代码改动） |
| R6 diff 视图细节 | ⬜ 结构已对齐（files/hunks/counts/着色）；上游 TUI 端深层细节抽取投入产出比低，记待办 | — |
| R7 输出样式 | ✅ 五态逐字还原（default/Proactive/Concise/Explanatory/Learning） | 15c18e5 |
| 追加修复 | ✅ vim 机器码作用域 bug（状态行刷新炸 boot 链，会话恢复/目录全挂） | 31c635e |

**最终闸门（含追加轮）**：全量 708/708 全绿；
追加轮：turnReminder 逐回合提醒（f4b637c）、真 TTY 闸门（d0226e3）、
TUI /config 交互面板（8d9d983）—— 上游 /config 本地可达枚举（Editor mode）已全覆盖。
CDP 双回归（目录/工具卡 13 项 + GUI vim 14 项）全过；
smoke 46 命令 0 崩溃；verify-features ✓；inspect:prompt 0 error；
度量：命令面本地相关 100%（TUI+GUI）、工具契约 17。

## 9. 2026-11-11 凌晨（并发覆盖事故修复 + 逻辑层深化）
- 修复 ac32bce 并发覆盖：引擎权限逻辑 + engine self 标记恢复（103b44c）
- 差分测试/dc1a70b；N9 绑定回收/7ba380e；真引擎 denials 实测（skip 如实）
- 流式 flag + stream_event 翻译（eb410b5）；压缩边界测试
- gate:fast/full 首次九步真绿；全量 794 项 793 绿 + 1 skip（如实）
- 参考仓库 clootee/clootee：启动器非复刻，分层模式等价，无可抄内容

## 10. 2026-11-11 逻辑层深化（hooks 对照 + 差分 + N9 + 流式）
- hooks 七项语义对齐上游（决策最严者赢/updatedInput/updatedToolOutput/
  additionalContexts 数组/permissionDecisionReason/stdin 补全）—— 行为级对照测试 18 项
- 差分测试 5 项 + 行为差分实测 4/4（真 gateway + 真工具链）
- N9 绑定回收 + 运行时生命周期测试
- 压缩边界表驱动 5 项
- gate 允许 honest skip（比假绿好）→ gate:full 九步全绿
- 全量 812 项 811 绿 + 1 skip
