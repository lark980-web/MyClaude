# 迭代待办清单（长目标：逐一修正 BUG / 未完成功能 / 样式）

> 目标：继续迭代，逐一修正「功能不完善、有 BUG、功能未完成、样式设计不合理」。
> 本文件每轮更新：新增发现、划掉已完成、记录验证证据。
> 起始：2026-11-05 00:30（Asia/Shanghai），计划约 07:00 收尾。

## 复刻轮 A（2026-11-06 01:06–01:20）：以 claude-re-2.1.302 对齐提示词

- [x] 产物可用性实测：2432 模块 / 2428 具名 / import 可解析 87.7%（余为 Node 内置）/
  依赖图 2428 节点 22934 边拓扑无环 → 上轮两个致命伤（名字对齐、切分不全）均已解决。
- [x] **系统提示词对齐**：1,455 → 12,310 字符，上游六段结构 + 本项目 Language/Environment +
  新增 Delegating 段；14 条高价值子句逐条断言；本地化改写（TodoWrite/MYCLAUDE.md/不冒用身份）。
- [x] **多代理原则迁移**：扇出调研→综合→批评模式；明确不搬 worker 池协议
  （SendMessage / task-notification / subagent_type），测试断言这些名字不得出现。
- [x] **子代理提示词补强**：5 行 → 6 条（自包含、不能提问须声明假设、只读不得声称改动、报告格式）。
- [x] 如实记录不可得项：工具 schema（程序化构造 + .d.ts 空声明合并表）、
  isReadOnly/isConcurrencySafe（文档自述无法静态判定）、命令表（抽取器噪音，产物自身已声明）。
- [x] 新增 `docs/claude-code-2.1.302-parity.md` 记录已对齐/已适配/不可得/待办。
- [x] 验证：全量 **548/548**、verify-features ✓、exe 重打并确认新内容已编入、服务在跑。
- [x] **内置 verify 技能移植**（复刻轮 B）：`src/skills-builtin.js` 8,593 字符，
  `loadSkills` 加 `builtin` 开关（默认含、可覆盖）、4 项新测试；全量 **552/552**。
- [x] 技能资产核实：28 个 SKILL 中多数为 Anthropic 生态专属（Artifacts/Cowork/plugin），
  仅 `verify` 等少数通用；已移植 verify，其余不适用。
- [x] **dynamic-sections 逐段评估**（复刻轮 C）：7 段中 2 段适用 →
  `subagent_steer_delegation` 替换委派纪律（更严格）、`autonomy_append` 做成
  `AUTONOMY_SECTION` 按 `config.autoRun` 条件注入；其余 5 段不适用
  （opus5 模型专属 / heron_brook 与 brook_heron 依赖运行时实验值 /
  willow_tern 实验开关 / endconv_deferred_hint 需 EndConversation 工具）。
- [x] 验证：10 项 parity 测试（含 autoRun 开关注入差异）、全量 **554/554**、exe 重打。
- [x] **Anthropic prompt caching 实现**（复刻轮 D）：依据官方缓存设计文档，
  最后一个 system 块 + 最后一条消息尾块两个断点（上限 4），可配置关闭、不污染历史；
  5 项新测试；全量 **559/559**。原先「不可得」的工具 schema 复核后仍不可得
  （`tools-snapshot.json` 实为 Playwright MCP 工具表，非 Claude Code 内置 schema）。
- [x] **Shift+Tab 模式轮转**（复刻轮 E）：`modes.js` 加 `MODE_CYCLE`/`nextMode`（单一来源），
  GUI 绑 Shift+Tab 作用于 document 级；真浏览器实测顺序与上游一致、0 异常；5 项测试。
- [x] **命令面定案**：`/vim` 与 `/output-style` 在 2.1.302 已被上游移除（改由 `/config`），
  故不实现 /vim，`/output-style` 保留现有实现仅记差异；`/statusline` 在产物中仅作为
  hook 输入类型（`StatusLineCommandInput`）出现，非独立命令。
- [x] **module-architecture.md 评估**：仅信息价值（2433 节点 / 22940 边 / 枢纽 chunk-e0x0xb6d），
  对 MyClaude 规模无可落地动作。
- [x] **发现并接上从不执行的测试**（复刻轮 F）：`test/smoke-commands.smoke.js` 因 glob
  不匹配 `*.smoke.js` 从未运行；新增 `npm run test:smoke`，实测 45 条命令 0 崩溃。
- [x] **清理**：根目录 14 个历轮临时文件（未跟踪草稿，1.09 MB）。
- [x] **一致性审计**：exe 新于所有源文件、全量 564/564、verify-features ✓、smoke ✓。
- [x] **事故与恢复**（复刻轮 G）：01:34:10 并发进程覆盖了 agent.js / skills.js /
  test/skills.test.js / main.js，13 个测试失败、构建报 createProvider 导出缺失。
  已全部恢复，并顺带修掉回退版 `skillDirs` 逐级上爬导致用户技能被误判为 project 的真 BUG。
  防复发：全部改动已 `git add` 暂存。
- [x] **已提交固化**：b0f108a（未推送、不含 apk/exe）。此前覆盖后只能靠测试契约重建，现已可从 git 直接回退。另一进程在 01:34:10 留下的 _p*.txt / _rea_probe*.txt 未跟踪草稿，未纳入提交、未删除。
  建议尽快 `git commit` 固化（不含 2.8GB apk）。
- [ ] 待办：剩余 skills、
  builtin-docs.md（89KB）、module-architecture.md、TUI 剩余 /statusline /vim /todo。

## 追补轮（2026-11-05 08:38–09:00）：用户反馈「还是没有结语 + 报错」

- [x] **复发诊断**：第 1 轮的 `ensureFinalAnswer()` 是事后补丁，自身有 3 个缺陷
  （共享 `abortController` 被 `res.on("close")` 误伤、15s 自 abort、只认 text 不认 reasoning）；
  真正根因是 `runLoop` 把空正文当完成。落盘会话尾部证据：
  `2026-11-03T16-59-42_4ec450.json`（压缩后 7 条，#5 空正文、#6 占位文案）。
- [x] 三层修复（主循环拒绝空正文 / 收尾请求独立 controller+30s+重试+认 reasoning /
  兜底改确定性工具摘要）。详见 CHANGELOG。
- [x] 验证：`final-answer.test.js` 7 项、全量 **530/530**、`verify-features` ✓、
  exe UTF-8 字节确认 `_emptyBodyRetries` 已打入、真浏览器 0 JS 异常、
  4 页签 `getEventListeners=[click]` 且按 id 点击切换正常（连续快速点索引是探测时序假象）。
- [x] 注意：`src/ui/web/js/app.js` 于 08:32 被并发的 MyClaude 会话改过（本轮未触碰，
  写入范围不冲突）；重打 exe 时按当时磁盘状态一起打入。

## 追补轮 2（2026-11-05 10:07–10:45）：任务实时读数

- [x] 工具聚合条右侧显示执行时长 + 累计 token，每秒更新、结束定格为记录。
  服务端新增 `progress` SSE（1s），前端 `setLiveStat()` 统一写徽标与思考条计时器。
- [x] 修复 `flushTimer` 每回合泄漏（try 内 const 在 finally 不可见）。
- [x] 验证：e2e 真实 `/api/chat` 收到 `progress`、全量 **534/534**、
  真浏览器徽标 `rightAligned=true` / mono / tabular-nums / 0 异常、exe 重打。
- [x] 构建曾一次性 `EPERM`（89MB exe 被占用），重试即成功，非代码问题。
- [x] 架构澄清：本项目**不是** Claude Code 底层（README「全部代码原创，
  无任何 Anthropic 专有代码」；CLAUDE-PARITY「代码不可直接复用，提取规格重新实现」；
  运行时 `provider=openai` / 本地网关 / `codebuddy/hy4free`）。问题多源于自研
  agent 循环 + 非 Claude 网关的适配，不是搬了成熟代码却改坏。

## 追补轮 3（2026-11-05 11:45–12:31）：底层接 Anthropic（模型层）

- [x] **模型层「底层用 Claude」已落地**：新增 Anthropic Messages API 适配器
  （`src/providers/anthropic.js`），继承 OpenAIProvider 复用传输层，只换线协议；
  工厂移到 `providers/index.js` 破除循环 import；`/api/config` 新增 `provider` 白名单；
  GUI 选「Anthropic 官方」现在会真实切换线协议。
- [x] 验证：转换器单测 4 项 + mock Anthropic SSE 端到端 1 项（请求形状 /
  thinking→reasoning / tool_use→真实工具调用 / usage），全量 **539/539**。
- [ ] **限制**：无 `ANTHROPIC_API_KEY`，真实 api.anthropic.com 未实测；
  用户填入 sk-ant 密钥后需实测一轮。
- [ ] 代码层（复用 claude-src 模块做引擎）确认不可行：bytecode / 虚拟根 /
  闭源运行时绑定，只能当规格来源。

## 追补轮 4（2026-11-05 15:30–16:00）：命令面复刻差距归零

- [x] **从 claude-src 提取完整命令注册表**：`964_chunk-0qdm07jf.js` 122 处命中，
  提取 35 个真实命令名，与 TUI/GUI 逐项比对得精确缺口。
- [x] **GUI 补 5 条**：`/fork /branch /init /clear /provider`；服务端新增
  fork（克隆会话落盘、返回 forkedTo）/ branch（别名）/ init（inspectProject +
  renderProjectMemory 生成 MYCLAUDE.md）。
- [x] 复刻差距：TUI 仅剩 plugins/statusline/sandbox/vim/todo（后两个
  分别依赖官方 IDE 集成与 raw-mode，backlog 已列）；GUI 剩 0（除 anthropic 专属）。
- [x] 验证：接线断言 10/10、HTTP 直探 5 命令全过、全量 **540/540**、
  `verify-features` ✓、exe 重打（15:50）、7788 服务在跑。
- [x] 新增 `test/fork-command-e2e.test.js`。

## 第 1 轮基线核查（2026-11-05 00:30–00:40）

- 全量测试 `node --test "test/*.test.js"`：**511/511 通过**（37.5s），无失败、无跳过。
- 真浏览器交互审计（headless CDP，11 次点击：4 页签 / 设置 / 关闭 / 侧栏 / 快捷键 /
  风格菜单 / 模型菜单）：**0 异常、0 console error、0 网络失败、0 HTTP 4xx/5xx**。
- 死控件审计：page.html 254 个 id，45 个未在 app.js 以字面量引用 —— 逐一抽查
  （`btn-proj-modal-close` → `data-proj-close` 委托；`plib-cnt-*` → `$("plib-cnt-"+k)`；
  `voice-wave`/`proj-switcher-bar` → CSS/结构），**均非死控件**。
- 文档缺口：`docs/parity-targets.md` 的「待做」清单仍列 `/bashes`，但 main.js:648 已实现
  （文档漂移）；GUI 侧 `runCommand` 确实缺 `/bashes`。
- 结论：**测试覆盖内没有可复现 BUG**，缺口集中在「未覆盖的功能面」与「视觉/信息架构」。

## 已完成（历史轮次，保留索引）

- [x] 双击 exe 不打开页面：`openInBrowser()` 等 exec 回调，A/B 0/3 → 3/3
- [x] 任务执行完没有最终结论：`ensureFinalAnswer()` 补写结语 + `test/final-answer.test.js`
- [x] 左上模型药丸与输入框重复：删除，菜单锚点统一回 `#btn-model`
- [x] 追问卡重设计 / 画布结构化变更清单 / 任务计时移到思考条
- [x] 深色主题 + 窄屏收尾：`--card-shadow` / `--grid-texture` / `--fc-min-h`

## 第 1 轮修复

- [x] 右栏 4 个页签在窄宽度被挤压换行（截图中「会/话/详/情」竖排）：
  `.insp-tab` 加 `white-space:nowrap; flex:none`，`.insp-tabs` 允许横向滚动不换行。
- [x] 「任务」标签二义：会话详情内嵌的 TodoWrite 待办 与 右栏「任务」页签（后台 Bash
  任务）同名。内嵌 section 改名「待办清单」，页签加 tooltip 说明「后台任务」。
- [x] 右栏 section 头与键值行平铺、层级不清：改编辑式细线组头 + KV 两列网格对齐
  （与追问卡 / 画布同一套设计语言），补窄屏规则。
- [x] GUI 缺 `/bashes`（TUI 已有，parity 文档标「待做」）：加别名 → `/tasks`，
  并更新 `docs/parity-targets.md` 消除文档漂移。
- [x] **真 BUG：`/tasks` 与 `/bashes` 点了没反应**。`openTasks()` 只渲染进
  `#tasks-body`，不激活页签，而该容器默认 `hidden`。新增 `showTasks()` 先开右栏
  再 `switchInspectorTab("tasks")`，命令与 COMMANDS 入口统一走它。真浏览器实测
  两命令均 `active=["任务"]` / `tasksHidden=false` / 0 异常。
- [x] 验证：全量测试 **514/514**（新增 3 项）、`verify-features` ✓、
  headless CDP 1440/900 双宽度截图（页签 26px 单行、5 个组头细线、KV 76px 网格）、
  exe 已重打（00:52）、7788 服务 `--no-open` 在跑。

## 第 2 轮修复（2026-11-05 01:00–01:10）

- [x] **GUI 内建命令缺口第一批 13 条**：新增 `EXTRA_COMMANDS` 注册表 + `default`
  分支查表，`/status /stats /context /cost /doctor /title /todos /permissions`
  `/hooks /mcp /effort /models /export` 全部落地（映射到现有 API / 面板，
  不新增后端端点）。同步 COMMANDS 斜杠菜单与 `/help`。
- [x] `/context` 新会话无 stats 时用 `modelContextWindow × 0.8` 兜底压缩线，
  实测从 `0 / 0` 变为 `0 / 102.4k`。
- [x] 验证：真浏览器逐条跑 13 条命令 —— 11 条输出信息、`/models` 开模型菜单、
  `/export` 开导出菜单，**0 个「未知命令」、0 异常**；全量测试 **517/517**；
  `verify-features` ✓；exe 已重打、7788 服务 `--no-open` 在跑。
- [x] 新增 `test/gui-extra-commands.test.js`（3 项）。

## 第 3 轮修复（2026-11-05 01:20–01:35）

- [x] **第二批 9 条 GUI 命令**：`/memory /skills /plugin /agents /release-notes`
  `/add-dir /compact /rewind /fast`。新增 `POST /api/command` 白名单端点承载
  读文件 / 改 agent 的命令；`compact`/`rewind` 落盘后前端静默重放历史。
  `/fast` 补进 `POST /api/config` 白名单 + GET 响应。
- [x] 命令失败不再显示「HTTP 404」：改原生 fetch 解析 `j.error`，实测显示
  「当前没有活跃会话」。
- [x] **B：app.js 17 个孤立 CR** 统一为 CRLF（`/auto` 追加块），语义不变。
- [x] **B：单实例守卫报错无解法** → 给出三条可执行路径；真起第二个实例实测
  stderr 完整打印指引。
- [x] 验证：HTTP 直探 8 个服务端命令 6 成功 / 2 优雅 404；真浏览器 9/9 无
  「未知命令」、0 异常；`fastMode` POST/GET 实测并已还原为 false；
  全量 **522/522**、`verify-features` ✓、exe 已重打、7788 服务在跑。
- [x] 新增 `test/iteration-round3.test.js`（5 项）。

## 第 4 轮修复（2026-11-05 01:40–01:50，收尾验证 06:57）

- [x] **真 BUG：设置中心供应商网格第三列被裁掉**。根因是裸 `repeat(3, 1fr)`
  + grid 项默认 `min-width:auto`，长名字撑破列（728 / 927，溢出 199px）。
  改 `minmax(0,1fr)` + 卡片 `min-width:0`，实测溢出 0、9 卡等宽 236px。
  名字省略时补 `title` 悬停全称。浅色/深色双主题截图确认。
- [x] 同类预防：`.welcome-suggestions` 与 640px 断点改 `minmax(0,1fr)`，
  420px 加单列回退。
- [x] **C：设置中心 / 欢迎卡统一编辑式视觉语言**（细线组头、8px 圆角、
  主题感知分层阴影、实线分隔、模态 12px 圆角）。欢迎卡原写死 rgba 阴影在
  深色下失效，一并换成 `--card-shadow` 令牌。
- [x] 验证：全量 **525/525**、`verify-features` ✓、真浏览器浅/深双主题
  0 异常、exe 重打（01:49）、7788 服务在跑。
- [x] 新增 `test/iteration-round4.test.js`（3 项）。

## 第 6 轮修复（2026-11-05 07:00–07:10，7 小时窗口收尾）

- [x] **输入框快捷 chips 间距/视觉收敛**：gap 8→6、圆角 10→8、细线边框、
  32px 高、选中态改用 `--card-shadow`。真浏览器实测 4 枚 chips 全部符合，
  4 个右栏页签逐一切换正确（0 异常）。
- [x] 验证：全量 **526/526**、`verify-features` ✓、exe 重打、7788 服务在跑。

### 7 小时窗口总结（00:30 → 07:00）

- 6 轮迭代，每轮都「改源码 → 全量测试 → 真浏览器验证 → 重打 exe」。
- 修复 **4 个真 BUG**（空正文无结论、双击不开页、`/tasks` 无反应、设置中心
  第三列裁切）、**23 条 GUI 命令**、3 轮样式统一、2 项代码质量。
- 测试从 511 → **526** 全绿，无回归。
- 仍有 8 项记录在下方「待办」，供后续会话继续（这是时间盒的边界，不是遗漏）。

## 待办（按价值排序，供后续轮次逐条推进）

### A. 功能未完成（GUI 命令面）
- [x] ~~第二批 GUI 命令~~ ✅ 第 3 轮已补齐 9 条（`/memory /skills /plugin`
  `/agents /release-notes /add-dir /compact /rewind /fast`），累计 GUI 已有
  「第 1 轮 1 条 + 第 2 轮 13 条 + 第 3 轮 9 条」共 23 条补齐命令。
- [ ] **第三批（仍缺）**：`/fork /branch /loop /init /statusline /vim`。
  其中 `/fork /branch` 需会话分叉 API；`/loop /init` 需新端点；`/statusline`
  曾有挂起问题已回滚、`/vim` 工作量大，均排最后。
- [ ] Esc+Esc 编辑上一条消息（TUI，parity-targets #1）；GUI 等价物（右栏消息编辑，
  parity-targets 末行）。`agent.rewind(text)` 已存在，可复用。
- [ ] `/statusline` 自定义状态行（TUI，parity-targets #2）—— 首次实现有挂起问题已回滚，
  需 TTY 交互调试，风险高，排后面。
- [ ] `/vim` TUI 输入模式（parity-targets #4，低优先、工作量大）。
- [ ] 消息目录只列出「已渐进渲染」的消息（会话恢复首屏 60 条），长对话目录不完整。

### B. 代码质量 / 潜在 BUG
- [x] ~~app.js 17 个孤立 CR~~ ✅ 第 3 轮统一为 CRLF，实测 bare CR = 0。
- [x] ~~单实例守卫报错无解法~~ ✅ 第 3 轮给出三条可执行路径，真起第二个实例实测。

### C. 样式 / 信息架构
- [ ] 右栏「备用模型」区在空池时的禁用态文案与「+添加」入口（另一并发会话已在核查，
  避免重复改动）。
- [x] ~~设置中心旧视觉语言~~ ✅ 第 4 轮已统一（细线组头 / 8px / 主题感知阴影 /
  实线分隔），并顺手修了第三列裁切 BUG。
- [ ] **提示词库 / Projects 模态框**仍是旧视觉语言，未跟进细线 + 编号体系。
- [x] ~~欢迎页四张能力卡片间距~~ ✅ 第 4 轮 gap 12→10、8px 圆角、主题感知阴影。
- [x] ~~输入框下方快捷 chips 的间距节奏~~ ✅ 第 6 轮已收敛。

## 验证基线（每轮收尾必跑）

1. `node --test "test/*.test.js"`（全量，约 40s）
2. `node scripts/verify-features.mjs`
3. headless CDP 真浏览器：加载 7788、切换 4 页签、截图对比、0 异常
4. `node scripts/build-exe.mjs` 重打 exe（双击生效的唯一途径）
5. 起 1 个 `--gui --no-open` 服务（不弹浏览器窗口），F5 可见
