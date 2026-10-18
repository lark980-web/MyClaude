# Changelog

本文件记录 MyClaude 的所有重要变更。格式参考 [Keep a Changelog](https://keepachangelog.com/)，
版本号遵循 [SemVer](https://semver.org/)。

> 说明：此前项目没有 changelog，也没有任何 git 提交（`E:\` 仓库 `main` 分支为空），
> 所以 `0.2.0` 一节是根据源码时间戳（2026-10-17 15:56–17:42）与实际代码内容回溯整理的第一份记录。

## [Unreleased]

### Added
- `CHANGELOG.md`：建立变更记录制度。

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
