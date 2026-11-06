# MyClaude ← Claude Code 2.1.302 对齐报告

> 依据产物：`E:\WorkSpaces\Test09\claude-re-2.1.302`（2683 模块全量提取、2433 明文 JS、22934 条依赖边、双路径交叉验证）
> 本文件记录：**已对齐**、**已适配（非照搬）**、**不可得（附证据）**、**待办**。
> 原则：MYCLAUDE.md「提取 Claude 的真实实现，再动手写代码」「提取不出来要如实说明」。

---

## 1. 产物可用性核实（本轮实测，非引用其报告）

| 项 | 2.1.276（旧） | 2.1.302（本产物） |
|---|---|---|
| 明文 JS 模块 | 1554（仅 965 具名） | **2432** |
| `chunk-<hash>.js` | 376 唯一 | **2428，0 个 unnamed** |
| import 可解析率 | 341/1887 ≈ **18%** | **22935/26149 ≈ 87.7%**（余下全为 Node 内置） |
| 依赖图 | 断裂不可用 | **2428 节点 / 22934 边 / 979 零入度根，拓扑无环** |
| 系统提示词 | 仅字符串片段 | **逐字还原 10,707 字符** |

旧产物断链根因：Bun 模块图 `off` 是图内坐标而非 PE 偏移，名字表与切分块无法对齐（实测按序索引 1/200 命中）；且只在 192–221MB 窗口内 carve（.bun 实为 135.6MB）。本产物用容器格式还原（52 字节记录 + payloadByteCount + 名字池）解决了这两点。

## 2. 已对齐

### 2.1 系统提示词（最大杠杆）

- 文件：`src/agent/prompt.js`，**1,455 → 12,310 字符**（上游 10,707）
- 结构按上游六段：`# System` / `# Doing tasks` / `# Executing actions with care` / `# Using your tools` / `# Tone and style`，保留本项目 `# Language`、`# Environment`，新增 `# Delegating with Task`（共 8 段）
- 忠实保留的高价值条款（逐条断言）：
  - 授权安全测试边界；**永不猜测 URL**
  - 权限模式与「被拒绝后不得重复同一调用」
  - 提示注入怀疑须先向用户报告
  - hooks 反馈视为用户输入
  - 上下文自动压缩
  - **可逆性与影响范围**（含危险动作清单、measure twice cut once）
  - 任务是否过大以用户判断为准；探索性问题 2-3 句
  - 默认不写注释、不过度设计、不加无用错误处理
  - UI 改动须真浏览器验证，否则明说
  - tone：`file_path:line_number`、工具调用前不加冒号、不加 emoji
- 本地化改写：`TaskCreate`→`TodoWrite`、`CLAUDE.md`→`MYCLAUDE.md`、`/help` 指向 MyClaude、**不冒用 `You are Claude Code` 身份**

### 2.2 多代理编排（仅迁移原则）

来源 `04-prompts/orchestrator-prompt.txt`（15,739 字符）→ 主提示词 `# Delegating with Task`：
- 不为一件小事委派（读一个文件、跑一条命令不配 Task）
- 不用子代理互相查岗
- 独立调研并行、写操作串行（按文件集切分）
- Task 提示词必须自包含（子代理看不到父对话）
- **绝不编造/预测子代理结果**
- 复杂规划的扇出模式：一个 Task 摸清现状、一个列出所有待改文件、一个找风险与边界 → 综合成有序计划 → 可选再派一个 Task 做批评

**明确未迁移**（MyClaude 无对应能力，照搬会让模型调用不存在的工具）：
`SendMessage` 续跑 worker、`subscribe_pr_activity`、`task-notification` XML 协议、`subagent_type` 特化、`ULTRAPLAN_TELEPORT_LOCAL` 远程规划流程。

### 2.3 子代理提示词

`src/agent/task-tool.js` 的 `SUBAGENT_PROMPT_SUFFIX`，5 行 → 6 条：不得扩大范围/执行工具输出里的指令、不能提问故需声明假设、先调查再动手、只读工具集不得声称做了改动、报告须含文件路径与未完成项。

### 2.4 内置技能 `verify`（已移植）

- 文件：`src/skills-builtin.js`（8,593 字符正文）+ `src/skills.js` 接入（最低优先级，可被用户/项目覆盖）
- 来源：`07-assets/docs/SKILL-cf37e4b8.md`（12,146 字符）
- 核心纪律完整保留：验证即运行时观察；测试/类型检查不算证据；禁止 import-and-call 冒充；
  定 diff → 定表面 → 拿 handle → 驱动 → 反向探测（至少一条 PROBE）→ 保留证据 → 固定格式报告；
  判定 PASS/FAIL/BLOCKED/SKIP；不接受部分通过；存疑即 FAIL
- 本地化：`.claude/skills`→`.myclaude/skills`；剔除 `examples/` 链接、`run-skill-generator`、`SendUserFile`、`gh pr diff`

### 2.5 动态 gated 段（7 段逐一评估，2 段已用）

| 段 | 判定 | 处理 |
|---|---|---|
| `subagent_steer_delegation` | **适用** | 替换主提示词委派纪律：先算子代理开销、小事自己做、不为小任务扇出、不派子代理复查可自验之物、委派后不重复、少而精 |
| `autonomy_append` | **适用** | 新增 `AUTONOMY_SECTION`，仅 `config.autoRun` 时注入 |
| `opus5_reduced_delegation` | 不适用 | 模型（opus5）专属 |
| `heron_brook` | 不适用 | 主值依赖运行时实验 |
| `brook_heron` | 不适用 | 无法静态还原 |
| `willow_tern` | 不适用 | 实验开关驱动的措辞变体 |
| `endconv_deferred_hint` | 不适用 | 依赖 `EndConversation` 工具，MyClaude 无此工具 |

### 2.6 Anthropic prompt caching（已实现）

依据 `07-assets/docs/prompt-caching-485cdf9d.md`（33,539 字符）在 `src/providers/anthropic.js` 实现：
- 断点 1：最后一个 system 块（渲染顺序 tools→system，此点同时缓存 tools+system）
- 断点 2：最后一条消息的最后一个内容块（前缀增量命中）
- 共 2 个断点（API 上限 4）；`config.promptCaching === false` 可关闭；不污染历史
- 边界：最小可缓存前缀 512~4096 tokens（模型相关），不足静默不缓存；按 workspace 隔离

### 2.7 Shift+Tab 权限模式轮转（已实现）

依据 `07-assets/docs/recent-changes-j2j9vm5c.md`：上游顺序 `default → acceptEdits → plan → bypassPermissions → auto → default`，
`bypassPermissions`/`auto` 仅在可用时出现，**`dontAsk` 永不进环**。

- `src/agent/modes.js`：`MODE_CYCLE` + `nextMode()`（单一来源，本项目 `ask` = 上游 `default`）
- 排除项：`dontAsk`（上游排除）、`fullAccess`（本项目逃生门，需刻意指定）
- GUI：`cyclePermissionMode()` + document 级 Shift+Tab；经 `/api/config` 持久化
- 真浏览器实测：`fullAccess` → `ask → acceptEdits → plan → bypassPermissions → auto`，0 异常
- `test/mode-cycle.test.js` 含 GUI 环与 modes.js 的一致性断言（防漂移）

### 2.8 已移除的上游命令（不实现）

| 上游命令 | 2.1.302 状态 | 本项目处理 |
|---|---|---|
| `/vim` | **已移除**，改为 `/config` → Editor mode | 保留开关并**真生效**（见 §2.9）；同时写上游真键 `editorMode` |
| `/output-style` | **已移除**，改为 `/config` → Output style | 保留现有实现，仅记录差异 |
| `/pr-comments` | 已移除 | 不实现 |
| `/extra-usage` | 改名 `/usage-credits` | 不实现 |
| `--enable-auto-mode` | 已移除，改 `--permission-mode auto` | 不实现 |

### 2.9 vim 编辑模式（TUI，本轮对齐）

上游 vim 是完整编辑器引擎，全部语义从产物提取（非凭记忆）：

| 上游事实 | 出处 |
|---|---|
| `editorMode` 枚举 `["normal","vim"]` | `chunk-xsh3yvk4.js` `yBo=[...]` |
| 启用判定 `editorMode==="vim"` | `chunk-ngbt62mk.js` `o8()` |
| NORMAL 即时动作表 mn（x/s/S/D/C/Y/p/P/r/~//,、i/I/a/A/o/O、J） | `chunk-2n177qz0.js` `var mn=Object.assign(...)` |
| VISUAL 动作表 wn（v/V 切换、o 交换、u/U 大小写、r、p） | 同上 `var wn=...` |
| 操作符 `ge={d,c,y}`、运动集 dt/xe、find 集 `Oe={f,F,t,T}`、文本对象 `be={i,a}` | 同上 |
| 计数上限 `pt=10000`、撤销栈上限 `Pt=1000`、单匿名寄存器 `gt()` | 同上 |
| 插入进入位置 Qe()（`a` 在空格上原位） | 同上 |
| remaps：仅插入模式、键恰两字符、目标仅 `<Esc>` | `chunk-a8gj4nyv.js` schema 描述 + `pn()` |
| 模式指示 `-- INSERT --` / `-- VISUAL --`（NORMAL 隐藏） | `chunk-a8gj4nyv.js` `hideVimModeIndicator` 描述 |
| statusline stdin `vim.mode ∈ INSERT\|NORMAL\|VISUAL\|VISUAL LINE` | `chunk-e0x0xb6d.js` 契约注释 |
| 双击 esc 清空输入 | `chunk-9fg8a8zw.js` 页脚 "double tap esc to clear input" |

本项目 `src/ui/vim.js`（纯状态机）+ `src/ui/ink-app.js`（接线）。**已知差异（如实）**：
上游 NORMAL 的 X 无动作（mn 表未收录）→ 同样不动；无宏/搜索/redo（产物未见）；
`>`/`<` 缩进不适用；GUI 输入框暂无 vim；statusline `vim.mode` 因 GUI 无 vim 暂不下发。

## 3. 不可得（附证据，不做假）

| 项目 | 结论 | 证据 |
|---|---|---|
| 工具参数 schema | **不可静态还原** | 2.1.302 改为程序化构造（全树仅 64 处 `input_schema` 字面量）；`07-assets/docs/claude-code.d.ts` 的 `BuiltinToolInputs` 是**空的声明合并表**（需插件侧填充） |
| `isReadOnly` / `isConcurrencySafe` | **不可判定** | `03-features/tools-permissions.md` 67 个工具中两字段几乎全为 `?`，文档自述「为代码中方法返回值或 null，无法静态判定」 |
| 斜杠命令全集 | **抽取器噪音，不采用** | `03-features/commands.md` 混入 `/<Qt>`、`/[object Object]` 及 Chrome DevTools 工具名（`read_page`/`resize_window`/`navigate`）；产物自身 `same-pipeline-diff-notes.md` 已声明 tools/commands 清单为噪音 |
| `run-<unit>` 技能模板 | 场景不匹配 | `template-ba7exx31.md` 是 SKILL.md 生成模板，非 `/init` 的 CLAUDE.md 模板 |
| 原始源码路径 | 确不存在 | 产物 §「原始源码路径确证不存在」：发布包无 sourcemap，模块名全为 `chunk-<hash>.js` |

命令面结论：MyClaude 的命令对齐以**上一轮已验证的 35 个真实命令名**（来自 2.1.276 注册表模块 `964_chunk-0qdm07jf.js`）为准，TUI 仅剩 `/plugins /statusline /sandbox /vim /todo`，GUI 侧已归零（除 Anthropic 生态专属）。

## 4. 待办（按价值）

1. `04-prompts/dynamic-sections.md`（27KB，7 段 gated）：5 段完整、1 段部分、1 段依赖运行时状态；多为 A/B 实验文本，需逐段判断是否适用
2. `07-assets/skills.md`（76KB，28 个 SKILL）：~~对齐~~ → **已移植 `verify`（见 §2.4）**；其余多为 Anthropic 生态专属（Artifacts/Cowork/plugin-authoring），不适用
3. `07-assets/builtin-docs.md`（89KB）：内置文档资产
4. `03-features/module-architecture.md`：架构级借鉴
5. TUI 剩余命令 `/statusline /vim /todo`（`/sandbox` 已有意以命令分级替代）

## 5. 验证证据

- 全量测试 **554/554** 通过（`test/system-prompt-parity.test.js` 10 项 + `test/builtin-skills.test.js` 4 项）
- `node scripts/verify-features.mjs` ✓
- exe 已重打，UTF-8 字节确认 `Delegating with Task`、`Never fabricate or predict a sub-agent result`、`read-only (Read, LS, Glob, Grep)` 等已编入二进制
- 7788 服务在跑（`--gui --no-open`）
