# Changelog

本文件记录 MyClaude 的所有重要变更。格式参考 [Keep a Changelog](https://keepachangelog.com/)，
版本号遵循 [SemVer](https://semver.org/)。

> 说明：此前项目没有 changelog，也没有任何 git 提交（`E:\` 仓库 `main` 分支为空），
> 所以 `0.2.0` 一节是根据源码时间戳（2026-10-17 15:56–17:42）与实际代码内容回溯整理的第一份记录。

## [Unreleased]

### Removed（2026-11-14 上午，用户指令：始终保持原生 Claude）

- **对话框 @ 引用**：composer 的 @ 按钮、输入触发与占位文案全部移除。
  原生 Claude 引擎自行解析消息里的 @path，GUI 侧引用菜单不再需要。
- **引擎切换（自研 / 原生 Claude）**：composer 切换控件移除，
  `POST /api/config` 不再接受 `engineBackend`；`main.js` 生产配置默认
  `engineBackend: "upstream"` 并持久化——引擎始终为原生 Claude，无切换入口。
  测试需自研引擎的在 startGui 显式传 `config.engineBackend: "self"`。

### Fixed（2026-11-14 夜航：GUI 六大主诉——@ / 技能 / 断线续跑 / 命令面）

**@ 引用搜不到源码文件**

- 症状：输入 `@` 后菜单里找不到 `src/**`、`test/**`——仿佛这些目录不存在。
- 根因：文件索引是 DFS + 400 条上限。本仓库根目录有上百个 `myclaude-export-*.md`，
  配额在走进任何子目录之前就被耗光；首次请求还赶上后台建索引返回空列表，
  前端收到 `[]` 直接关菜单。
- 修复：BFS（浅层目录先入索引）+ 上限 1500 + 跳过 `-Force`/`%SystemDrive%` 类垃圾目录；
  索引未建好时首个请求等待构建完成；服务启动即预热。

**技能「装了却用不了」——根因是双布局断层**

- 症状：GUI 创建的技能，模型说「未注册」；`/技能名` 在 GUI 里直接报「未知命令」。
- 根因（决定性）：GUI 会话实际跑在 **upstream 引擎**（原生 Claude Code 子进程）上，
  它只读 `.claude/skills/` 与 `~/.claude/skills/`；而 MyClaude 全套读写 `.myclaude/skills/`。
  `/api/agent-debug`（本次新增诊断面）显示 `sessionKeys: []` 实锤了这一点。
- 修复：`skillDirs` 双布局读取（`.claude/skills` + `~/.claude/skills`，`.myclaude` 同名覆盖）；
  `createSkill` 双布局落盘；GUI 斜杠菜单列出技能、`/技能名` passthrough 到 agent；
  元消息以 `<system-reminder>` 包裹（裸文本被弱模型当闲聊忽略）。
  e2e：修复前模型转头 grep 仓库找定义；修复后 upstream 引擎逐字执行技能正文。

**刷新/断网 = 任务被拦腰打断**

- 症状：任务跑到一半刷新页面（或 Wi-Fi 抖一下），回合直接死亡。
- 根因：SSE `close` 一到就 `abort()` 整个回合。上一版的修复（避免 409 砖死）
  用「杀掉任务」换「会话可用」——两个都有理，但杀任务治不了本症状。
- 修复：turnBus——回合事件进每会话缓冲并向所有挂接客户端扇出；断开只摘客户端
  不杀回合；`GET /api/turn-state` + `GET /api/turn-events`（重放 + 跟随）让刷新后的
  页面接回去。前端复用同一事件渲染路径，409 自动转跟随模式。
  真浏览器实测：长任务 → F5 → 「已重新接上」→ 后台生成全文完整回放 → 正常收束。

**GUI 命令面缺 14 条 TUI 命令**

- attach/attachments/detach/base/key/computer-use/continue/rm/save/reload-memory/
  vision/skill/dream/loop 在 GUI 无处可跑，斜杠菜单也不可见。
- 修复：EXTRA_COMMANDS 补齐（save/dream 走服务端命令桥），全部进菜单；
  「提示中的命令必须可派发」守卫扩展认可注册表键。

**误粘贴的优雅关机代码长在 gitNumstat 里**

- 症状（隐性地）：SIGINT/SIGTERM 处理只在 git diff 出错后才注册——
  正常进程从来没有优雅关机，Ctrl+C 直接丢内存里的会话。
- 根因：一段 flushAllSavers 代码被整块粘进了 `gitNumstat` 的 git-failed 分支。
- 修复：移回 `startGui` 顶层。

### Added（2026-11-14）

- 技能管理面板：左栏入口 + `/skills`——列表（scope 徽标）、新建/更新（名字规范化、
  覆盖开关）、删除（双布局同步移除）。
- `/api/skills` GET/POST/DELETE + `/api/agent-debug`（服务进程的 cwd/技能目录/
  工具表/最近请求 meta 视图——技能链路排障的事实来源）。
- GUI 语音、设置、导出等既有控件经全量巡检：116 控件 0 JS 异常；
  前端 44 个 `/api` 调用与服务端路由逐一配对 0 死端。

### Fixed（第二轮：审计挖出的 4 类问题 + 一个自己挖出来的 schema 缺陷）

**N1 Windows 上系统性误用 Unix 命令（审计 §4.1，出现最频繁）**

- 症状：15 个会话里 15 次把 ls/head/tail/grep/cat 交给 cmd.exe，**18 次二分失败**。
  最典型：`node --test ... | tail -30` 在 cmd.exe 上退出码非零 ——
  **测试其实跑完了，结果被管道吃掉**。
- 根因：提示词里的 `# Environment` 只报了 `process.platform`（win32），
  从没说过「这个平台意味着什么」—— 模型只能按 Unix 直觉发命令。
- 修复：把事实补进**已有的** Environment 段（不是新开一节 —— 重复标题会被
  `inspect-prompt` 的 section-duplicate 检查判错）：Bash 背后是 cmd.exe，
  哪些 Unix 工具不存在、管道会吞输出、优先用 Read/Glob/Grep。

**N2 cmd.exe 输出按 UTF-8 解码 → 乱码回流给模型（审计 §4.2）**

- 症状：中文 Windows 下 cmd 的 stderr 是 cp936，被按 UTF-8 解码 → 主审会话 JSON 里
  **485 个 U+FFFD**；乱码写回 messages 再发给模型，形成复发闭环。
- 修复：chcp 探测控制台代码页后**逐块流式解码**（跨块多字节挂起缓冲；非 Windows 时等价原行为）。
  实测真实 GBK stderr → U+FFFD = 0；144KB CJK 跨块同样 0。

**N3 非法 JSON 工具参数被静默吞掉（审计 §4.3）**

- 症状：解析失败兜底成空对象 → `readTool` 第一行就是 `stat(undefined)` →
  `ERR_INVALID_ARG_TYPE`。**这正是那条「只有思考过程」会话的触发原因。**
- 修复：参数守卫挂在 `allRegisteredTools()` / `findTool()` 上（导出对象不变），
  9 个工具缺参/类型错都返回**可读错误**；JSON 解析失败保留原文 + 缺失字段名回给模型，
  截断的 JSON 直接补全。顺带修掉 Grep/Glob 空参**默认扫 cwd** 的隐藏坑。

**N5 会话 engine 标记不可靠（审计 §4.5，机制已更正）**

- 两条自研写入路径都不传 `engine`，而 `saveSession` 只白名单保留
  `title/pinned/archived/unarchived` —— 其它键不传就丢弃。于是同一会话在后端间切换时，
  该字段时有时无，排障时无从判断「这一回合谁跑的」。
- 修复：两条路径都显式声明 `engine: "self"`。
- **顺带更正审计报告 §1.1(a-2)**：审计称该字段是「永久残留」，经行为测试证伪 ——
  真实机制是「最后写入者获胜」。审计对 (a) 的答案仍成立，错的只是机制解释。更正已写入文档 §7。

**N6 空正文补救不收敛（审计 §1.2/§1.3）**

- 症状：同一会话连续出现 3 条**逐字节相同**的「[系统] 上一条回复只有思考过程…」。
  上限写死「每回合 2 次」且每次 run() 归零 —— 用户每发一条消息就重新拿到 2 条。
- 修复：**两个上限并存** —— 每回合仍 2 次（保住补救节奏，审计明确警告过别单纯调大），
  另加**每会话 60 秒窗口 4 次**（不随回合归零）；文案带上「本会话第 N 次」并逐次不同约束；
  兜底摘要加「[自动摘要，非模型原文]」前缀（此前它与模型正文在界面上无从分辨）。

**TodoWrite 广告给模型的 schema 是坏的（第二轮自查发现）**

- 症状：`todos` 被写成 `type: object`（应为 array）、
  `status` 是 `type: unknown`、minimum 的值是一段字符串化了的校验参数（不是数字）。
- 根因（我的）：静态抽取没解析出数组/枚举，而早先的合并逻辑写的是「只填补 null」，
  **只填空、不纠错** —— 于是正确的运行时版本从未被采用。
- 修复：用运行时 getter（权威来源）纠正 **11 个**带未解析标记的条目，重新生成。
- **加了一道通用守卫测试** `test/tool-schema-soundness.test.js`：扫**全部**广告 schema，
  断言没有未解析类型、没有残留标记、数值边界不是字符串、array 必有 items ——
  让整类问题不可能再悄悄溜过去。

**澄清**：这套 schema 只在**自研后端**生效。上游引擎自带工具集（它的工具清单里根本没有
TodoWrite），所以上游模式下广告什么 schema 都不影响引擎。

**验证**：全量 **779/779**；exe 重建；verify-features ✓；smoke 47 命令 0 崩溃；
TodoWrite 数组调用成功、旧的 object 形状被明确拒绝。

### Fixed（追问卡是假的 + 引擎权限写死 —— 用户报的两件事）

用户原话：「最新的会话问题一大堆，无法创建技能」+「追问卡每次都是固定的内容，这他妈是什么鬼东西，就这还复刻claude？」
两条都确诊并修复，另有并行审计挖出 10 条新问题。

**① 追问卡：假的，而且上游根本没这个功能**

- 位置：`src/ui/web/js/app.js:1833` `buildFollowupPrompts()`。按「有没有 artifact / 代码块」
  返回**三套写死文案**（默认恒为「展开方案 / 行动清单 / 边界分析」），与对话内容零关系。
- **上游 2.1.302 没有这个功能**：对 2429 个上游模块做三个定向探针
  （`nextSteps|suggestedFollowUp|followUpSuggestion|suggestionChips`、`what would you like to do next`、
  `try asking|you could also ask`）—— **全部 0 命中**。
- 实测危害：会话 `2026-11-08T11-44-52_9d93d2` 里用户点了写死的「展开说说实现方案和步骤」，
  随后连续出现 3 次「[系统] 上一条回复只有思考过程、没有正文」的补救轮。假卡片制造了浪费的回合。
- **处置：整体移除**（app.js −75 行 / styles.css −107 行）。这不是复刻目标，是装饰性伪造。

**② 引擎权限模式写死，用户选择被忽略**

- `gui-server.js` 把引擎调用写死 `permissionMode: "acceptEdits"` —— 界面上切模式对引擎**毫无作用**。
- `buildEngineArgs()` 的模式白名单是**错的**：写的是
  `["default","acceptEdits","plan","bypassPermissions"]`，而引擎自己的 `--help` 说真值是
  `["acceptEdits","auto","bypassPermissions","manual","dontAsk","plan"]` —— 根本没有 `"default"`，
  而且 MyClaude 的 `ask/dontAsk` 全被静默降级成了 `acceptEdits`。
- 修复：7 个 MyClaude 模式逐一映射（`ask → manual`），**未知值退到最保守的 `manual`，绝不退到放行档**。
- 顺带修掉一个**守护错误的旧测试**：`test/native-engine.test.js` 断言「未知模式落回 acceptEdits」并称其为「安全默认」——
  那是 fail-open。现在断言必须落 `manual`。

**③ 引擎拿不到额外工作目录**

- MyClaude 有 `config.additionalDirectories`（`/add-dir` 维护），但从不传给引擎 → 引擎只能碰项目目录，
  连 `~/.claude/skills` 都列不出来。现在通过 `--add-dir` 传下去。

**④ 授权策略显式化 + 失败讲清楚**

- 引擎默认 `--permission-prompts host`：它把授权询问发给宿主，而 MyClaude 不实现该协议 → 询问悬空。
  现在显式设 `none`，行为确定：会询问的一律拒绝，并**如实回传到 `result.permission_denials`**。
- 新增 `describeDenials()`：把拒绝转成可操作的提示 —— 列出被拒的工具与**确切路径**，
  命中上游硬保护目录（`.claude/skills|commands|agents`，见 `chunk-zvergrz0.js` 的 `Ef()`）时给出两条出路。
  此前用户只看到「没装成」，不知道挡在哪、也不知道怎么办。

**验收（真实端到端，非单测）**：切「全部放行」后让引擎创建技能 ——
引擎用 `Write` 写出 `.claude/skills/e2e-probe/SKILL.md`，回复 `SKILL-CREATED`，
**文件真的落盘**且内容正确（55 秒）。探针已清理。
全量 **748/748**。

### Added（会话问题系统审计）

- `docs/PLAN-2026-11-09.md` —— 本轮推进计划（问题确诊 + 分工 + 验收 + 红线）。
- `docs/session-audit-2026-11-09.md`（450 行）—— 只读审计 50 个会话，结论分【观察/推断/未知】三档。
  - **更正了 Lead 给的行号**：注入点在 `agent.js:745` 的 `runLoop()`，不在 `ensureFinalAnswer()`（那是另一条补救链）。
  - ⚠️ **该节有一处推论被 Lead 的行为测试证伪，已在文档内更正**：`saveSession` 只白名单保留
    `title/pinned/archived/unarchived`，**其它键不传就丢弃** —— 所以 `engine:"upstream"` 不是残留，
    而是「最后一次写入来自 upstream」。那条会话是**混合**的（早期自研回合留下 26 条 tool 消息，
    之后跑过 upstream 并 append 两条）。审计对 (a) 的答案仍成立，错的只是机制解释。
  - 真实缺陷更轻：两条自研路径都不传 `engine`，导致该字段在自研回合**缺失**（而非留着旧值）。
    **已修**：两条路径都声明 `engine:"self"`，并加回归测试锁住白名单机制。
  - 「连续 3 次」= **2 个回合**：配额 `agent.js:744` 是「每回合 2 次」，`:571` 每回合归零。
  - **两条重要否证**：`原生引擎超时/失败` 在**全部 50 个会话里出现 0 次**（会话里那几行字来自 git diff 上下文）；
    「仓库太大导致搜索超时」全库只出现 1 次且是模型自述，同回合实际调用全是 `Read`，**没有一条递归扫描**。
  - 新发现 10 条（N1–N10），含 Windows 上系统性误用 Unix 命令（18 次二分失败）、
    cmd.exe 输出按 UTF-8 解码致 485 个替换字符进历史、`readTool` 缺参数守卫等。
### Fixed（原生引擎两个独立故障：代理污染 + 超时策略错误）

用户报「原生引擎超时（180 秒）」且任务无法进行。排查出**两个互不相关的 bug**，都已修复并验证。

**① 超时策略错误（主因）**

- 旧实现是 `setTimeout(kill, timeout)` —— **从 spawn 起算的绝对墙钟，永不重置**。
  于是**只要引擎在干活就会被砍**。实测：一次全工作区搜索（本仓库含 2.8GB apk 与
  14.5GB mitm-logs）就超过 180s，引擎跑完 2 个工具调用却被杀掉。
- 改为**静默超时（idle）**：引擎有输出（工具调用/文本/事件）就说明活着，计时器随之重置；
  只有连续 `idleMs` 无输出才算卡死。绝对上限保留作兜底（默认 60 分钟）。
- 再补一层：**飞行中的工具调用豁免静默判定**。引擎跑长命令时本来就长时间无输出
  （在等自己的工具），把这种静默也当卡死会误杀。有工具在飞行中时不武装静默计时器，
  只受绝对上限约束。
- 实测：引擎在思考期间会持续发 `system/thinking_tokens`，静默判定因此只在「真的什么都没输出」时触发。
- 参数可配置：`MYCLAUDE_ENGINE_IDLE_MS` / `MYCLAUDE_ENGINE_MAX_MS` 环境变量，
  或 `POST /api/config {engineIdleMs, engineMaxMs}`（`GET /api/config` 回传）。
  同时清掉了 gui-server/main.js 里全部硬编码的 `180_000`。

**② 代理环境污染（排查中发现的第二个 bug）**

- `engineEnv()` 用 `...process.env` 把宿主的代理配置透传给引擎。宿主环境有
  `HTTPS_PROXY=http://127.0.0.1:7897` + `NODE_USE_ENV_PROXY=1`，但**没有 `no_proxy`** 时，
  引擎会把发往**本机网关**（127.0.0.1:3425）的明文请求交给代理，
  代理回 `400 The plain HTTP request was sent to HTTPS port` —— 整个回合直接失败。
- 修复：`engineEnv()` 显式注入 `NO_PROXY`/`no_proxy`，**本地地址永不走代理**，
  与宿主已有值合并而非覆盖。
- 复现与验证：去掉 `no_proxy` 的组合修复前 100% 复现 400，修复后 100% 通过。

**③ 超时语义（P10 纪律）**

- 超时后不再报「已终止」（暗示什么都没做）。新增 `describeTimeout()`：说明中止原因、
  **列出中止前已执行的工具调用**、明确标注**结果未知、可能已产生部分修改**。
  引擎在被杀前可能已经改过文件，把「不知道」说成「没发生」是错的。

**验证**：新增 `test/engine-timeout.test.js` 8 项（含「持续输出的引擎不被误杀」回归测试）；
真实端到端：idle=60s 下跑完 146.7 秒的多步回合，模型思考阶段与静默执行长命令的阶段都存活，回复正确。

**教训（如实记录）**：此前那批测试里，超时相关的只验证了「超时能杀掉引擎」这个**机制**，
从没问过「180 秒这个数字对不对」—— 假引擎都是秒退的，没有一个测试跑过 3 分钟的任务。
机制正确 ≠ 策略正确。

### Added（追加轮 5：截图证据链 3 —— 夜航轮 9）
- 13 /output-style 五态清单（含 4 个上游新样式与描述词）14 设置中心四 tab。
- R6 定案依据补充：上游字节码无 ⎿ 字符 —— 工具结果行格式与 MyClaude 不同源，
  GUI 结构等价判定维持。

### Added（追加轮 4：截图证据链 + 变更 tab 空态文案 —— 夜航轮 8）
- scripts/shot-parity.mjs / shot-parity2.mjs：GUI 功能全景截图证据（shots/ 12 张 PNG，
  每张先断言 DOM 标记再落盘，逐张人工校验）：vim INSERT/NORMAL/VISUAL 指示器、工具卡
  折叠⎿预览与展开截断、消息目录、备用池空态、Projects/提示词库模态框、变更 tab、模型菜单。
- 变更 tab 空态文案补充说明（本轮/分支两个 scope 各自的指引）。
- 发现并记录如实差距：GUI vim 的 VISUAL 选区在 textarea 中无反色高亮（原生控件限制，
  引擎层 selection 正确）。
- 修正 backlog 两项视觉项（凭截图勾掉过时描述）。

### Added（追加轮 3：TUI /config 交互面板 —— 夜航轮 7）
- 上游 /config 是 enum 交互面板（{id,label,options,type:"enum"}），MyClaude 此前是 JSON dump。
- ink 面板：↑↓ 选行、←→/Enter 循环取值、Esc 关闭；本地相关三项——Editor mode、
  Output style（含自定义风格清单）、自动压缩；应用即改即存（saveConfig）并重建提示词。
- /config raw 保留 JSON dump（plain UI 同样走原路径，零回归）。
- test/ink-tui.test.js 增面板用例（5/5）；全量 708/708 全绿；TTY 闸门改轮询式。

### Added（追加轮 2：真 TTY 验证闸门 —— winpty）
- ink TUI 此前从未在真实终端验证过（管道回落 plain UI）。新 scripts/verify-tui-tty.mjs
  用 winpty 代理 pty 真渲染：欢迎屏/插入指示器/状态行 vim 标记/真实回合全部确认。
- 六闸门补全为七项（+真 TTY）。真 TTY 下 /config 面板帧证据（cfgPanelSeen）——
  顺带修复 ink-ui.js 漏传 onConfigOpen/onConfigApply（面板在 TTY 中打不开）)。

### Added（追加轮：输出样式逐回合提醒 turnReminder —— 夜航轮 6）
- 上游机制（chunk-e0x0xb6d.js）：样式激活时每个用户回合注入 turnReminder；等待后台任务
  时切换 waitingTurnReminder（Proactive 专属：Do not poll, sleep, or re-read its output）。
- 逐字接入：Proactive（Aer/Per）、Concise（Oer）；Explanatory/Learning 上游无提醒。
- agent 循环按 [系统] 约定随用户回合注入（prompt.js：harness 注入、非用户原文）；
  waiting 检测走 listTasks 动态 import（避免与 tools/tasks 循环依赖）。
- 全量 707/707 全绿。

### Added（R7：输出样式对齐上游 —— 夜航轮 5）
- 内置输出样式从 3 个中文短片段改为上游 2.1.302 的五态逐字还原（chunk-e0x0xb6d.js l9）：
  default（无片段）、Proactive、Concise、Explanatory、Learning —— 片段含上游 tone 段、
  样式节头（# X Style Active）与完整正文（含 Learn by Doing/TODO(human) 协作流程）。
- 本地适配如实标注（文件头注释）：persona 首段不进片段（system prompt 自带）；
  描述词 Claude→MyClaude；上游装饰符 te.bullet/te.star 取 •/✻。
- /output-style 与 GUI 样式清单自动扩为五态（listOutputStyles）。
- 全量 706/706 全绿；inspect:prompt 0 error。

### Added（R4：GUI vim 输入模式 + statusline vim.mode —— 夜航轮 4）
- bundle-gui 把 src/ui/vim.js（唯一事实源）剥 export 注入为 window.__MCVim，GUI 不复制引擎代码。
- GUI 输入框按键接管：INSERT/NORMAL/VISUAL 全模式、指示器随模式显隐（NORMAL 隐藏 = 上游
  hideVimModeIndicator 语义）、双击 esc 清空；中文 IME（isComposing/229）与系统剪贴板键
  直通；slash/@ 菜单打开时 vim 让位（方向键/Enter 归菜单）；粘贴等外部写入以 DOM 为准对齐
  引擎。
- /api/config 补 editorMode/vimMode/vimInsertModeRemaps 三个字段（此前 GUI 读不到启用状态）。
- statusline stdin 契约补 vim.mode（上游 chunk-e0x0xb6d.js）：GUI 实时上报，服务端仅放行
  INSERT|NORMAL|VISUAL|VISUAL LINE 四枚举，配置未启用 vim 时不放行。
- /vim 文案更新：TUI 与 GUI 输入框均生效。
- 新增 scripts/verify-gui-vim.mjs（无头 CDP 14 项）+ test/statusline.test.js vim 用例。

### Fixed（R3：changes-api 测试与盘根仓库环境解耦 —— 夜航轮 3）
- 盘根 `C:\.git`（环境事实，HANDOFF §9）让任何 C: 盘临时目录都被判成「在 git 工作
  树内」，non-git 降级用例必然误分类为 git-failed —— 此前全量永远 703/704。
- 测试进程设 `GIT_CEILING_DIRECTORIES` 把 git 向上搜索钉在临时目录根：测试与环境
  里是否存在盘根仓库彻底无关。
- 全量测试首次 **704/704 全绿**。

### Added（R2：工具契约 12 → 17 —— 夜航轮 2）
- 从上游运行时抽取产物（out-all-runtime.json）逐字接入 5 个工具契约：
  EnterPlanMode（新工具：经用户确认后 agent.setMode("plan")）、ExitPlanMode（own→merge：
  上游 allowedPrompts 已标 Deprecated，本地 plan 参数作为有据可查的扩展别名保留）、
  ListMcpResources/ReadMcpResource（上游内部名 ListMcpResourcesTool/ReadMcpResourceTool，
  参数面恰好一致）、Skill（新工具：findSkill 注入技能正文，未知名列出可用清单；
  上游按 skill 动态生成 description，MyClaude 单工具用同语义静态形式）。
- 接线：runtime.js setModeController（工具不持有 agent 引用，与 presenter 同模式）；
  NON_MUTATING_TOOLS 增 EnterPlanMode/Skill。
- 新增 test/r2-tool-contracts.test.js（5 项）：契约逐字断言 + 交互流 + 注册叠加验证。
- 度量：adoptedInMyClaude 12 → 17。

### Added（R1：TUI Esc+Esc 编辑上一条消息 —— 夜航轮 1）
- `agent.rewind` 加 depth：depth=1 保持 GUI 编辑重发语义（保留并替换最后一条提问）；
  depth>1 连目标提问一起撤掉，编辑后的文本由调用方重发。
- `ink-app.js`：双 esc 唤起「编辑上一条消息」选择器（最新在前、↑/↓ 选、Enter 编辑、
  Esc 取消，busy 时不开）；编辑模式提示行，Enter 重发（展示区同步截断）、Esc 取消。
- vim 模式：空输入下双 esc 同样唤起选择器（非空时双 esc 仍是上游语义的清空输入）。
- `main.js` runTui 接 onEditMessage：depth=1 走 reuseLastUser 重放（与 GUI retry 同
  语义），depth>1 回退后按新提问重跑。
- **顺带修复两个既有缺陷**：① TUI 从不调用 bridge.user —— 用户消息从未进
  transcript（上游会显示），Esc+Esc 选择器也无数据可选；② ink-app.js 里 18 处裸
  `dimColor` 简写（相当于引用未定义变量）—— 真 TTY 下 ink TUI 一渲染就崩，
  TUI 从未真正工作过。
- 新增 `test/ink-tui.test.js`：ink 真渲染测试座架（mock stdin/stdout + setRawMode/ref
  桩 + write 捕获），4 项端到端：双 esc 开选择器/取消与重开/busy 守卫/vim 模式编辑。
- 已知细节：管道驱动 exe 时 stdin 无 raw mode，ink 拒绝并回落 plain UI —— 管道
  e2e 测不到 ink 组件，故以本座架为准。

### Fixed（消息目录边缘情况 + 工具卡渲染 —— 阶段 2 第三/四项）
- **消息目录三个真 bug**（无头 CDP 真浏览器实测证实后修复）：
  1. `newChat()` 清了 DOM 但不清 `S._replayMsgs`/`S._replayStart` —— 新对话的
     目录仍列旧会话提问，点击还会经 `loadUntilRendered` 把旧消息**注入新对话**；
  2. 恢复会话后新发的消息不进目录（全库无 `_replayMsgs.push`），目录冻结在恢复
     时刻 —— 现在 `addUserMessage` 的 live 路径写入目录数据源并打 `dataset.srcIdx`；
  3. 「加载更早」走的 `renderReplayRange` 不在 `replayingHistory` 期内，与 live
     push 相互污染（重复条目 + srcIdx 覆写）—— 重放渲染全程置位标志。
  另：目录跳过无文本提问（无可渲染气泡的死行）。
- **工具卡输出截断**（此前全量塞 DOM，长输出把主线程和滚动卡爆）：
  折叠态加 `⎿` 预览——≤3 行全显、否则 3 行 + `… (+N lines)`（上游
  `chunk-3qs3b8zt.js` 口径）；展开态正文上限 30000 字符并标注
  （上游 `BASH_MAX_OUTPUT_LENGTH` 默认值，`chunk-1wyh415r.js DCr=30000`）；
  卡片展开后预览隐藏、由正文接管。
- 新增 `test/gui-catalog-toolcard.test.js`（7 项源码断言）+
  `scripts/verify-catalog-toolcard.mjs`（无头 CDP 端到端 13 项：
  目录完整性/未加载跳转+闪烁/预览行数与省略文案/30000 截断/新消息进目录/0 JS 异常）。

### Added（/vim TUI vim 键位 —— 阶段 2 第二项）
- 新增 `src/ui/vim.js`：vim 编辑引擎纯状态机（无 React/Ink 依赖），语义从上游
  Claude Code 2.1.302 提取还原（`chunk-2n177qz0.js` 状态机与 mn/wn 两张动作表、
  `chunk-xsh3yvk4.js` editorMode 枚举、`chunk-a8gj4nyv.js` vimInsertModeRemaps、
  `chunk-e0x0xb6d.js` statusline vim.mode 契约、`chunk-9fg8a8zw.js` 双击 esc 清空）。
  覆盖：NORMAL/INSERT/VISUAL/VISUAL LINE 四态、操作符 d/c/y（含 `2d3w` 计数乘法、
  cw 特判、空范围分支）、运动 h/l/0/^/$/w/W/b/B/e/E/%/j/k/G/gg、f/F/t/T 与 ;/, 重复、
  文本对象 iw/aw 与引号/括号（di(/ci"/da[）、单匿名寄存器（linewise 标志）+
  p/P、r/~/x/s/S/D/C/Y、u 撤销（插入会话成组）、o/O/J 多行、双击 esc 清空、
  插入模式 readline 键（ctrl+a/e/b/f/k/w）、remaps `{"jj":"<Esc>"}` 规范化。
- `src/ui/ink-app.js`：`/vim` 开启后主输入框换装 vim 组件（NORMAL 反色块光标、
  VISUAL 反色选区、`-- INSERT --`/`-- VISUAL --` 指示器 + showcmd pending 标签；
  引擎为唯一事实源防 React 状态竞态；箭头保留历史导航；状态行加 vim 标记）。
- `src/main.js` `/vim`：真生效并同步上游真键 `editorMode`（"vim"/"normal"）与
  兼容键 `vimMode`；GUI `/vim` 文案更新（如实标注 GUI 输入框暂为普通编辑）。
- 新增 `test/vim.test.js`（39 项）：引擎全语义 + 上游特判（NORMAL X 无动作、
  a 的空格原位、计数上限 10000、remaps 两字符规范化）。
- 已知差异（如实）：无宏/搜索/redo（上游提取未见）、`>`/`<` 缩进不适用、
  GUI 输入框暂无 vim；上游 statusline stdin 的 `vim.mode` 字段因 GUI 无 vim
  暂不下发，契约记录在 vim.js 头注释。
- 验证：TUI 真跑 `/vim on` → INSERT 打字 → esc → `x` → `S` → 提交 `/help` 全链路；
  smoke 探针加 `/vim`。

### Changed（系统提示词对齐 Claude Code 2.1.302）
- 依据 `claude-re-2.1.302/04-prompts/system-prompt.txt`（逐字还原 10,707 字符）重写
  `src/agent/prompt.js`：1,455 → **11,266 字符**，按上游六段结构组织
  `# System` / `# Doing tasks` / `# Executing actions with care` / `# Using your tools` / `# Tone and style`，
  外加本项目原有的 `# Language` 与 `# Environment`。
- 对齐内容：persona 前置（对应上游 persona+intro 两段）、授权安全测试边界、URL 生成禁令、
  权限模式与拒绝后不得重复同一调用、`[系统]` 注入说明、hooks 反馈视为用户输入、
  上下文自动压缩、判断用户是否觉得任务过大以用户为准、探索性问题 2-3 句回答、
  不过度设计/不加无用错误处理/默认不写注释、UI 改动须真浏览器验证、
  **可逆性与影响范围（Executing actions with care 全文含危险动作清单）**、
  TodoWrite 跟踪任务、并行工具调用、tone 规则（file_path:line_number、工具调用前不用冒号）。
- 本地化改写：`TaskCreate`→`TodoWrite`、`CLAUDE.md`→`MYCLAUDE.md`、`/help` 指向 MyClaude、
  去掉 GitHub issue 反馈链接与 `You are Claude Code` 身份，保留 `You are MyClaude`。
- 新增 `test/system-prompt-parity.test.js`（6 项）：六段结构、密度区间、
  14 条高价值子句、**只引用真实存在的工具**（防提示词指挥模型调不存在的工具）、
  不冒用上游身份、本地命名与插值正确。
- 全量 **546/546**、`verify-features` ✓、exe 已重打并确认关键子句已编入二进制。

### Added（阶段 2 第一项：/statusline 从「只存配置」升级为「真执行外部命令」）
- **上游契约实测**（不再猜）：`chunk-e0x0xb6d.js@2656002` 的 statusLine setup agent
  提示词给出了完整 stdin JSON（session_id / session_name / prompt_id / transcript_path /
  cwd / model{id,display_name} / workspace{...} / version / output_style / context_window / effort）；
  `@3688311` 的 `Lbr()` 是执行点：stdin 传 JSON，取 status=0 的 stdout，
  按 `trim().split(" ").flatMap(...).join(" ")` 压成单行。
- **新增 `src/agent/statusline.js`**：`buildStatusLineInput()` 按上游契约构造 stdin、
  `runStatusLine()` 执行外部命令（5s 超时、非零退出/超时/无命令一律降级返回 null，
  状态行是装饰，绝不能拖垮主流程）、`normalizeStatusLineOut()` 按上游口径压行。
- **三面接线**：
  - 服务端新增 `GET /api/statusline`（执行命令返回文本）；`POST /api/config` 白名单加
    `statusLineCommand`，修掉「GUI 只写 localStorage、服务端读不到」的两边不通；
  - GUI 右栏新增「状态行」section，`refreshStatusLine()` 节流刷新、done 后强制刷新；
    `/statusline <命令>` 同时写本地偏好与服务端并立即刷新；
  - TUI `/statusline` 设置后**立即跑一次预览**并显示输出（无常驻状态栏，如实标注）。
- **端到端实测**（无头浏览器）：`/statusline echo STATUSLINE-OK` → 右栏状态行节点显示
  `STATUSLINE-OK`，`/api/statusline` 返回 `{ok:true,text:"STATUSLINE-OK",command:"echo STATUSLINE-OK"}`，0 JS 异常。
- **测试 9 项**：契约字段、effort 可选、stdout 压行、stdin JSON 传递、非零退出/无命令降级、
  `/api/statusline` 执行/未配置、POST 同步、三面注册。全量 **648/648**。

### Added（阶段 1 并行成果：命令面 100% + 运行时 schema 全量普查 + GUI 后端开关）
- **命令面补齐（并行成员 cmd-porter）**：上游 133 个内置命令中**本地相关的 81 个**，
  TUI 与 GUI 均从 46%/38% 补到 **81/81 = 100%**（`parity-metrics` 现测，
  `tuiMissing/guiMissing` 均为空）。全量 133 口径 TUI 61% / GUI 62%（余为云侧/账号/生态命令）。
  - TUI 新增 33 个 case（advisor 真接 autoReview、autocompact 联动 compactThreshold、cd 真 chdir、
    heapdump 真 v8 快照、security-review 本地审查回合、statusline/vim 偏好持久化等）。
  - GUI 同步 33 条 handler + 菜单项，另补 output-style / exit / resume / session / plan。
  - **6 个云侧命令**（import/ultrareview/upgrade/insights/artifacts/team-onboarding）如实降级为
    「本机无对应服务」+ 本机替代，不假实现；3 个 GUI 环境限制（cd/heapdump/plan）同样标注。
  - 新增 `test/commands-parity.test.js`（11 项）。
- **GUI 后端开关**：输入框内「自研 / 原生 Claude」两段切换（`.engine-backend-switch`），
  GET `/api/config` 读 `engineBackend`、POST 回写，切换 toast 提示。
  无头浏览器实测：开关存在、默认 self、点击可切、0 JS 异常；assets.js 已重打包进 exe。
- **上游运行时 schema 全量普查（并行成员 runtime-census）**：新增
  `17-extract-all-runtime.mjs`，三通道（Qt 模块导出 / getAllBaseTools 注册表 / 配置单例播种）
  运行时拿到 **91 个**工具 schema；较静态抽取**新增 8 个**（SendMessage、TaskStop、
  SendUserMessage、WebSearch、Projects、ArtifactComments、ArtifactData、ArtifactCheck）。
  合并后覆盖率 **95/96 = 98.96%**（原 87/96），仅剩 1 条参数化模板占位——它本身不是具体工具。
  文档 `docs/runtime-tool-census.md`，每条带文件+偏移。
- **WebSearch 接入**（8 个新增里 MyClaude 有对应实现的那个）：上游用 `blocked_domains`、
  自研用 `block_domains` 且多一个 `max_results` —— merge + 别名 + run 入口归一，
  两套命名都到得了执行体。采用上游契约的工具 **11 → 12**。
- **upstream 模式健壮性**：新增 `onChild` 回调 + `upstreamChildren` 表，
  `/api/abort` 与浏览器断连时都会杀掉上游子进程（此前刷新页面会留孤儿进程）。
- 全量 **639/639**、`verify-features` ✓、`inspect:prompt` 0 error、
  bundle-gui 已重打、exe 已重建（20:16:49）、smoke 46 命令 0 崩溃。

### Added（阶段 1 核心：执行后端统一 —— MyClaude 主对话可跑原生 Claude Code）
- **目标**：此前 `/engine` 只是「一个命令」，MyClaude 的日常 `/api/chat` 仍跑自研 agent。
  本轮把上游引擎接成**可切换的执行后端**，让界面正常聊天时底下就是原生 Claude Code。
- **新增 `src/engines/upstream-chat.js`**：上游 stream-json（NDJSON）→ MyClaude SSE 事件翻译器。
  实测事件形态：`assistant.text`→`delta`、`tool_use`→`tool_start`、
  `user.tool_result`→`tool_end`（按 tool_use_id 回查工具名）、`result`→`assistant_end`。
  **前端零改动** —— `delta` 自动建气泡、`tool_start` 自动建工具卡。
- **`/api/chat` 分流**：`currentEngineBackend()` 默认 `self`（自研，零回归）；
  `MYCLAUDE_ENGINE_BACKEND=upstream` 或 `POST /api/config {engineBackend}` 切到上游。
  `GET /api/config` 回传 `engineBackend`；upstream 分支也占 `running` 槽位防并发。
- **会话落盘**：上游回合的 user/assistant 文本写进 MyClaude session（`engine: "upstream"` 标记），
  可恢复、可导出；上游 sessionId 仍按 `--resume` 绑定，跨回合上下文连续。
- **真实端到端实测**（node 服务 + upstream 后端）：HTTP 200 / 15.3s，SSE 事件序列
  `session, reasoning, tool_start, tool_end, delta, assistant_end, done`，
  上游真实执行 `Read` 答出版本号，会话落盘 2 条消息。
- **测试 5 项**：翻译器纯函数（真实事件形态夹具）、未知事件忽略、失败工具结果、
  `/api/config` 切换、upstream 模式 `/api/chat` 全流程（假引擎，不依赖 bun/B: 映射）。
- 新增 `docs/REPLICATION-ROADMAP.md`：定义「完全复刻」可达终点（客户端 100%）、
  分阶段计划、每阶段验收标准、**物理不可达**的云侧/账号功能清单。

### Added（B 路线升级：原生引擎会话连续性 —— 从「每次新会话」到「共享上下文」）
- **上游原生支持 `--resume <session-id>`**，本轮实测确认：回合 1 让引擎记住 ZEBRA77，回合 2
  用同一个 session id 续接，不提词也能答出 ZEBRA77。
- **接线**：`src/engines/claude-code.js` 增 `engineSessionFor/rememberEngineSession/forgetEngineSession`，
  上游 sessionId 按 **MyClaude 会话键**存进 `~/.myclaude/engine-sessions.json`（或 `MYCLAUDE_HOME`）；
  GUI 命令桥与 TUI 的 `/engine` 都会自动带上已有绑定。`/engine reset` 可解绑。
- **失效自动降级**：上游会话文件被清理时引擎报 `No conversation found with session ID`（实测特征），
  桥会识别该特征并自动改开新回合，结果标注「原会话已失效，已开新会话」—— 不会把失效当成功。
- **端到端实测**（经 7788 服务，两轮）：回合 1 `resumed:false` → 回合 2 `resumed:true`，
  同一 session id `948b734c`，第二轮答出 ZEBRA77；会话表正确记录绑定。
- **测试 7 项**：`--resume` 真的进了子进程 argv（假引擎回显验证）、会话表持久化与隔离、
  失效降级、普通失败**不**误判为失效、真实事件流解析仍工作。全量 **623/623**。

### Added（A 路线扩展：运行时拿到「静态不可还原」的工具 schema）
- 上游工具对象的 `inputSchema` 是 **getter** —— 静态抽取器判为「不可静态还原」的那些，
  **运行时直接访问 getter 就能拿到**。新增 `claude-re-2.1.302/tools/spec3/16-extract-runtime-schemas.mjs`，
  内含 **zod v4 → JSON Schema** 转换器（按构造器名分发：ZodObject/ZodOptional/ZodEnum/ZodArray/ZodRecord…）。
- **本轮接入 2 个工具**（生成器的 DECISIONS 表新增）：
  - `Task` ← 上游内部名 `Agent`（模型可见名都是 Task）：10 个字段、required [description,prompt]
    与 MyClaude 现有 required 完全一致，MyClaude 消费的 4 个字段全部 ⊆ 上游字段集 → **纯 adopt**；
  - `AskUserQuestion`：4 个字段（questions/answers/annotations/metadata）。
    **兼容处理**：上游 schema 用 `multiSelect`（camelCase），MyClaude 两个 presenter 读 `multi_select`，
    在 run() 入口一次性归一，两边命名都到得了 presenter。
- 采用上游契约的工具从 9 个增至 **11 个**；上游工具条目 96（带 schema 87、带描述词 50）。

### Added（复刻度量脚本：数字全部现测，可复算）
- 新增 `scripts/parity-metrics.mjs`：上游侧数据从**运行时**取（bun 执行 `getBuiltinCommands()`），
  不再用手抄清单当分母。**同时报两个口径**（全量 133 / 本地相关 81），避免「分母自选」。
- 实测：命令面 TUI 28% / GUI 25%（全量口径），TUI 46% / GUI 38%（本地相关口径）；
  工具契约已接入 11 个；上游代码 2432 明文模块/45.4MB + 2429 字节码模块/92.2MB。
- **更正上一轮的错误结论**：我曾说 `/vim`、`/output-style`「上游已移除、不该复刻」——
  那是**从 recent-changes 文档推断**的，而运行时内置命令表里它们**都在**。backlog 的相关标注已更正。

### Investigated（上游完整权限引擎的可达性 —— 有明确结论）
- **结论**：`checkPermissions` 与上游**实时应用状态**深度耦合，进程内无法可靠调用；
  它只能通过 **B 路线**（运行上游自己的引擎）触达 —— 而 `/engine` 已经实现。
- **实测调用链**：`checkPermissions` → `Dhr` → `gje` → `le` → `e.getAppState()`，
  缺的是 `toolPermissionContext`（含 `permissionLayers` 层序与 `pollEventDeliveryGuard` 改写规则集）。
  用假上下文能跑通，但判定不等于上游真实行为 —— 拿不可信的判定替换已有逻辑比不改更糟。
- **B 路线实测验证**：上游引擎在 `--print --permission-mode default` 下，权限层真的拦下命令并给出理由：
  「blocked by the permission layer before it ran — PowerShell's static validator rejected `rm -rf`」；
  同一会话里无害命令正常执行。⇒ **MyClaude 的 `/engine` 继承上游完整权限语义**。
- 分层结论与证据见 `docs/upstream-permission-engine.md`。

### Added（代码层复刻 A 片段第二片：上游工具描述词逐字接入）
- **上游的工具级描述词**（区别于已接入的属性级）已提取并接入。描述词直接决定模型怎么选工具、
  传什么参数 —— 自研的一两句概括给不出上游文案里的可执行指引。
- **方法：运行时调用，不是静态推导。** 上游描述词是程序化构造的（Glob 是 `return cAo(void 0)`，
  `cAo` 内部还有 `cB()==="default"?ol:er` 分支），静态还原要复刻整套分支语义；
  **直接调上游自己的 `async description()`** 拿到的是运行时真实取值。
  新增 `claude-re-2.1.302/tools/spec3/15-extract-descriptions.mjs`（需 Bun）。
- **还原率**：96 个工具请求 → **50 个拿到**；**本地编码 agent 用到的核心工具 9/9 全拿到**
  （Read/Write/Edit/Glob/Grep/Bash/TodoWrite/NotebookEdit/WebFetch）。
  未拿到的 46 个多为云侧/插件/MCP 工具与参数化模板 —— 本机没有对应服务，
  原因已在 `docs/upstream-tool-descriptions.md` 逐条列明。
- **9 个工具的描述词现在逐字发给模型**，例：Grep 那 881 字符包含
  「ALWAYS use Grep for search tasks. NEVER invoke `grep` or `rg` as a Bash command」、
  「跨行匹配请用 `multiline: true`」；Glob 386 字符含「open ended search 请改用 Agent 工具」。
- **踩到的坑**：上游工具对象带 **getter 陷阱** —— 读 `.description` 会触发上游权限探针并抛
  `TelemetrySafeError`（上游在防工具对象被窥探），提取器必须逐属性 try/catch，否则整个脚本崩；
  常量可能是逗号分隔声明里的一项（`,_o="..."`）；工具对象常在某个 chunk 却由**桶文件**再导出，
  要反查「谁 import 了它」。
- 新增 `docs/upstream-tool-descriptions.md`（方法/还原率/未提取原因/复算命令）、
  `test/upstream-descriptions.test.js`（5 项）；全量 **616/616**、exe 已重打。

### Added（代码层复刻 A3：上游真实代码参与安全判定）
- **核心**：MyClaude 的 Bash 权限判定现在会**调用上游 Claude Code 的真实代码** —— 上游 Bash 工具对象
  （`chunk-e0x0xb6d.js` 导出的 `Li`）的 `isReadOnly(input, sessionEnvVarKeys)` 与
  `notReadOnlyReason(...)`。不再是纯自研正则近似。
- **为什么走进程内**：提取树是 `bun build --compile` 产物，模块间用 Bun 专有的
  `import.meta.require(...)` 同步加载 ESM，**Node 26 没有该 API**（实测 `typeof import.meta.require`
  在 Node 是 undefined、在 Bun 是 function）。所以：
  - **Bun 运行时（= 打好的 exe，产品实际运行环境）**：进程内直接 import，零额外进程；
  - **Node（开发模式）**：上游不可用 → 退回自研启发式，并如实标明，不假装上游可用。
- **踩过的坑（已放弃的方案）**：先做的是「常驻 sidecar + NDJSON」。但实测 stdio 管道句柄
  **无论怎么 unref 都吊住父进程**（三种 unref 组合各测 5 秒，进程均不退出）—— 会让测试与 CLI
  永远无法结束。sidecar 因此降级为**测试辅助**（测试自己 spawn/kill），生产路径不用子进程。
- **语义边界（重要）**：上游 `isReadOnly` 回答的是「有无副作用」，MyClaude 的 acceptEdits 回答的是
  「在这套模式语义下能否免询问执行」—— **两个不同的问题**。直接拿上游当闸会让 `npm test`、
  `echo hi > out.txt` 开始弹窗，那是行为回归不是行为对齐。所以默认：自研启发式决定放行与否，
  **上游判定用于给理由补上权威说法**（附上游原话与具体片段）；
  想要上游语义原样可设 `MYCLAUDE_UPSTREAM_STRICT=1`。
- **开关**：`MYCLAUDE_UPSTREAM_SAFETY=off` 关闭上游判定；`MYCLAUDE_UPSTREAM_STRICT=1` 启用严格模式。
- 新增 `src/agent/upstream-safety.js`、`scripts/upstream-safety-sidecar.mjs`（测试辅助）、
  `test/upstream-safety-parity.test.js`（7 项，含上游判定的真实断言）。
- 全量 **611/611**；exe 已重打并在 Bun 下验证上游桥可用。

### Added（代码层复刻 A 片段：上游工具契约逐字接入）
- **新增 `scripts/gen-upstream-schemas.mjs` + `src/tools/upstream-schemas.js`**：把上游 2.1.302 的
  工具 `input_schema`（含属性级描述词，AST 级抽取的 85/92）按**逐工具决策表**接入 MyClaude。
  唯一 choke point 是 `toolSchemas()` —— 工具送往 provider 的序列化点，一处换掉全部。
- **9 个工具采用/合并上游契约**：Read、Write、Edit、Glob、Grep、Bash、TodoWrite、NotebookEdit、WebFetch。
  属性名、描述词、required 全部逐字采用上游（例如 Glob.path 的描述词现在带着上游那句
  `DO NOT enter "undefined" or "null"`，MyClaude 自研版没有）。
- **保留自研契约并记明原因**：WebSearch / AskUserQuestion（上游 schema 是运行时分支 getter，
  静态不可还原）、ExitPlanMode（上游是 allowedPrompts，MyClaude 是 plan，契约不同）、
  LS / MultiEdit / BashOutput / KillShell / Git*（上游没有）。
- **run() 同步兼容上游命名**：Grep 收 `-A/-B/-C/-n/-i/-o` 与 `head_limit`（并**实现**了 `-o`
  只输出匹配片段，rg 路径用 --only-matching、JS 回退路径自己截匹配段）；Bash 收 `timeout`
  与 `dangerouslyDisableSandbox`；Read 收 `allow_large`（放宽体积上限到 25MB）；
  WebFetch 收 `prompt`/`offset`。MyClaude 旧命名全部保留，两套并行可用。
- **还原出一个被漏掉的真实上游参数**：`Read.allow_large` —— 抽取器把它记成计算键 `[computed:[Rge]]`，
  生成器从 `x-raw` 还原出真实键名与布尔类型。
- **测试 8 项**：逐字一致性、描述词确实到达模型、保留自研契约的工具未被误改、别名已声明、
  Grep/Bash/Read 的上游命名实跑。全量 **604/604**；`verify-features` ✓、`inspect:prompt` 0 error、
  生成器 `--check` 幂等、smoke 46 命令 0 崩溃、exe 已重打。
- **未覆盖（如实标注）**：上游**工具级长描述**仍在 `async description(){return cAo(void 0)}` 之后，
  需按 inputSchema 同款手法解构造链（已定位 `cAo` 在 chunk-y41y4f2h.js，模板字面量 + 条件分支），
  属下一片；本片只对齐了参数面。

### Added（代码层复刻 B 路线落地：原生 Claude Code 引擎并入）
- **新增 `src/engines/claude-code.js`**：把 claude-re-2.1.302 提取的 2433 模块明文树当作
  「另一个 agent 内核」驱动 —— spawn `bun B:/~BUN/root/cli` 子进程、prompt 走 stdin
  （argv 会被 shell 拆错，实测结论）、解析 stream-json 事件流（system/init、assistant、
  result 三类）、180s 兜底超时（引擎遇上游 5xx 会无限重试，必须外层杀）。
  它不是 provider：provider 是单轮 LLM 调用，这是一个完整 agent 循环（自带工具/会话/权限），
  所以接入点是命令桥而非 providers/。
- **三面接入 `/engine`**：`/api/command` 桥（gui-server，配 config.baseUrl/apiKey/model）、
  GUI 斜杠命令 + 菜单项（输入区直接 `/engine <提示>`）、TUI 同名命令。
  环境探测：`MYCLAUDE_ENGINE_BUN` / `MYCLAUDE_ENGINE_CLI` 可覆盖，默认 `~/.bun/bin/bun.exe`
  + `B:/~BUN/root/cli`（subst 映射）；缺任一则报「引擎不可用」并指向复现文档，不误报为程序错误。
- **实测（通过 7788 服务）**：`/engine` 回合真实执行 —— 引擎自调 `Read` 工具读 package.json，
  答「This project is called myclaude version 0.19.0.」、2 回合、自有 session id 回传、HTTP 14.8s。
- **测试 8 项**：真实事件流夹具解析（今天实际捕获）、假引擎全链路（不依赖 B: 盘）、
  超时击杀、空 prompt 拒绝、env 修正、三面注册、真引擎 e2e（缺 B:/bun/网关自动跳过）。
- 全量 **596/596**；期间 11 个 git 工具测试失败，查明为 PATH 环境问题（git 实际在
  `F:\Tools\Git\cmd`，被陈旧条目挡住），修正 PATH 后全绿 —— 环境事实已记入 HANDOFF §9。

### Verified（收尾总体检：五道闸门 + 端到端实测全绿）
- `npm test` **588/588**、`verify-features` ✓、`inspect:prompt` **0 error**、
  `npm run test:smoke` **46 命令 0 崩溃**、exe 比所有源文件新、工作树 0 未提交。
- **端到端实测**：浏览器里发「只回答一个数字：2 加 3 等于几？」→ 回复 **「5」**，
  无错误提示、0 JS 异常、busy 正常释放 —— 重写后的 13,147 字符提示词、token 估算、
  provider、SSE 流转、界面渲染整条链路确认可用。
- `docs/HANDOFF.md` 补齐「五道验证闸门」与「这一系列改动留下的设计决定」两节，
  状态表数字同步为实测值。

### Fixed（中文 token 被低估约 3.4 倍）
- **发现方式**：UI 巡检截图里，提示词库卡片显示「144 字 · ~36 tok」。144 个汉字约 120-150
  token —— 36 明显是 `chars / 4`（英文经验值）直接套在中文上。
- **实测**：`agent.js` 的 `estimateTokens` **本来就有 CJK 分支**（`cjk + rest/4`），
  但 `gui-server.js` 的 `approxTokens` 注释写着「matches Agent.maybeCompact」却用裸 `chars/4`，
  前端 6 处（提示词库卡片、系统指令计量、项目文件 token）也都是 `chars/4` ——
  同一段中文在三处给出三个数，且都比真实值低 3-4 倍。
- **新增 `src/tokens.js`**：`estimateTextTokens()` 统一口径 —— 中日韩文字与全角标点
  按 ~1 字符 1 token，其余 4 字符 1 token。三处全部接入；前端保留一份同公式副本
  （浏览器端无法 import 服务端模块），并有测试断言两处公式一致、且三个文件里
  **不再有任何 `Math.ceil(x.length / 4)`**。
- 顺带清掉 `totalChars`（只累加、从不读出，是死变量），项目容量改为直接累加 token。
- **实测**：提示词库卡片 144 字 **~36 tok → ~123 tok**；`/api/project` 200 且字段完整；
  估算器单测：中文 114 tok（旧算法 29）、英文 18 tok 保持合理。
- 新增 `test/token-estimate.test.js`（6 项）；全量 **588/588**、smoke 46 命令 0 崩溃、exe 已重打。

### Noted（UI 巡检：未见新缺陷）
- 逐个打开提示词库/Projects、设置、快捷键、命令面板、右栏各段：均正常渲染，0 JS 异常。
  提示词库与 Projects 共用同一个模态框（两个入口进同一处），视觉令牌与全站一致
  （卡片 `--panel` / 横幅 `--panel-2` / 细线 `--line`），因此 backlog 里「旧视觉语言」
  一条未动手改 —— 主观判断缺可验收标准，先记录观察。

### Fixed（会话文件消失时甩给用户一条红色 HTTP 404）
- **发现方式**：在真浏览器里看右栏时，页面顶部有一条红色「恢复会话失败：HTTP 404」。
  起因是我清理了上一轮造的合成会话 —— 但前端记住了上次会话 id，启动自动恢复必然 404。
- **根因**：`resumeSession` 的 `.catch` 不区分「静默恢复」与「用户显式点击」，
  两者都走 `addNotice(..., "err")`，于是把内部状态码原样甩给用户。
- **修复**：静默恢复遇到 404 时**清掉记住的 id 并安静开新对话**（那对用户只是「没有上次」，
  不是错误）；用户显式点击时改为 info 级「该会话已不存在，已开始新对话」；
  其它失败（网络、文件损坏）仍然出声，静默场景写明「上次的会话没能恢复」。
- **真浏览器实测**（伪造一个不存在的会话 id 后重载）：红色提示 0 条、页面无 `HTTP 404` 字样、
  过期 id 已清除、正常显示新对话欢迎页、0 JS 异常。
- 新增 `test/session-restore.test.js`（3 项）；全量 **582/582**、smoke 46 命令 0 崩溃、exe 已重打。

### Verified（备用模型空池禁用态：已符合预期，未改动）
- 实测空池状态：`一键测活` 为 disabled 且 title 说明「暂无备用模型，请先点「+ 添加」……」、
  `+ 添加` 可用、空态文案完整、0 异常。该条目此前已由其他会话处理完毕，本次仅核实未改动。

### Fixed（长会话的消息目录只列出一小截）
- **现象**：会话恢复时只渐进渲染最后 `REPLAY_CHUNK`(60) 条，而消息目录是按**已渲染的
  DOM 节点**取列表 —— 于是 150 个提问的会话，目录里只有 30 条，早期的提问根本跳不过去。
- **修复**：目录改按 `S._replayMsgs` 的**数据**构建（实时会话仍回退到 DOM 路径）；
  回放时为每个 user 节点打 `data-src-idx` 作为映射钥匙；未渲染的条目加 `is-unloaded`
  变暗并以「尚未加载，点击后加载」提示；点击时按 `REPLAY_BATCH` 分批补齐再滚动。
- **补齐过程不让出主线程就会重演卡死**（几百条同步渲染曾卡 20-30 秒），所以
  `loadUntilRendered` 每批之间 `setTimeout(16)` 让出，并用 `tries>40` 兜底防死循环。
- **滚动必须显式计算**：补加载时 `loadEarlierReplay` 刚调整过 `scrollTop` 以保持视图不跳，
  `scrollIntoView({smooth})` 会和它打架 —— 真浏览器实测落不到目标位置（`in_viewport=false`）。
  改为按几何位置算 `stream.scrollTop += nodeTop - streamTop - 80`。
- **真浏览器实测**（150 问 / 300 条合成会话，无头 CDP）：目录 **30 → 150 条**、
  未加载标记 120 条、点击后全部加载且落点 `top=86px` 在视口内、0 JS 异常。
- 新增 `test/toc-completeness.test.js`（5 项）；全量 **579/579**、smoke 46 命令 0 崩溃、exe 已重打。

### Added（交接文档 + 命令面校正）
- 新增 **`docs/HANDOFF.md`**：状态表（带核实命令）、已完成提交、真正剩余、8 条踩坑约束、
  逆向产物位置、接手时先跑的三条命令。目标的本质是「中断可续」，这份文档就是为此而写。
- **校正过期记录**：backlog 原称 `/fork /branch /init` 仍缺，实测**均已实现**。
  逐条核对 `src/main.js` 的 case 与 `app.js` 的 handlers 后确认：真正缺的只有 `/statusline`；
  `/vim` 上游已移除、`/sandbox` 本项目有意用命令分级替代。
- 补 `/todo` 别名：TUI 落到 `/todos` 分支（case fallthrough），GUI 委托 `EXTRA_COMMANDS.todos()`；
  并加入 smoke 探测列表 —— 真实 exe 上 46 条命令 **0 崩溃**（`/exit` 无输出属预期）。
- 新增 `test/command-alias.test.js`（2 项）；全量 **574/574**、exe 已重打。

### Changed（自主模式段扩为「循环工作」口径）
- 依据产物 `02-modules/files/loopAutonomousPreamble-5hfhrxrk.md`（4,995 字符）与
  `loopAutonomousPreamblePersistent-2y5ccy21.md`（5,403 字符，定时循环自主工作），
  把 `AUTONOMY_SECTION` 从 1,398 扩到 **3,161 字符**，新增三节：
  - **## What to act on**：按信号强弱排序找「已在推进的事」——上次没做完的实现、
    对话里承诺过却没兑现的（"I'll also..."）、被跳过的验证步骤、提过但没处理的边界情况、
    现在能回答的问题；**跟任务的意图走而不只是字面范围**；不发明新工作；
    「当你在为某个动作编『大概没问题』的理由时，那就是该等的信号」。
  - **## How far to go**：读、分析、探索没有影响半径；**可逆动作（改文件、跑测试、写草稿）
    偏向行动** —— 多余的一次本地编辑几乎零成本，而任务停滞会毁掉自主运行的意义；
    不可逆动作（删除、强推、发布、代发消息）需对话中的明确授权，或先找同一步的可逆形式；
    **「做事，不要描述它能被做」——跑测试，而不是说可以跑测试**。
  - **## When there is nothing to do**：一句话说明然后停；不列「我检查了什么」清单；
    连续多轮无事可做时，保持下次检查最小且安静，不要叙述搜索过程。
- 选 persistent 变体的口径（可逆偏向行动）而非更保守的第一版，因为它与本项目
  `autoRun` / 长目标续跑的实际用法相符。
- 断言新增 8 条；`inspect:prompt` 两种模式 0 error（autoRun 提示词 21,773 字符，预算内）；
  全量 **572/572**、exe 已重打并确认新节已编入。

### Added（verify 技能补齐「表面 playbook」）
- 上轮移植 verify 时被迫删掉了上游的 `examples/` 链接；本轮从产物
  `02-modules/files/` 里找回原文（`cli-c9q7tcbv.md`、`server-nk452php.md` 等），
  改写为与本项目表面一致、可执行的 playbook，正文 8,593 → **10,412 字符**。
- 五类表面各自的 handle 与证据口径：
  **CLI**（直接调用，证据是 stdout/stderr/**退出码**；`unknown flag` 多为陈旧构建、
  无输出说明没进分支、无 flag 路径变化是回归）；
  **HTTP**（后台启动 + 轮询就绪而不是猜时间；抓 **status + headers + body**，
  只看 body 会漏掉状态码与响应头；全 200 说明没进改动分支，不能判 PASS）；
  **GUI**（headless 驱动 + 截图 + 读 console，界面正常但交互抛错是常见组合）；
  **TUI**（需要 pty，普通管道会让正常的 app 看起来坏了；显式设窗口尺寸，
  **先轮询就绪标记再抓屏**，固定 sleep 要么浪费时间要么截到半渲染）；
  **库**（import 包边界而非内部模块，后者是你自己写的单元测试）。
- 上游的语言相关示例（Go build、jq 等）按本项目栈改写，未照搬。
- `test/builtin-skills.test.js` 增加 5 条 playbook 断言；全量 **572/572**、
  `inspect:prompt` 0 error、exe 已重打并确认 playbook 已编入二进制。

### Added（系统提示词体检脚本，让这类问题自动暴露）
- 新增 `scripts/inspect-prompt.mjs` + `npm run inspect:prompt`：**不看源码，只看真实
  组装出来的提示词**。上一轮的重复内存 BUG 活了很久，正是因为没有任何检查去看
  组装结果 —— 读源码加断言只能证明「写了什么」，看输出才能证明「系统在做什么」。
- 七类检查：项目内存重复（按小写路径比对，抓大小写不敏感文件系统的同文件两次加载）、
  段落重复、必需段落缺失（System/Doing tasks/Executing actions/Using your tools/Tone/Environment）、
  自主段与 `autoRun` 一致性（缺失或泄漏）、技能段与技能数一致性、空段、体量超预算。
  支持 `--json` 与 `--dump <file>`；有 error 时退出码 1，可直接进 CI。
- 首次运行即发现**我自己的一个误报**：`# From <path>` 是内存分隔符而非段标题，
  其正文以内存文件自身的 `# myclaude` 开头，被误判成空段 —— 已从两项检查中排除。
- 新增 `test/prompt-health.test.js`（5 项）：真实提示词零 error；内存只出现一次；
  **并用人造坏提示词反证体检本身有效**（重复内存 / 缺段 / 自主段泄漏都必须被抓到）——
  一个永远通过的检查等于没有检查。
- 全量 **572/572**、`npm run inspect:prompt` 两种模式均 0 error。

### Fixed（项目内存被加载两次，每轮请求白多 4KB）
- **发现方式**：转储真实组装的系统提示词（而非读源码）时看到 `# From ...\MYCLAUDE.md`
  与 `# From ...\myclaude.md` 两段内容完全相同 —— 磁盘上只有一个文件。
- **根因**：`loadMemory` 的候选文件名是 `["MYCLAUDE.md", "myclaude.md"]`，去重用的
  是**字面路径字符串**。Windows 与 macOS 默认大小写不敏感，两个候选名是同一个文件，
  于是同一份项目内存被读两遍：提示词白多约 4KB，规则也重复出现两次。
- **修复**：去重键改为 `realpathSync()` 解析后的真实路径，大小写不敏感平台再转小写
  （`memoryKey()`）。向上查找祖先目录、写入路径选择等行为不变。
- **实测**：系统提示词 **22,682 → 18,610 字符（-18%）**，`# From` 段落数 1；
  autoRun 模式下 24,082 → 20,010 字符。
- 新增 `test/memory-dedup.test.js`（3 项：只加载一次 / 仍能向上找到 git 根 / 无文件返回 null）。
  全量 **567/567**、exe 已重打。

### Fixed（源码被并发进程覆盖后的完整恢复）
- **事故**：01:34:10 有一并发进程同时改写了 `src/agent/agent.js`、`src/skills.js`、
  `test/skills.test.js`、`src/main.js`，把多轮成果回退成旧版本。表现为 13 个测试突然失败，
  以及 `node scripts/build-exe.mjs` 报 `No matching export in providers/openai.js for
  import "createProvider"`（`main.js` 被回退到工厂迁移之前的导入路径）。
- **丢失并已恢复**：
  - `agent.js`：空正文守卫（`_emptyBodyRetries`）、`lastReasoningParagraph`/`summarizeTurn`、
    `ensureFinalAnswer()` 独立 AbortController + 30s + 重试、`run()`/`runLoop()` 拆分、
    自主模式段注入；
  - `skills.js`：内置技能铺底 + `opts.builtin` 开关，以及**正确的 `skillDirs`**；
  - `test/skills.test.js`：`MYCLAUDE_HOME` 隔离（必须动态 import，静态 import 会被提升到
    赋值之前，隔离失效）+ `{ builtin: false }`；
  - `main.js`：`createProvider` 导回 `providers/index.js`。
- **恢复过程中发现并修掉一个真 BUG**：回退版 `skillDirs` 会**逐级向上爬 6 层父目录**找
  `.myclaude/skills`，于是从 Temp 之类目录出发时，用户家目录的 `~/.myclaude/skills`
  被误判成 project 技能 —— 同一个技能被加载两次、作用域错误。改为「只认项目根一处」
  （git 根，非仓库则退回 cwd）。
- **已固化提交**：b0f108a - 按 Claude Code 2.1.302 逆向产物对齐提示词、技能与权限模式
  （未推送，未包含 2.8GB apk 与 exe）。工作树此后可安全 git checkout 回退。
  遗留观察：仓库根目录有另一进程在 01:34:10 写下的 _p*.txt / _rea_probe*.txt 探测草稿
  （内容为对 claude-src 模块的逆向取样），均为未跟踪文件，未纳入提交，也未删除。
- **原暂存但未提交的风险已解除**：此前九轮改动只在工作树，覆盖后只能靠测试契约重建。
  内容已进 `.git/objects`，工作树再被覆盖可用 `git checkout -- <path>` 取回。
- 验证：全量 **564/564**、`npm run test:smoke` 45 命令 0 崩溃、exe 重打（01:45:25，650 模块）、
  `_emptyBodyRetries`/`_finalizeUsed` 已确认编入二进制。

### Fixed（一个写了却从不执行的测试）
- `test/smoke-commands.smoke.js` 是 `scripts/smoke-commands.mjs` 的 `node:test` 包装
  （注释自述「exe 未构建就 skip，保证纯源码检出也是绿的」），但 `npm test` 的 glob 是
  `test/*.test.js`，**匹配不到 `*.smoke.js`** —— 这个针对构建产物的检查因此从未被任何
  入口执行过。新增 `npm run test:smoke`（`node --test test/smoke-commands.smoke.js`）。
- 与主套件分开是刻意的：它需要已构建的 exe，属于**产物闸门**而非源码测试；
  实测 2 项通过、耗时 13.7s；探测 45 条斜杠命令、0 崩溃（`/exit` 无输出属预期，
  脚本已专门过滤它）。
- 顺带清理根目录 14 个历轮遗留的临时文件（全部未跟踪、`_` 前缀草稿，释放 1.09 MB）。

### Verified（六轮成果一致性审计）
- exe（01:31:42）比所有源文件都新，无陈旧产物。
- 全量 **564/564** 通过、`verify-features` ✓、`npm run test:smoke` ✓。
- 提示词 13,147 字符 / 8 段；自主段 1,398 字符按 `autoRun` 条件注入；
  内置 verify 技能 8,593 字符；Shift+Tab 轮转顺序与上游逐字一致。

### Added（Shift+Tab 权限模式轮转，对齐上游顺序）
- 依据 `07-assets/docs/recent-changes-j2j9vm5c.md`「Commonly misremembered behavior」：
  上游轮转顺序为 `default -> acceptEdits -> plan -> bypassPermissions -> auto -> default`，
  `bypassPermissions` / `auto` 仅在可用时出现，**`dontAsk` 永不进环**。
- `src/agent/modes.js` 新增 `MODE_CYCLE` 与 `nextMode()`（单一来源）；本项目 `ask` 即上游 `default`。
  两个模式刻意排除在环外：`dontAsk`（上游明确排除）、`fullAccess`（本项目逃生门，
  必须刻意指定，不能被误触的 Tab 切到）。
- GUI 新增 `cyclePermissionMode()` + **Shift+Tab** 绑定（document 级，焦点在输入框中也生效），
  经 `/api/config` 持久化并调用 `agent.setMode`。
- 首次绑定误落在 composer 的 keydown 处理器里（导致页面主体按 Shift+Tab 无反应），
  真浏览器验证时发现并移到 document 级。
- 新增 `test/mode-cycle.test.js`（5 项，含**GUI 环与 modes.js 一致性断言**，防两处定义漂移）。
  真浏览器实测：`fullAccess`（不在环上）→ Shift+Tab → `ask → acceptEdits → plan →
  bypassPermissions → auto`，0 JS 异常。全量 **564/564**、exe 已重打。

### Noted（仅有信息价值，无代码动作）
- `03-features/module-architecture.md`：2,433 节点 / 22,940 边的依赖图，最大枢纽
  `chunk-e0x0xb6d`（入度 411 / 出度 350，系统提示词组装器所在），979 个零入度模块。
  对只有 ~30 个源文件的 MyClaude 无可直接落地动作，仅作架构参考。
- **`/vim` 在 2.1.302 已被移除**（改为 `/config` → Editor mode），故不实现；
  `/output-style` 同样已被移除（保留 MyClaude 现有实现，仅记录差异）。

### Added（Anthropic prompt caching —— 补上此前标注的缺口）
- 依据 `07-assets/docs/prompt-caching-485cdf9d.md`（33,539 字符官方设计文档）实现
  `src/providers/anthropic.js` 的 `withCacheBreakpoints()`：
  **唯一不变量是「缓存 = 前缀匹配」** —— 前缀任意字节变化会作废其后所有断点；
  渲染顺序固定 `tools -> system -> messages`，因此 **最后一个 system 块打点即同时缓存
  tools + system**，无需单独标注 tools；再在**最后一条消息的最后一个内容块**打点，
  后续请求复用整段前缀、命中随对话增长累积。共用 **2 个断点**（API 上限 4）。
- `config.promptCaching === false` 可整体关闭；断点只作用于每次请求新建的块对象，
  **不会污染 agent 历史**（有测试断言调用后原消息字节不变）。
- 已知边界（文档明载）：最小可缓存前缀因模型而异（512~4096 tokens），不足时服务端
  **静默不缓存且不报错**；缓存按 workspace 隔离；读取约 0.1× 输入价、写入 1.25×（5m TTL）/2×（1h）。
- 新增 `test/anthropic-prompt-caching.test.js`（5 项）；`anthropic-provider-e2e` 的 system
  断言改为块数组形态并新增断点断言。全量 **559/559**、exe 已重打。

### Changed（委派纪律升级 + 自主模式提示段）
- **委派纪律换为上游 gated 段原文**（`04-prompts/raw/subagent_steer_delegation.txt`，1,440 字符）：
  先算清子代理开销再决定委派、小事自己做、不为一件小任务扇出、
  **不派子代理去复查自己能在主循环验证的东西**、委派后不得重复它的工作、
  少而精地派（一次briefing到位）。替代上一轮较宽松的版本。
- **新增 `AUTONOMY_SECTION`**（`04-prompts/raw/autonomy_append.txt`，1,398 字符），
  对应上游 autonomy_append gated 段，**仅在 `config.autoRun` 开启时注入**
  （`buildSystemPrompt` 条件 push，与上游按模式 gating 一致）：
  自主模式下不要问「要我做吗」、可逆动作直接做、只为止损/范围变更停下、
  描述问题/提问时交付评估而非改动、**回合结束前检查最后一段**（若为计划/分析/
  问题/下一步/未兑现承诺，立刻用工具做掉）、不因上下文长而停、
  改系统状态前先确认证据支持该动作。
- 主提示词 12,310 → **13,147 字符**；自主模式开启时实际注入 23,867 字符（关闭时 22,467）。
- `test/system-prompt-parity.test.js` 增至 10 项（含 autoRun 开/关的注入断言）；
  全量 **554/554**、exe 已重打并确认新段已编入。

### Added（内置 verify 技能，来自 Claude Code 2.1.302）
- 新增 `src/skills-builtin.js`：随包发布的内置技能，用 JS 模块承载正文（单文件 exe 内
  没有可读的 `skills/` 目录，只能编译进包）。
- 移植上游 `verify` 技能（`07-assets/docs/SKILL-cf37e4b8.md`，12,146 字符 → 本地化 8,593 字符）：
  **验证是运行时观察**，跑测试/类型检查不算证据；不许 import-and-call 冒充验证；
  先定 diff 范围、再定表面（CLI/HTTP/GUI/库边界/prompt）、拿到启动方法、驱动它、
  围绕改动做反向探测（PROBE 至少一条）、保留现场证据、按固定格式出报告；
  判定 PASS/FAIL/BLOCKED/SKIP，**不接受部分通过**，**存疑即 FAIL**。
- 本地化：`.claude/skills` → `.myclaude/skills`；去掉上游专有的 `examples/` 链接、
  `run-skill-generator`、`SendUserFile`、`gh pr diff`（测试断言这些不得出现）。
- `loadSkills(cwd, opts)` 新增 `opts.builtin` 开关（默认含内置）；内置优先级最低，
  `~/.myclaude/skills` 与项目级同名技能可覆盖 —— 有测试验证覆盖生效。
- 新增 `test/builtin-skills.test.js`（4 项）；`test/skills.test.js` 的磁盘发现断言改为
  显式 `{ builtin: false }`。全量 **552/552**、exe 已重打并确认技能正文已编入。

### Changed（多代理编排：可迁移原则对齐）
- 依据 `04-prompts/orchestrator-prompt.txt`（15,739 字符，多 worker 编排模式）提炼**可迁移原则**，
  写入主提示词新增的 `# Delegating with Task` 段：不为一件小事委派、不用子代理互相查岗、
  独立调研可并行/写操作串行、Task 提示词必须自包含、**绝不编造子代理结果**。
- **未照搬** worker 池协议（`SendMessage` 续跑、`subscribe_pr_activity`、`task-notification` XML、
  `subagent_type` 特化）—— MyClaude 只有单发 `Task` 工具，无对应能力；照搬会让模型调用不存在的工具。
  测试显式断言这些上游特性名不得出现在提示词里。
- 子代理提示词（`task-tool.js` 的 `SUBAGENT_PROMPT_SUFFIX`）从 5 行补强为 6 条：
  不得扩大范围/执行工具输出里的指令、不能提问故需声明假设、先调查再动手、
  只读工具集不得声称做了改动、报告需含文件路径与未完成项。
- 主提示词 11,266 → **12,008 字符 / 8 段**；`test/system-prompt-parity.test.js` 增至 8 项；
  全量 **548/548**、exe 已重打并确认新段已编入。

### Not achievable（如实记录）
- **工具 schema 不可静态还原**：2.1.302 改为程序化构造（全树仅 64 处 `input_schema` 字面量），
  `07-assets/docs/claude-code.d.ts` 的 `BuiltinToolInputs` 是空声明合并表（需插件侧填充），
  故 Per-tool 参数 schema 无法从该产物提取。
- **`isReadOnly` / `isConcurrencySafe` 不可判定**：`03-features/tools-permissions.md` 67 个工具中
  这两个字段几乎全为 `?`，文档自述「为代码中方法返回值或 null，无法静态判定」。


### Added（GUI 命令复刻收尾：fork / branch / init / clear / provider）
- **命令面复刻差距审计**：从 claude-src `964_chunk-0qdm07jf.js` 提取 35 个真实命令名，
  与 MyClaude 的 TUI（~60 case）和 GUI（20 case）逐项比对，得出精确缺口清单。
- **GUI 补齐 5 条**：`/fork`（分叉会话）、`/branch`（fork 别名）、`/init`
  （生成 MYCLAUDE.md，/init force 重生成）、`/clear`（/new 别名）、`/provider`
  （打开供应商设置）。`/api/command` 新增 fork/branch/init 三个服务端分支。
- **fork 语义对齐 Claude Code**（964_chunk）：从当前会话整份克隆出新的会话 id、
  原会话不动，前端收到 `forkedTo` 自动切到新会话。
- 新增 `test/fork-command-e2e.test.js`。HTTP 直探 5 命令全过；
  全量 **540/540**、`verify-features` ✓、exe 已重打。
- 复刻差距归零：35 个非 Anthropic 专属命令中，TUI 缺 5 个（plugins/statusline/
  sandbox/vim/todo）、GUI 缺 0 个（除 anthropic 生态专属与需要 Claude Code 客户端
  本体的 IDE/login/bug 等）。


### Added（底层接 Anthropic：Messages API 传输层）
- **`src/providers/anthropic.js`**：Anthropic Messages API 适配器，继承 `OpenAIProvider`
  复用传输层（独占连接 / TTFB 超时 / abort 语义 / 流空闲看门狗），只替换线协议：
  `x-api-key` + `anthropic-version` 认证、`system` 顶层字段、`input_schema` 工具、
  `tool_use`/`tool_result` 内容块、thinking 块走 reasoning 通道、
  `stop_reason` 映射（tool_use→tool_calls / max_tokens→length）、usage 映射。
- **消息转换**（`toAnthropicMessages`）：system 提升为顶层字段；assistant 的
  `tool_calls` 转成 `tool_use` 内容块；连续 `role:"tool"` 合并为一条 user 的
  `tool_result`；连续 user 合并（Anthropic 要求交替）；多模态 `image_url` data:URL
  转 base64 image source；空 assistant 内容不再产出空 text 块。
- **effort 接 thinking**：`/effort high|medium|low` 映射为 `thinking.budget_tokens`
  （8000/4000/2000，且开启时强制 temperature=1，符合 Anthropic 约束）。
- **工厂移到 `providers/index.js`**：AnthropicProvider 在求值期就要 extends
  OpenAIProvider，工厂留在 openai.js 会形成模块级循环 import；main.js /
  gui-server.js / router.js 的 import 同步改到 index.js。
- **`/api/config` 新增 `provider` 字段**：此前 POST 从不写 `config.provider`，
  设置中心选「Anthropic 官方」只改了 baseUrl/model/key，传输层仍走 OpenAI 协议，
  请求必失败（选了也白选）。现在白名单切换线协议并同步活跃 agent 的 router。
- **GUI**：选「Anthropic 官方」卡片保存时带上 `provider: "anthropic"`。
- 新增 `test/anthropic-provider.test.js`（4 项：分发 / 消息与工具转换 / 多模态）
  与 `test/anthropic-provider-e2e.test.js`（本地 mock Anthropic SSE 服务器真跑一轮：
  请求体形状、thinking→reasoning 通道、tool_use 还原为真实工具调用、usage 统计）。
  全量 **539/539**、`verify-features` ✓、exe 已重打。
- **限制**：本机无 `ANTHROPIC_API_KEY`，以上验证均针对本地 mock 的 Anthropic 线协议；
  真实 api.anthropic.com 调用需要用户填入 sk-ant 密钥后实测。


### Added（任务执行中的实时读数：耗时 + token）
- **工具聚合条（「正在执行 N 项工具操作…」）右侧**新增 `.tool-group-live` 徽标，
  显示 `M:SS · 4.2k tok`；执行中每秒更新，回合结束后**定格**为该轮执行记录。
  徽标悬停显示精确数值（累计 / 输入 / 输出 tokens）。
- 服务端 `/api/chat` 新增 `type: "progress"` SSE 事件，每秒推送 `elapsedMs` +
  `totalInputTokens`/`totalOutputTokens`/turns/messages；原先 `stats` 只在回合末尾发一次，
  过程中拿不到数据。前端 `progress` 分支更新 `S.stats` 并刷新徽标，
  客户端 `setBusy` 的 1s 自转作为断流兜底。思考条计时器同步显示同一读数。
- 顺带修 **定时器泄漏**：`flushTimer`（2.5s）原为 try 块内 `const`，
  `finally` 里 `typeof flushTimer !== "undefined"` 恒为假，每回合泄漏一个 interval。
  两个定时器改为 try 之前声明、finally 显式 `clearInterval`。
- 状态类名用 `is-running` 避开已有 `.live` 星标规则；装饰细线限定在弹窗工具清单，
  否则其 `flex:1` 会把徽标和 chevron 挤到中间。
- 新增 `test/task-live-stat.test.js`（3 项静态接线）+ `test/task-live-stat-e2e.test.js`
  （真实 `/api/chat` 慢后端跑一轮，断言 SSE 流收到 `progress` 且回合正常完成）。
  全量 **534/534**、`verify-features` ✓、真浏览器实测徽标右对齐（距边 12px）、
  mono/tabular-nums、脉冲点、0 异常；exe 已重打。


### Fixed（结论缺失复发：空正文 + 收尾请求被 abort）
- **现场**：长会话压缩后模型连续两轮只发工具调用，第三轮返回空正文（`content: ""`），
  界面出现「结语生成失败：stream interrupted: aborted」+「（本轮工具已执行完毕……再发一句
  即可让它补上。）」。落盘会话 `2026-11-03T16-59-42_4ec450.json` 尾部复现。
- **根因 1（主循环）**：`runLoop` 的 `!toolCalls.length` 分支无条件
  `push(stripReasoning(text))` 并 `return done`。推理模型只吐 `reasoning_content`、
  `content` 为空时，空字符串被当成「回答完成」，留下空气泡。第 1 轮的 `ensureFinalAnswer()`
  只是事后补丁，没堵住这里。
- **根因 2（补丁自身）**：旧兜底复用 `this.abortController`（浏览器刷新触发
  `res.on("close")` → `agent.abort()` 会误伤它），且自带 15s 定时器把自己 abort；
  `openai.js` 把 caller abort 转成 `Error("aborted")` → 即截图里的报错。兜底还只认
  `result.text`，忽略 `reasoning`，失败时输出「再发一句」把问题推回给用户。
- **修复（三层）**：
  1. 主循环拒绝空正文：先有界催 2 次让模型写正文，再用 `reasoning` 尾段兜底，
     全程不 push 空 assistant 消息污染历史；
  2. `ensureFinalAnswer()` 改用局部 `AbortController`、超时 15s → 30s、失败重试一次
     （第二次只带系统提示 + 收尾指令，去掉长历史），并接受 `result.reasoning` 尾段；
  3. 彻底失败时用 `summarizeTurn()` 生成**确定性工具执行摘要**（工具数 + 最后一步输出节选），
     删除「再发一句」占位文案，警告改为「已用工具执行摘要代替」。
- 新增 4 项回归测试（含源码级断言：占位文案/15s 自 abort 不再存在），
  `test/final-answer.test.js` 共 7 项。全量 **530/530**、`verify-features` ✓、
  真浏览器 0 异常、exe 已重打。


### Changed（迭代第 6 轮：输入框快捷 chips 收尾）
- `.welcome-cats` 间距 8 → 6px；`.welcome-cat-btn` 圆角 10 → 8px、
  边框由 `--line-strong` 改 `--line` 细线、高度 34 → 32px、字号 13 → 12.5px；
  选中态阴影改主题感知的 `--card-shadow`。与追问卡 / 画布 / 设置中心同套语言。
- `test/iteration-round4.test.js` 补 1 项断言（注意 2279 行另有 media 覆盖规则，
  测试切片需从 `.welcome-cats` 之后开始找主规则）。
- 收尾验证：全量 **526/526**、`verify-features` ✓、真浏览器实测 chips
  `8px / 32px / gap 6px`、4 个右栏页签逐一切换正确、0 异常。


### Fixed（迭代第 4 轮：设置中心布局 BUG + 视觉语言统一）
- **设置中心供应商网格第三列被裁掉**（真 BUG）：`.cfg-provider-grid` 用裸
  `repeat(3, 1fr)`，grid 项默认 `min-width:auto`，长供应商名把第三列撑宽。
  实测 grid 728px / scrollWidth 927px（溢出 199px），卡片宽 296/278/333 不等，
  「Google Gemini」等被容器裁掉。修为 `minmax(0, 1fr)` + 卡片 `min-width:0`；
  实测溢出归零、9 张卡片全部 236px 等宽。名字省略时补 `title` 悬停全称。
- 同类隐患预防：`.welcome-suggestions` 与 640px 断点也改用 `minmax(0, 1fr)`；
  新增 420px 断点的单列回退。
- **设置中心统一到编辑式视觉语言**：`.cfg-pane-title` 加延伸细线；
  `.cfg-form-card` / `.welcome-sug-card` 改 8px 圆角 + `--card-shadow`
  主题感知分层阴影（原来写死的 rgba 在深色下失效）；行分隔由虚线改实线细线；
  `.modal-card` 圆角 18px → 12px。欢迎卡间距 12 → 10px。
- 新增 `test/iteration-round4.test.js`（3 项）。真浏览器浅色/深色双主题实测：
  溢出 0、等宽 236px、阴影随主题翻转、0 异常。全量 **525/525**。


### Added（迭代第 3 轮：GUI 命令第二批 + 代码质量）
- **通用命令桥**：新增 `POST /api/command` 白名单端点，把需要读本机文件 /
  改 agent 状态的 TUI 命令搬到 GUI。返回纯文本，`compact`/`rewind` 额外返回
  `refresh`，前端静默 `resumeSession(..., {quiet:true})` 重放历史。
- **第二批 9 条命令**：`/memory`（含 add/path）、`/skills` `/plugin` `/agents`
  `/release-notes` `/add-dir` `/compact` `/rewind` `/fast`，全部进 COMMANDS
  菜单与 `/help`。`/fast` 走 `POST /api/config` 新增的 `fastMode` 白名单，
  GET 也返回该字段，刷新后状态不丢。
- **命令失败原因**：`runServerCommand` 改用原生 fetch 解析错误体，
  不再把「当前没有活跃会话」显示成干巴巴的「HTTP 404」。
- **`/compact` / `/rewind` 真实生效**：服务端调 `agent.maybeCompact()` /
  `agent.rewind()`并强制落盘，前端重放界面。

### Fixed（迭代第 3 轮）
- **app.js 17 个孤立 CR 行尾**：来自历史追加式补丁（`/auto` 命令块），
  统一为 CRLF，JS 语义不变但 diff / 编辑器不再错乱。
- **单实例守卫只报错不给解法**：`npm run dev` 撞守卫时改为列出三条可执行路径
  （直接用已有页面 / taskkill / `MYCLAUDE_HOME` 隔离数据目录）。
- 新增 `test/iteration-round3.test.js`（5 项）。真浏览器 9/9 命令无「未知命令」、
  0 异常；守卫消息、错误体、`fastMode` 读写均实测。全量 **522/522**。


### Added（迭代第 2 轮：GUI 内建命令补齐第一批）
- **问题**：TUI `main.js` 有约 60 个内建命令，GUI `runCommand` 只实现约 20 个，
  其余一律返回「未知命令」，`/compact /cost /context /status …` 全是死路。
- **机制**：新增 `EXTRA_COMMANDS` 注册表，`default` 分支在自定义命令之后查表，
  后续批次只需加条目，不必再膨胀 switch。
- **第一批 13 条**（全部映射到现有 API / 面板，不新增后端端点）：
  `/status /stats /context /cost /doctor /title /todos /permissions /hooks /mcp`
  `/effort /models /export`。同步进 COMMANDS 斜杠菜单与 `/help`。
  `/title <名称>` 走 `PATCH /api/sessions/<id>`；`/effort` 走 `POST /api/config`；
  `/doctor` 并发探 `/api/config|hooks|mcp|models`；`/cost` 用目录里的 `inputPrice`
  `/outputPrice`（每 1M tok）估算，无价格时明确说明而不是显示 $0。
- `/context` 新会话无 stats 时用 `modelContextWindow × 0.8` 兜底压缩线，
  避免满屏 `0 / 0` 空条（实测显示 102.4k）。
- 新增 `test/gui-extra-commands.test.js`（3 项）：注册表被查表、13 条都在菜单里、
  且都是 TUI 真实存在的命令（防止凭空发明）。真浏览器逐条实测 13/13 无「未知命令」、0 异常。


### Fixed（迭代第 1 轮：右栏信息架构 + /bashes 命令）
- **右栏页签窄宽度换行**：`.insp-tab` 加 `white-space:nowrap; flex:none`，
  `.insp-tabs` 改横向滚动，4 个页签不再被挤成竖排（1440/900 双宽度实测 26px 单行）。
- **「任务」标签二义**：会话详情内嵌的 TodoWrite 待办改名「待办清单」，
  右栏「任务」页签加 tooltip 说明是后台任务（Bash / 子代理 / 工作流）。
- **右栏 section 头 / 键值行**：改编辑式低对比组头 + 延伸细线（与追问卡 / 画布
  同一套语言），KV 行改 76px 两列网格 + tabular-nums，补 900px 窄屏规则。
- **`/tasks` 与 `/bashes` 点了没反应**（真 BUG）：`openTasks()` 只往 `#tasks-body`
  渲染，不激活页签，而该容器默认 `hidden`。新增 `showTasks()` 先开右栏再
  `switchInspectorTab("tasks")`，两命令与 COMMANDS 入口统一走它；不在
  `openTasks()` 内反向调用以免递归。真浏览器实测两命令均 `active=["任务"]`。
- **`/bashes` GUI 缺失**：补 COMMANDS 项、`runCommand` case 穿透、`/help` 文案；
  `docs/parity-targets.md` 同步标记完成（TUI 早已实现，属文档漂移）。
- 新增 `test/gui-command-parity.test.js`（3 项）、`docs/iteration-backlog.md`
  （长目标待办清单：基线 511/511、0 异常，列明后续功能/样式缺口）。


### Changed（UI：顶栏去重 / 追问卡 / 画布）
- **顶栏模型药丸移除**：`btn-top-model` 与输入框旁 `btn-model` 打开的是同一个
  `#model-menu`，属重复控件。删 HTML/事件/CSS，菜单锚点统一回 `#btn-model`。
- **追问卡重设计**（number-details + beautiful-shadows + framed-grid）：
  组头改「继续追问 / FOLLOW-UPS + 延伸细线」；01–03 编号做低对比等宽角标；
  卡片由 14px 大圆角粗边框改 8px + 分层中性阴影，标题与描述间加细线，
  hover 浮现 L 形角标；保留键盘可达与三列网格。
- **画布重设计**：`.artifact-stage` 改细线框架 + 极低对角纹理；TEXT 工件若含
  ≥2 行 git status 记录，自动结构化为「状态徽章 / 路径 / 说明 + 汇总图例」，
  `M`/`??`/`A`/`D` 用语义色区分；切「代码」视图仍是原文，纯散文不受影响。
- 新增 `docs/ui-redesign-preview.html` 静态预览（引用真实 CSS 令牌，无需启动程序）。
- **深色主题 + 窄屏收尾**：追问卡阴影与画布对角纹理原本写死深灰 rgba，
  深色下几乎不可见；改由 `--card-shadow` / `--card-shadow-hover` /
  `--grid-texture` 两主题各定义一份（深色用黑阴影 + 微亮白纹理）。窄屏
  720px 隐藏英文组标、卡片最小高度改 `--fc-min-h` 变量；900px 收紧画布
  内边距与图例换行。真浏览器双主题对照确认两种配色下结构都成立。
- **任务计时移位**：「任务进行中 · 10s」从输入框右侧（`#stat`）移到对话流
  当前回合的思考条上，与「正在思考…」同行。计时 span 独立于 `thought-label`
  （后者会被 `endTurn` / reasoning 改写为「已思考 N 秒」），回合结束时清空，
  最终时长仍由 label 表述，不重复显示。新增 `test/task-timer.test.js` 防回归。
### Fixed（任务不再「突然结束」：一定有最终结论）
- **根因**：`agent.run()` 里 `!toolCalls.length` 直接把 `stripReasoning(text)` 存成
  assistant 消息并 `return done`。推理模型常只吐 `reasoning_content`、不吐
  `content`，此时 `text === ""`，循环照样判定「正常完成」→ 用户看到一条空白气泡。
  另一条路径是回合停在 `tool_calls` 上（turn cap / 流掐断），最后只留一张工具卡。
  会话 `4ec450` 的 #5 正文为空、#6 用户当场问「为什么我总是看不到结论」即此。
- **修复**：原循环改名 `runLoop()`，外层 `run()` 统一调 `ensureFinalAnswer()`：
  末尾不是「有正文的 assistant 消息」时，用 `tools: []` 再请求一次写结语
  （15s 超时、尊重停止、失败也有明确兜底文案），正常回合零额外请求。
  `maxTurnsReached` / `interrupted` / `blocked` 不插手，保证自主续跑语义。
- 新增 `test/final-answer.test.js`：空正文、已有结论、流错误三种收束各 1 例。

### Fixed（双击必达：页面真的打开）
- **双击 `myclaude.exe` 不再"嘴上打开"**：旧逻辑 `exec("start ...")` 刚发出去就
  `process.exit(0)`，和子进程赛跑——实测 3 次双击只有 1 次真的拉起浏览器，
  控制台却照样打印"已为你打开浏览器"。现在 `openInBrowser()` 等 exec 回调
  （`windowsHide`，8s 上限）拿到结果再退出；打不开就如实提示手动粘贴地址，不撒谎。
- **全新启动路径同源**：`startGui()` 末尾那份重复的 `start`/`open`/`xdg-open`
  三平台判断改为复用同一个 helper，去掉 lazy import + fire-and-forget。

### Added（GUI 对齐 claude.ai 第三轮 —— 外观/导航/引用）
- **主题三态**：深 → 浅 → 跟随系统循环（`prefers-color-scheme` 实时联动），boot 认 auto 偏好。
- **设置中心「通用与外观」页签**：主题/提示音/桌面通知/显示名/数据管理集中一处；
  「查看 / 撤销分享」打开分享管理器（列出全部快照：打开/复制链接/逐个撤销）。
- **右栏「消息目录」**：按用户提问编号列表，点击滚动+闪烁定位（长对话导航）。
- **Artifact「在新窗口打开」**：blob URL 直开 HTML/SVG（沙箱外完整体验）。
- **@ 菜单目录浏览**：文件索引纳入目录（尾斜杠），目录行回车进入继续找
  （`@src/` → `@src/ui/` → …），菜单标注「目录 · 回车进入」——对齐 Claude Code 的 @ 目录行为。

### Perf
- **会话恢复渐进渲染**：641 条消息的会话曾把主线程卡 20-30s（服务端 resume 仅 0.2s，
  时间全在客户端同步渲染）。现在首屏只渲染最近 60 条（起点对齐 user 消息保证
  tool_calls 配对），顶部「加载更早 80 条」分批 prepend、滚动位置保持。
  实测 641 条会话 522ms 首屏，分批 7 次收敛结果与全量渲染一致。

### Tests
- test/followup-chips.test.js 重写（5 项）：断言对象跟上美工卡片形态（{t,d} 三卡、
  标签等长、说明互异、网格约束、hover 动效）；提取范围限定在 buildFollowupPrompts
  函数体内，不再被快捷键/重试菜单等新数组干扰。07dc76f 升级卡片时该文件漏改。

### Added（GUI 对齐 claude.ai 第二轮 —— 会话协作与反馈面）
- **键盘快捷键面板**：`?` 或 `Ctrl+/` 唤起，三组分区（通用/对话/消息）kbd 样式总览；
  `/shortcuts` 命令注册；面板底部集中提示音/桌面通知两个开关。新增 `Ctrl+Shift+O` 新对话。
- **提示音**：WebAudio 合成三音色（回合完成双音上行 / 等待确认柔和单音 / 出错低音），
  偏好持久化 localStorage，面板内点按可试听。
- **桌面通知**：标签页隐藏时回合完成/等待确认发系统通知，标题栏未读计数 `(N)`，
  回到页面即清零；含浏览器权限申请流。
- **消息反馈 👍/👎**：助手消息 hover 工具栏新增；按「会话id+正文稳定摘要」存
  `~/.myclaude/feedback.json` sidecar（不与自动保存赛跑），刷新/重放按摘要恢复点亮。
- **分享对话（只读快照）**：`POST /api/share` 冻结会话快照（一会话一 token，重复分享覆盖），
  `GET /share/<token>` 自包含只读页（明暗自适应、代码高亮、离线可读、noindex）；
  右键菜单 分享/取消分享；`GET /api/shares` 全量索引；侧栏「已分享」角标。
- **导出 HTML**：`/api/session/export?format=html` 自包含快照下载（与分享页同一渲染器）；
  右键菜单入口。
- **重试菜单**：重试按钮升级三变体气泡——重新生成 / 更简短 / 更详细（对齐 claude.ai retry）。
- **Artifact 版本切换器**：同名同语言版本链 `◀ vN/T ▶` 与下拉联动。
- **输入草稿按会话保留**：`myclaude.draft.<sid>`，切换会话保存旧键/恢复新键/无草稿清空，
  杜绝把 A 会话的半句话发进 B；发送后清空。
- **搜索命中跳转**：搜索结果点击后恢复会话并滚动到命中消息，橙色闪烁 2.6s 定位。
- **图片灯箱**：消息内图片点击全屏放大（Esc/点击关闭）。
- **侧栏时间分组视图**：按项目 ⇄ 按时间（置顶/今天/昨天/近7天/近30天/更早）切换，偏好持久化。
- **回复截断续跑**：agent 透传 `finish_reason=length` → `truncated` 事件 → 「继续生成」一键续写。
- **AI 自动会话命名**：新会话首回合结束后用当前模型生成 16 字内标题（8s 超时、一会话一次、
  手动命名优先）；`session_title` 事件 + resume 返回 title，顶栏/侧栏同步。
- **错误一键重试**：回合内出现 provider 错误 → done 后给「重试」卡片。

### Fixed
- **providers 传输层弃用 fetch，改 node:http 独占连接**：undici 全局池在
  「headers 已到、body 未读就 abort」时留 half-open 连接，下一回合复用即
  90s 无响应——停止/断连后的下一回合曾稳定复现。agent:false 每请求独占
  连接用完即关，整类死连接问题根治；保留 TTFB 短超时 + abort 后 10s
  怀疑窗（3s 快速失败交 router 重试）。实测 RC2 断连中止 90s→1.5s。
- **AI 自动命名不再拖回合收束**：fire-and-forget（不 await）；标题请求带
  `AbortSignal.timeout(8s)` 硬保底——曾因新 provider 实例无 abort 记录、
  完整 90s 超时打到慢端点，把 done/busy 释放/关停拖住 90s。
- 顶栏上下文百分比把 token 数当比例，显示「11926700%」——按 contextUsed/contextLimit
  归一并 cap 100%。
- providers/openai.js `complete()` 引用未定义 `maxTokens`（任何调用直接 ReferenceError）——
  补解构参数并透传。
- 非流式请求的首字节看门狗定时器从不清理：每次 `complete()` 留一个 90s 悬挂定时器，
  拖住测试 runner 与 GUI 进程退出——headers 到达即清理 + `unref`。
- markdown.js 在 `"type": "module"` 包内被 require 拿到空命名空间——share 渲染器改用
  vm 提供 CJS 壳执行该 UMD 文件。
- test/commands.test.js 静态 import 在 env 设置前求值（CONFIG_DIR 定死真实 home）
  → 常驻 GUI 单实例锁撞锁；test/disconnect-abort、effort-wiring 的 undici 客户端池
  idle socket 拖住进程自然退出（after() 显式收尾 + stop() closeAllConnections 兜底）。

### Tests
- test/share.test.js（6）：快照复用 token、撤销、超大截断、只读页渲染、工具消息排除。
- test/gui-share-feedback.test.js（4）：分享全链路 HTTP、反馈写读取消、HTML 导出 404。
- test/provider-complete.test.js（2）：maxTokens 透传 + config 回落（进程干净退出）。
- 技能执行注入基目录（claude-src 同款 `Base directory for this skill:`）+ 项目根钉死 +
  测试隔离 MYCLAUDE_HOME（test/skills.test.js）。

### Fixed（检查器三块「没实现」区）
- 备用模型池是摆设：GUI 保存 fallbacks 发到 /api/config 后被服务端静默丢弃，
  怎么加都显示「暂无」。现 /api/config 接受并持久化 fallbacks（冒烟实测读写闭环）。
- MCP 服务器只能手编 config.json：新增 POST /api/mcp（add/remove/disable/enable）
  + GUI「+ 添加」弹窗（stdio 命令/参数 或 HTTP/SSE URL 双形态）+ 空态 CTA。
- 任务区空列表是正常态（无后台任务时），文案已改为解释性说明。

### Design（追问美工卡片）
- 追问建议从「一句话药丸」升级为设计卡片：编号标记（等宽 01/02/03）+ 短标题 + 完整说明
  三层结构；hover 抬升 2px + 陶土橙描边 + 阴影 + 箭头右移；focus-visible 环；720px 塌单列。
- buildFollowupPrompts 输出 {标题,说明} 结构（按 artifact/代码/通用三套语境）。
- dist/myclaude.exe 重新打包（bun 1.4.2，15s）——此前 exe 是 11-01 旧版，GUI 新样式从未到达用户。
- 视觉验证：Edge headless 截图实测渲染（编号/标题/说明/双态页脚全部正确，零截断）。
### Fixed（中断后会话永久失败 —— "Error in input stream" 连环报错根因）
- 根因：回合被杀在「assistant 声明 tool_calls」与「工具结果落盘」之间，会话尾部留下
  悬空调用；OpenAI 协议要求 tool_calls 必须紧跟匹配的工具结果，坏历史每次续跑都原样
  重发 → 上游拒绝并掐流 → 网关报 "Error in input stream"，重试永远失败。
- session.js 新增 sanitizeToolPairing：loadSession 时自动补记「[已中断]」工具结果、
  丢弃孤儿结果；幂等；真实坏会话（640 消息 / 1 悬空 Bash）实测修复。
- 流中断分类：未输出任何内容 → 502 可重试（router 自动换候选）；已吐过内容 →
  noRetry（绝不静默重放造成重复输出），交还用户点重试。
- RETRYABLE_PATTERN 扩展传输层掐流签名（error in input stream / socket hang up /
  premature close / broken pipe / terminated / econnreset 等）。
- GUI：掐流错误给出人话提示（自动换线 vs 点重试的分流说明）。
- gui-live-resume 测试收尾泄漏：stop() 先 closeAllConnections 再带超时关闭。

### Tests
- test/session-sanitize.test.js（8 项）：尾部/中部悬空、孤儿结果、健康历史不变、
  幂等、loadSession 落盘修复、掐流签名可重试、noRetry 优先于 502。
- 回归：failover 8/8、gui-resume 3/3、provider-stream 2/2、live-resume 2/2。

## [0.18.0] - 2026-10-19

模型引入方式对齐 DSH：单一网关 + 完整模型目录。

### Added
- `src/models.js`：内置模型目录，**46 个模型 / 9 家供应商**，与 DSH 同源
  - 每个模型带 `name`（人类可读名）、`contextWindow`、`maxTokens`、`input` 能力
  - 供应商即模型 id 的第一段（`qoder-cn/gfmodel` → `qoder-cn`），不必猜名字
  - 辅助函数：`findModel` / `contextWindowOf` / `maxTokensOf` / `supportsVision` /
    `vendorOfModel` / `vendorList`
- `/api/config` 暴露完整目录（`models`）、当前模型元数据（`currentModel`）、
  解析后的窗口与视觉能力

### Changed
- **默认配置切到本地网关**：`baseUrl` 改为 `http://127.0.0.1:3425/v1`（与 DSH 同一
  magpie 网关），默认模型 `qoder-cn/gfmodel`
- **上下文窗口按模型动态解析**：不再使用全局写死的 `1000000`；切换模型时
  `setModel()` 同步刷新窗口与输出上限，压缩节奏随之匹配真实模型
- **failover 池改为同网关多供应商**：限流时由另一家供应商承接，无需第二个端点
  或第二套凭据
- `/api/models` 以内置目录为主数据源（网关不在时也能列出全部模型），
  实时列表只用于补充目录缺失项
- 供应商判定优先取模型 id 前缀（网关约定），避免本地网关把厂商信息吞成「本地网关」

### Verified
- 178 项测试全部通过
- 实测：46 个模型归入 9 家；默认模型 `qoder-cn/gfmodel` 对话正常返回；
  上下文上限 160000（= 200000 × 0.8，按模型真实窗口计算）

## [0.17.0] - 2026-10-19

新增 fullAccess 权限模式：完全按指令执行。

### Added
- 第 7 种权限模式 `fullAccess`（`full` / `full-access` / `god` / `root` 均为别名）
  - 跳过所有工具调用确认
  - **同时跳过 deny 规则**——这是它与 `bypassPermissions` 的唯一区别
  - 适用场景：自有软件、可信环境、批量无人值守执行
- CLI 参数 `--full-access`（别名 `--god`），优先级高于 `--auto`
- `/mode` 帮助文本列出全部 7 种模式
- 设置页下拉与前端模式名映射同步支持
- `test/permission-modes.test.js` 新增 2 项：验证 fullAccess 确实无视 deny 规则、
  而 bypassPermissions 仍然遵守（两者差异有测试锁定）

### Changed
- 模式总数 6 → 7；`setMode()` 报错信息随之更新

### Verified
- 178 项测试全部通过

## [0.16.0] - 2026-10-19

供应商按 baseUrl 判定，模型菜单加搜索与滚动。

### Fixed
- 主机正则原先要求域名结尾匹配，带 `/v1` 路径的 baseUrl 全部失配；
  改为只取主机名后匹配
- 模型菜单无搜索、无滚动，模型多时下方不可见

### Added
- `src/vendors.js`：`vendorFromUrl()` 以接口地址为权威信号（识别 19 家），
  本地网关背后往往是多家供应商，故回退按模型名识别，识别不出才归「本地网关」
- `/api/models` 返回结构化条目 `{ id, baseUrl, vendor }`
- 模型菜单搜索框（可搜模型名与供应商）+ 滚动容器
- 每个模型项右侧淡色供应商后缀；分组标题带数量
- 设置页模型列表、检查器「备用模型」同样按供应商分栏
- 会话分区「模型」行追加供应商后缀
- `test/vendors.test.js`（6 项）

### Verified
- 176 项测试通过
- 实测 27 个模型归入 7 家（DeepSeek 2 / OpenAI 9 / 月之暗面 3 / 智谱 3 / Google 2 / xAI 1 / 本地网关 7）

## [0.15.0] - 2026-10-19

所有模型相关展示统一按供应商分栏。

### Added
- `vendorOf()` / `groupByVendor()`：从模型名推断供应商（DeepSeek / 智谱 / OpenAI /
  Anthropic / 阿里通义 / Meta / 月之暗面 / 百度 / 百川 / Google / Mistral / xAI /
  NVIDIA），未知时回落为「其他」；形如 `vendor/model` 的取第一段原样展示
- 三处模型展示统一套用该分组：
  - 顶栏模型下拉菜单
  - 设置页模型选择列表
  - 检查器「备用模型」分区（供应商小标题 + 各自的探活徽标）
- 分组小标题样式：大写、字距、右侧分隔线

### Verified
- 170 项测试通过
- 实测检查器渲染出「智谱 / OpenAI / Meta」三组，各模型带探活状态

## [0.14.0] - 2026-10-19

按使用反馈修复四个界面/功能问题。

### Fixed
- **MCP 在 Windows 上无法连接**：`StdioTransport` 之前用 `shell: true` 启动服务器，
  cmd.exe 按空格切分命令行，安装路径含空格时（如 `C:\Program Files\nodejs\node.exe`）
  被截断为 `C:\Program`，服务器立即以退出码 1 死亡。现在路径指向真实文件时直接
  spawn（不经 shell），仅裸命令名与 .cmd/.bat 垫片仍走 shell
- **左侧会话列表按项目分组**：按工作目录归组（可折叠，组内默认展示 5 条，超出显示
  「再显示 N 条」）；路径做归一化——正反斜杠与盘符大小写差异不再把同一项目拆成多组
- **删除会话改为行内两步确认**：点击 × 后该行变为「删除 / 取消」，替代阻塞式
  `window.confirm`；连续删除不再弹出串联的原生对话框
- **提示条不再无限堆叠**：相同文案合并为一条并显示 ×N 计数，最多同时 3 条

### Added
- **备用模型可用性检测**：检查器「备用模型」分区新增「检测可用性」按钮，
  逐个探测 `GET /v1/models` 并显示「可用 N ms / 不可用」；当前生效模型、
  切换次数、切换时间与上次失败原因也一并展示（此前只显示「待命 N」，
  无法判断备用池是否真的能用）
- `ProviderRouter.status()` 增加 `switchedAt`
- `test/mcp-needs-shell.test.js` 已并入现有用例；全量 170 项通过

### Verified
- 实测：主端点故障时自动切到 `openai/gpt-oss-20b` 并正常回复（switches=1）；
  三个备用模型探活全部可用（268–737 ms）；MCP stdio 服务器正常连接并桥接
  1 工具 / 1 提示词 / 1 资源

## [0.13.0] - 2026-10-18

MCP 支持 prompts 与 resources。

### Added
- `McpClient` 新增 `refreshPrompts()` / `getPrompt()` / `refreshResources()` / `readResource()`；
  `connect()` 读取服务器 `capabilities`，只在服务器声明时才查询，避免对不支持的服务器产生错误噪声
- `McpManager` 新增 `allPrompts()` / `allResources()` / `findPrompt()` / `findResource()` /
  `usePrompt()` / `readResourceBy()`
- `McpManager.call()` 支持三种限定名：`server__tool`、`server__prompt__name`、
  `server__resource__name`，让模型通过既有的工具调用路径访问提示词与资源
- `runtime` 把 prompts/resources 桥接为模型可见工具：提示词的参数映射为 input_schema 属性
- `status()` 返回 `prompts` / `resources` 计数与 `promptList` / `resourceList` 明细
- GUI 检查器 MCP 分区显示「N 工具 · N 提示词 · N 资源」
- `test/mcp-prompts.test.js`（5 项）：能力发现、限定名分发、名称解析、未声明能力不查询

### Fixed
- `getPrompt()` 原先只返回 `messages`，agent 的工具结果路径读 `content` 会拿到 undefined；
  现在同时返回两者

### Verified
- 154 项测试通过（新增 5 项）

## [0.12.0] - 2026-10-18

权限模式对齐 Claude Code：从 3 种扩展到 6 种。

### Added
- `src/agent/modes.js`：权限模式注册表，CLI / agent / HTTP / UI 共用一份定义
  - 6 种模式：`ask` / `acceptEdits` / `auto` / `dontAsk` / `plan` / `bypassPermissions`
  - 别名归一化：`default`→ask、`edits`/`accept-edits`→acceptEdits、`dont-ask`→dontAsk、
    `bypass`/`yolo`→bypassPermissions（大小写、连字符、空格均可）
  - `isCommonFileCommand()`：acceptEdits 的 Bash 白名单（ls/cat/git status/npm test/cargo build…）
  - `isDestructiveCommand()`：危险模式黑名单（rm/del/mv/git clean/git push/npm publish/
    chmod/dd/sudo/注册表操作…），含管道、重定向、命令替换的复合命令一律不放行
- `test/permission-modes.test.js`（12 项）：注册表、别名、每种模式的决策表、
  deny 规则在 bypass 下仍然生效、危险命令零漏网

### Changed
- **只读工具在任何模式下都放行**（此前仅 plan 模式生效）：`Read`/`Grep`/`Glob`/`LS`/
  `Git*`/`WebFetch`/`WebSearch` 不再询问，也不会被 `dontAsk` 拒绝——否则 agent 将无事可做
- `dontAsk` 语义：需要确认的操作直接拒绝并说明原因，全程不打断用户
- `setMode()` 接受别名，非法值报错信息列出全部 6 种模式
- GUI 设置页下拉列出 6 种模式（含中文说明）；分段器仍保留日常三种，
  选中其余模式时隐藏滑块而不是错位停靠在别的标签下
- CLI `/mode` 无参数时列出全部模式；`--auto`/`--plan` 行为不变

### Fixed
- README 命令表在批量替换时被误伤（`/model` 行被覆盖并与下一行粘连），已修复

## [0.11.0] - 2026-10-18

自定义斜杠命令。

### Added
- `src/commands.js`：把 Markdown 文件变成斜杠命令
  - 扫描 `~/.myclaude/commands/`（用户级）与从 cwd 向上到仓库根的 `.myclaude/commands/`（项目级）
  - 文件名即命令名，正文即提示词；项目命令覆盖同名用户命令
  - `$ARGUMENTS` / `$1`..`$9` 参数替换；正文无占位符时自动追加用户输入
  - 可选 `---` front-matter：`description` / `argument-hint` / `model` / `allowed-tools`
- CLI 与 TUI：未知命令先查自定义命令，命中则展开为一次普通对话轮次（含自动保存与压缩）
- 新命令 `/commands`：列出内建与自定义命令
- GUI：`GET /api/commands`、`POST /api/commands/run`；自定义命令并入斜杠补全菜单与
  Ctrl+K 命令面板，并带（项目）/（用户）标识
- 本项目自带示例命令：`.myclaude/commands/review.md`、`explain.md`

### Changed
- 斜杠补全菜单显示上限从 8 条提到 12 条（此前自定义命令会被截断掉）

### Verified
- 137 项测试通过（新增 `test/commands.test.js` 7 项：发现、front-matter、
  参数展开、大小写、非 md 忽略、仓库根停止上溯、两个 HTTP 接口）
- 浏览器实测：输入 `/rev` 精确匹配到 `/review — 审查指定范围的改动（项目）`

## [0.10.0] - 2026-10-18

真实的 token 用量统计。

### Added
- `OpenAIProvider` 解析流式尾部的 `usage` 块（请求带 `stream_options.include_usage`），
  `streamChat()` / `complete()` 返回 `{ promptTokens, completionTokens, totalTokens }`
- `Agent` 跨轮次累加 `totalInputTokens` / `totalOutputTokens`
- `/api/config` 与 `stats` 事件下发 `inputTokens` / `outputTokens`
- GUI 检查器「会话」分区新增 Token 行；用量环悬停提示显示输入/输出拆分
- `test/usage.test.js`（4 项）：端点上报时正确累加、不上报时保持为 0

### Changed
- 端点未上报 usage 时，上下文用量回退到字符估算并在界面标为 `≈N`，
  不再把估算值伪装成真实计数

### Verified
- 130 项测试全部通过
- 真实端点（不支持 include_usage 的网关）验证回退路径：显示 `≈13` 而非 0

## [0.9.0] - 2026-10-18

MCP 支持远程服务器；子代理递归防护；界面细节修复。

### Added
- `src/mcp/http-transport.js`：两种 HTTP 线格式
  - Streamable HTTP（现代）：POST 单端点，响应可为 JSON 或 SSE
  - HTTP + SSE（2024 拆分协议）：GET 长连接收消息、POST 端点发消息
- `createTransport()` 按配置选择传输；`McpClient.connect()` 在 Streamable 请求被
  4xx 拒绝时自动回退到 SSE，因此只实现旧协议的主机也能连上
- MCP 配置支持 `url` / `headers` / `transport` / `timeoutMs` / `disabled`
- `McpManager.status()` 现在同时返回连接成功与失败的服务器（含错误原因与传输类型）
- GUI 检查器新增「MCP 服务器」分区：待连接 / N 工具 / 失败原因
- `test/mcp-http.test.js`（6 项）：mock 服务器同时实现两种协议，验证握手、
  工具调用、自动回退、失败上报与不可达时不挂起

### Changed
- 工具说明在 GUI 中改为中文（工具名保持英文，它是 API 标识符）
- 检查器不再罗列工具清单（工具数改由侧栏徽标显示），改为展示 MCP 状态
- `notifications/initialized` 改为 await：stdio 写入本身有序，但 HTTP 传输必须等
  通知送达后再发 `tools/list`，否则握手存在竞态

### Fixed
- 子代理可以无限递归委派 Task：现在子代理不再获得 Task 工具，并加入
  `MAX_TASK_DEPTH = 2` 的显式上限
- `.ghost-btn` 无样式定义，导致顶栏「展开输出」按钮文字竖排
- 顶栏 HTML 结构被破坏（按钮嵌进未闭合的 `<svg>`），已重建并校验标签配平
- 工具数徽标恒为 0：赋值被放在只在对话结束时调用的 `refreshStats` 里，
  移到 `renderTopMeta`（启动即执行）
- `/api/mcp` 只查 `default` 会话，多标签页下查不到；改为遍历全部会话，
  且首轮对话前返回配置中的服务器并标记为待连接
- `SseHttpTransport.start()` 内部是无退出条件的读循环，await 它会永久挂起；
  改为后台读流 + 等待 endpoint 事件
- `git log --pretty=format:%h` 的 `%` 被 PowerShell 吞掉（0.8 遗留）

### Verified
- 126 项测试连续三轮全绿
- 真实 MCP stdio 服务器端到端：连接、tools/list、GUI 展示「demo · 1 工具」
- 顶栏、检查器、MCP 分区逐一截图确认

## [0.8.0] - 2026-10-18

补齐编程 agent 的核心工具链与界面能力。

### Added
- `src/tools/git.js`：Git 工具家族
  - `GitStatus`：分支、staged/unstaged/untracked、最近提交（结构化返回）
  - `GitDiff`：统一 diff，同时返回**解析后的结构**（files/hunks/add/del/ctx/meta），
    支持 staged、paths、stat_only
  - `GitLog`：提交历史，支持 count、paths、range、oneline
  - `GitCommit`：按 paths 或 add_all 暂存后提交，拒绝空消息与空暂存区
  - `parseUnifiedDiff()` / `diffSummary()`：可单测的 diff 解析器
- GUI：工具卡支持 **diff 着色视图**（文件头 +/+/- 计数、hunk 头、红绿行）
- GUI：会话回放时按 `tool_calls` 还原真实工具名与参数，diff 文本重新解析为着色视图
- GUI：顶栏「展开输出」按钮，一键展开/收起全部工具卡
- GUI：用户消息增加「编辑重发」操作（填入输入框供修改）
- 新增 `test/git-tools.test.js`（10 项，使用临时仓库，不污染真实工作区）

### Changed
- 上下文压缩从"保留最后 6 条"改为 **LLM 摘要**：先让模型把中段历史浓缩成
  200 字以内的中文摘要，失败时降级回截断；`maybeCompact()` 改为 async 并 await
- 权限白名单：`GitStatus/GitDiff/GitLog` 加入免确认与 plan 模式只读集合
- `ui.toolEnd()` 第 5 个参数携带结构化数据（git/diff/taskId）

### Fixed
- PowerShell 下 `git log --pretty=format:%h` 的 `%` 被 shell 吞掉，改为不含
  `%` 的 medium 格式
- 空仓库（无提交）时 `rev-parse HEAD` 报错，改用 `--git-dir` 判断
- 工具卡同时显示工具名与"名：目标"造成重复
- diff 解析器把 `---/+++` 当内容行，正确归类为 meta

### Verified
- 真实模型驱动跑通 GitStatus → GitDiff 调用链，`tool_end` 带结构化 diff
- diff 渲染经 DOM 核验：1 文件 / +3 / -2 / 1 hunk
- 116 项测试全部通过

## [0.7.0] - 2026-10-18

按反馈修复 7 项界面问题。

### Added
- 模型供应商归属推断与淡色标注：顶栏模型按钮显示「型号 + 供应商」（DeepSeek/OpenAI/通义千问/Moonshot/WorkBuddy/NVIDIA/智谱/Meta）
- 设置页模型列表改为按供应商分组，默认折叠为一行「已发现的模型（N）」，不再占满弹窗
- 会话按项目（cwd）分组，组头显示项目名与会话数，每组默认展示 5 条，超出显示「再显示 N 条」；双击会话可直接重命名
- 侧栏可收起为图标条（rail-head 左侧箭头 / Ctrl+B），记忆到 localStorage
- 顶栏新增「检查器」开关，检查器内容改为卡片化分区，默认收起

### Changed
- 检查器移除「工具」分区（工具数量已显示在侧栏徽标）
- 备用模型名称完整显示并附供应商标注，不再被截断
- 欢迎区更紧凑、输入区上移，减少底部留白
- 权限模式默认恢复为「询问」（此前被误存为 auto）

### Fixed
- 前端整段替换未生效导致会话列表无分组渲染的问题

### Verified
- 主界面 / 设置页 / 检查器展开三态逐一截图确认；106 项测试通过

## [0.6.0] - 2026-10-18

界面全面重做：参考 beautifului.dev 的 AI 原生组件范式与 beui.dev 的动效质感，
改为中文原生界面。

### Added
- 中文界面（原生文案，非翻译），页面标记 `lang="zh-CN"` 并禁用浏览器自动翻译，
  修复了英文界面被逐词翻译导致的"巴什 输 出"式布局破碎
- 设计系统重写：纯黑底、发丝级边框、10px 圆角、Inter + JetBrains Mono，
  令牌收敛为 --bg/--panel/--line/--fg 四层灰度
- 输入区重构为 beautifului 的 Prompt Bar 范式：一体胶囊、上下分区，
  模式选择改为弹簧滑块分段器（询问/自动/计划）
- 设置页重做：模型输入 + 服务端发现的可选模型列表（/api/models，27 个）+ 当前模型高亮，
  并可改接口地址、密钥、权限模式与视觉开关
- 会话右键菜单：置顶、重命名、导出 Markdown、删除
- 新增 /api/models 接口

### Fixed
- 模型切换不生效：app.js 引用已删除的 `sel-mode`/`m-model` 等 id 导致空指针，
  前端整体重写后与新 DOM 逐一核对（46 个引用全部对齐）
- 主题切换圆点被 .rail-item span:first-of-type 的 flex:1 拉成横条（优先级覆盖修复）
- 设置保存后模型/模式/视觉三处状态不同步

### Changed
- 测试 106 项全部通过（样式断言随设计系统更新）
- exe 重建，内嵌资源 page 10.8KB / css 40.9KB / app 62.8KB

## [0.5.0] - 2026-10-18

API 出错自动切换到备用免费模型。

### Added

- `src/providers/router.js`：`ProviderRouter` 负责候选排序、错误分类与故障转移
  - 每个候选是**完整 provider 配置**，可指向不同主机与密钥，不只是换模型名
  - `isRetryable()` 判定：429/408/425/5xx 与 401/403、网络错误、超时、限流文案 → 切换；
    400/422 等请求错误与用户中断 → 立即上报
  - 切换成功后记住该模型，后续轮次沿用；`status()` 暴露候选池与累计切换次数
- 配置项 `fallbacks`（默认内置 NVIDIA NIM 的 `gpt-oss-20b` / `glm-5.3-flash` /
  `llama-3.2-11b-vision`，均实测支持工具调用）与 `requestTimeoutMs`（默认 90s）
- `Agent.setModel()` / `Agent.routingStatus()`：运行期切换模型并同步路由器
- GUI：切换时弹出提示条；检查器新增 Fallback models 区块（当前模型、待命模型、切换次数、最后错误）
- 新增 SSE 事件 `routing`

### Changed
- `OpenAIProvider` 增加 `request()`：统一超时控制，流式响应在收到响应头后停止计时，
  避免长生成被误杀
- 测试增至 106 项，新增 `test/failover.test.js`（限流、500 链式降级、超时、400 不重试、
  全部失败、用户取消、重复候选去重）

### Fixed
- 端点挂起时请求会永久阻塞且无法恢复；现在按 `requestTimeoutMs` 中止并切换
- `ProviderRouter` 构造时重新创建 provider 会丢测试桩与既有配置，改为复用传入实例

## [0.4.0] - 2026-10-18

动效与流畅度升级，功能进一步向 Claude 对齐。

### Added

**动效系统**
- 统一的动效令牌：`--ease / --ease-out / --ease-spring` 与 `--dur-1..4`，所有过渡收敛到 90–340ms
- 进场动画：消息逐条上浮淡入、工具卡片、通知、建议卡片（阶梯延迟）、会话行侧滑、欢迎页标志弹性落位
- 控件反馈：按钮按压下沉、主按钮与发送键悬浮抬升并带色晕、附件图标弹性放大、焦点环延迟展开
- 状态指示：流式光标呼吸、思考图标缓慢旋转、运行中工具的状态点向外涟漪、进度条缓动
- 骨架屏：会话列表首次加载时显示流光占位，避免空白闪烁

**流畅度**
- 流式渲染从「每个 token 重建整个 DOM」改为按帧合并（`requestAnimationFrame`），
  一轮长回复的 DOM 写入量下降一个数量级
- 滚动采用 `rAF` 写入并带「贴底」判断：用户向上翻阅时不会被新内容拽回底部，
  回到底部按钮在偏离 240px 时出现

**功能对齐 Claude**
- 消息级操作：助手消息支持复制与重试；用户消息支持编辑重发
- 重试真正回退上下文：`Agent.rewind()` + `run({ reuseLastUser })`，不会把上一轮重复塞进历史
- 「Thought for Ns」折叠条：等待首个 token 时显示，完成后显示耗时，可展开查看过程
- 斜杠命令补全：输入框内键入 `/` 即弹出候选，`↑/↓` 选择、`Tab/Enter` 补全、`Esc` 关闭
- 上下文用量环：顶栏显示已用比例，70% 转琥珀、90% 转红，悬停显示精确 token 数
- 会话管理：右键重命名、置顶（置顶排在最前）、导出 Markdown、删除
- 图片灯箱：点击消息内图片全屏预览，`Esc` 或点击关闭
- `?theme=light|dark`、`?motion=off` URL 参数，便于演示与嵌入

**无障碍**
- 尊重 `prefers-reduced-motion`，并在设置中提供显式关闭开关（记入 localStorage）

### Changed
- `package.json`：版本 `0.3.0` → `0.4.0`
- 测试增至 98 项，新增重命名/置顶、Markdown 导出、上下文用量的覆盖

### Fixed
- 重试按钮此前调用未定义函数，且重试会把历史里的用户消息重复一次
- 发送与重试的事件处理各自实现一份，导致行为分叉；现统一走 `runTurn`
- `gui-server.js` 缺少 `saveSession` 导入，导致 PATCH 会话返回 500

## [0.3.0] - 2026-10-18

GUI 重写：从单文件内嵌页面升级为三栏工作台，视觉语言对齐 Claude 自己的界面。

### Added

**三栏工作台**
- 左栏：新建对话、命令搜索、会话列表（恢复/删除）、Files / Tools / Tasks、Sessions / Settings、主题切换
- 中栏：会话信息、消息流、输入区；右栏：Session 元信息、TodoWrite 实时任务列表与进度条、工具清单
- 明暗双主题，选择持久化到 localStorage；窄屏下侧栏抽屉化、inspector 悬浮

**消息渲染**
- `src/ui/web/js/markdown.js`：零依赖 Markdown 渲染器，支持标题、段落、有序/无序/任务列表、
  表格、引用、分割线、行内强调/删除线/代码/链接、围栏代码块与轻量语法高亮
- 安全优先：先整体转义再解析；`javascript:/vbscript:/file:/data:` 链接被改写为惰性锚点；
  代码块带语言标签与一键复制
- 助手消息流式渲染带光标，完成后出现复制操作；工具调用渲染为可折叠卡片，显示状态点、
  参数摘要、耗时与完整参数/输出

**会话与生成控制**
- 每个浏览器标签页独立会话（`sessionKey`），互不干扰；`POST /api/abort` 中止当前生成并
  解除挂起的确认框
- 会话列表由 `GET /api/sessions` 提供，标题取自首条用户消息；`DELETE /api/sessions/:id` 删除
- 恢复会话时重放历史消息到界面（`POST /api/session` 的 `action: "resume"`）

**工作区集成**
- `GET /api/fs` / `GET /api/fs/file`：目录浏览与只读文件预览，路径限制在 cwd 内，越界返回 403；
  二进制文件不返回内容；文件预览带语法高亮
- `GET /api/tasks`：后台任务列表与退出码；`GET /api/todos`：当前 TodoWrite 状态
- `GET/POST /api/permissions`：在「Always allow」时把工具加入白名单并持久化

**前端工程**
- `src/ui/web/` 存放页面、样式与脚本，原生 ES，无构建步骤
- `scripts/bundle-gui.mjs` 把前端内联进 `src/ui/assets.js`，`npm run build` 产出真正自包含的 exe；
  `node bin/myclaude.js --gui` 仍直接读磁盘，改完刷新即生效

### Changed
- `src/ui/gui-server.js` 从「单页面 + 少量接口」重写为按职责划分的路由层，支持多会话，
  并要求 Host 头为 loopback（防 DNS rebinding）
- 附件上限放宽到文本 512KB / 二进制 5MB，二进制附件只传引用
- `package.json`：版本 `0.2.0` → `0.3.0`，新增 `build:embed`、`gui` 脚本
- 测试增加到 95 项，新增 `test/markdown.test.js` 与 `test/gui-features.test.js`

### Fixed
- 确认框与提问面板的请求 id 变量缺少声明，导致回答无法路由回对应请求
- `[hidden]` 属性被组件自身的 `display: grid/flex` 覆盖，停止按钮等元素的显隐失效
- 页面在部分视口下无法铺满，改为 `position: fixed; inset: 0` 的网格容器
- TodoWrite / AskUserQuestion / ExitPlanMode / BashOutput 在 ask 模式下也会弹确认框；
  这些工具不触碰文件系统，现在任何模式都直接放行
- 测试会写入真实的 `~/.myclaude/config.json` 和会话目录；新增 `MYCLAUDE_HOME` 覆盖，
  测试全部改在临时目录中运行

### Known issues
- 会话仅按浏览器标签页隔离，刷新页面后需要从左栏重新打开历史会话（不会自动重放）
- 上下文压缩仍是简单的尾部保留策略，可在紧凑会话中丢失早期细节

## [0.2.0] - 2026-10-17

### Added

**附件与视觉能力（16:59–17:42）**
- 新增 `src/attachments.js`：图片/文本文件附件读取与编码
  - 支持 png/jpg/jpeg/gif/webp/bmp（默认上限 5MB，base64）
  - 文本类文件内联（默认上限 200KB），PDF 等二进制只传路径引用
  - `buildUserContent()` 生成 OpenAI 多部分消息；无附件时仍返回纯字符串，兼容只收字符串的 provider
  - `buildToolAttachmentContent()` 把工具返回的图片转成后续 user 消息（`tool` role 只接受字符串）
  - 单个附件失败不会中断整轮对话，降级为 `{kind:"error"}` 并提示
- `/attach`、`/attachments`、`/detach`、`/vision [on|off]` 四个命令（`src/main.js`）
- TUI 输入框上方的附件条 `AttachmentBar`（`src/ui/ink-app.js`），`TuiBridge.setAttachments()`（`src/ui/tui-bridge.js`）
- GUI：📎 文件选择、拖放上传、粘贴截图、附件 chip、`/api/attach` 接口、顶栏 vision 开关（`src/ui/gui-server.js`）
- 配置项 `vision`（默认 `true`，`src/config.js`）；关闭后图片只发文件名说明，避免不支持视觉的模型返回 400
- `Agent.run(input, { attachments })` 支持附件；`Agent.setVision()` 切换时会重建系统提示词（`src/agent/agent.js`）

**权限与模式（17:20，`src/agent/agent.js`）**
- `Agent.setMode(mode)` 运行期切换 ask/auto/plan，重建系统提示词而不丢历史
- `plan` 模式真正只读：`READ_ONLY_TOOLS` 免确认放行，`PLAN_MODE_BLOCKED` 直接拒绝
- `ExitPlanMode` 获批后自动切回 `ask` 模式

**扩展工具集（16:02–16:38）**
- `src/tools/extended.js`：`WebSearch`、`NotebookRead`、`NotebookEdit`、`AskUserQuestion`、`ExitPlanMode`
- `src/tools/extra.js`：`TodoWrite`（按会话隔离）、`WebFetch`
- `src/tools/index.js`：`MultiEdit`（原子多编辑）、`BashOutput`、`KillShell`、`Bash(run_in_background=true)`
- 工具总数从 11 增至 17：Read/Write/Edit/MultiEdit/LS/Glob/Grep/Bash/BashOutput/KillShell/
  TodoWrite/WebFetch/WebSearch/NotebookRead/NotebookEdit/AskUserQuestion/ExitPlanMode

**后台任务（15:56，`src/tools/tasks.js`）**
- 独立任务注册表：spawn 子进程、输出落盘、`BashOutput` 按 offset 增量读取、`KillShell` 终止
- Windows 下用 `taskkill /T /F` 结束进程树；进程退出时统一清理

**权限规则与项目记忆（16:28，`src/agent/permissions.js`）**
- `PermissionEngine`：`Tool(pattern)` 规则语法，`deny > ask > allow` 优先级，支持 `*`/`**`/`//` 绝对路径/`Bash(cmd:*)` 前缀
- `loadMemory()`：从 cwd 向上查找 `MYCLAUDE.md`/`myclaude.md`，并合并 `~/.myclaude/MEMORY.md`
- 新命令 `/memory`、`/permissions`、`/reload-memory`、`/tasks`

**测试（17:11、17:26）**
- `test/attachments.test.js`（17 项）、`test/gui-server.test.js`（7 项）
- 全量测试：72 项通过

### Changed
- `package.json`：版本 `0.1.0` → `0.2.0`（17:41）
- `README.md`：补充三种界面、附件/视觉、模式切换、扩展工具、MCP、配置说明（17:42）
- GUI 与 TUI 共用同一套 `Agent` 能力，模式/vision 切换即时生效，无需重启

### Fixed
- 工具返回图片时不再塞进 `tool` role（会被 OpenAI 拒绝），改为后续 user 消息
- GUI 中 `plan` 模式下 `Write` 被正确拦截，并在界面回显当前模式

### Known issues
- `dist/myclaude.exe` 构建于 **16:49**，早于上述 16:59–17:42 的改动；
  需要重新执行 `bun build --compile --minify --outfile dist/myclaude.exe src/main.js`
- 会话不会自动保存：只有手动 `/save` 才写入 `~/.myclaude/sessions/`；
  GUI 的会话状态仅存于内存，进程退出即丢失
- 仓库没有任何提交（`git log` 为空），无法通过 git 追溯改动

<!-- diff test -->
