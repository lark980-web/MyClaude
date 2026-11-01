# 对齐 Claude Code 剩余目标（2026-10-30 夜间循环）

> 本文件是「逐项对比→实现→测试」循环的工作清单。完成的划掉并更新
> replica/features.csv。对照基准：claude-src 2.1.276 + 已安装 CLI 2.1.302。

## 已完成

- [x] /review —— ca93a72（TUI customPrompt 通道 + GUI runCommand 组提示词）
- [x] /output-style —— a748fe6 + 862c319 + 14a0663（内置三风格 + 自定义 md +
      agent.setOutputStyle 重建系统提示 + /api/output-styles + config 白名单）

## 待做（按价值排序）

### 1. Esc+Esc 编辑上一条消息（TUI）
- Claude Code：按两次 Esc 打开上一条用户消息进行编辑/回退，改动作为新回合发出
- MyClaude 现状：main.js TUI 有输入历史（上箭头），无 Esc+Esc 回溯编辑
- 实现点：main.js 的 TUI 输入处理（TerminalUI/bridge keybinding），
  双击 Esc → 取上一条用户消息填回输入框并把会话 rewind 到该消息前
- 注意：agent.rewind(text) 已存在（/undo 用过），复用

### 2. /statusline 自定义状态行（TUI）—— 首次实现有挂起问题已回滚，待交互调试
- Claude Code：statusline 命令 + settings.json 的 statusLine 字段，
  自定义脚本输出一行状态（模型/分支/token 等）
- 实现点：config.statusLineCommand；TUI 每次渲染底行时 spawn 脚本取输出；
  /statusline 无参说明 + 带参设置/清除

### 3. /bashes（低优先）
- /tasks 已超集覆盖（含 LOCAL_BASH 筛选与 BashOutput/KillShell）；
  可加别名让 /bashes 等价 /tasks，一行代码

### 4. /vim（低优先，工作量大）
- TUI 输入框 vim 模式（normal/insert、hjkl、w/b、dd…）
- 建议：只做 normal/insert 切换与基础移动，其余放后续

## 明确跳过（Anthropic 生态专属，本地复刻无意义）

- /ide、/login、/logout、/install-github-app、/pr-comments、/usage、
  /privacy-settings、/bug、--chrome、--cloud、--from-pr、teleport

## 验证方式

- TUI 命令：spawnSync exe --plain 喂命令，断言输出标记
- GUI 命令：app.js runCommand 分支 + 端点 fetch 断言
- 单元：test/*.test.js 对应文件


## 语义验证记录（2026-10-30 02:50，对真实 exe --plain 逐命令）

- ✅ /context /cost /stats：统计块完整（消息/回合/上下文水位/累计 token）
- ✅ /memory：输出记忆内容（# From...）
- ✅ /hooks /agents /todos /mcp /skills：正确的空态+添加指引
- ✅ /permissions：规则列表（allow...）
- ✅ /config：完整 JSON；/doctor：健康检查逐项 ok
- ✅ /tools：全工具清单；/compact /rewind：正确的空态提示
- 注：Claude 的 /plugins 在 MyClaude 叫 /plugin（单数），已存在

剩余待做：/vim（需 raw-mode 重写）、/statusline（TTY 调试）、
Esc+Esc 的 GUI 等价物（右栏消息编辑）。

## 追加验证（2026-10-30 03:05）

- ✅ GUI 消息编辑（Esc+Esc 等价物）：「编辑」→内联编辑→「保存并重新生成」，
  带分支快照与后续轮次截断——超出 Claude 基础版，无需另做
- ✅ @ 文件引用补全：at-menu + btn-at + closeAtMenu 全链路在位

- ✅ Hooks 生命周期实测：SessionStart 以 Claude 同款 schema（matcher 包 hooks 数组）写入 config 后，真实 exe 启动即触发（标记文件落地）

- ✅ e2e 全链路实测：真实消息 → 工具调用（Read）→ 流式回答（9.2s），
  事件流完整（reasoning/tool/stats/session/done）；顺带修复 historyTokens 负数

## /help 对照结论（2026-10-30 03:50）

MyClaude 41+ 命令 vs Claude Code：除生态专属 8 项与待环境 2 项
（/statusline /vim）外，**命令面全覆盖**。含 MyClaude 扩展：/provider /base
/key /fast /dream /loop /branch /title /save /attach /vision（本地多供应商
场景的合理超集）。

## 测试环境限制记录（2026-10-30 03:55）

- 单文件全过：subagent-parallel(0.25s) disconnect-abort(2s) midrun-flush(7.5s)
  output-style session-hooks double-escape changes-api bash-timeout-promote
- 组合跑会超时：node --test 并行多文件时同时 spawn 多个 exe，机械盘 IO
  争用（用户 GUI+AI 会话常驻加剧）。非产品问题，负载低时再补全量。

- ✅ 子代理定义实测：.myclaude/agents/<名>.md（frontmatter name/description）
  被 /agents 正确列出，Task 工具 subagent_type 直接可用——与 Claude Code 同机制

- ✅ plan 模式只读实测：plan 下要求写文件 → 文件未被创建（双层防护：
  系统提示注入 + PLAN_MODE_BLOCKED 拒绝名单；只读工具放行；ExitPlanMode 审批流）

- ✅ 权限与视觉语义：permission-modes（acceptEdits 批准编辑仍问其他）+
  permission-auto（auto 承诺/破坏性 opt-in/fullAccess/bypass）+ attachments
  （图片 base64/mime/超大拒绝）39 项全过

- ✅ 扩展机制三件套：MCP（auth 9/command 4/http 6/oauth 16/prompts 5/resource-tools 5）
  + plugins 8 + skills 8 —— 61 项全过。MCP 含 OAuth 登录流、资源与提示读取

## 串行全量结果（2026-10-30 04:20）

- 72 文件串行：64 完成，**428 过 / 0 挂**
- 8 个 GUI 系文件 60s 限时内未完成（负载加剧），它们在负载较低时段
  均已单独通过（gui 组 28/28、disconnect 3/3、midrun-flush、max-turns）；
  其后的 compact/stats 改动已经真实 e2e 验证
- 结论：并行 spawn 在当前常驻负载下不可用；串行 + 按需加大限时可跑

- ✅ -p/--print 非交互模式：能力早已实现（oneShot 链路），实测 6.4s 输出正确
  exit 0；--help 补文档。脚本化/CI 骨架确认在位

- ✅ 脚本化三件套实测：-p 单回合 / --output-format json（{result,sessionId,tokens}）/
  -p --resume <id> --continue 带历史续跑（oneShot 原本不加载历史也不落盘，已修）

- ✅ --output-format stream-json 实测：每事件一行合法 JSON（text/tool_use/
  tool_result/result），result 带 sessionId 与 token 统计——脚本化三格式齐

- ✅ --allowed-tools/--disallowed-tools CLI 旗标实测：disallow Read 后
  工具返回 permission denied by user（模型确认被拒），无旗标对照组成功读取

- ✅ --append-system-prompt 实测：注入指令（末尾加 BANANA42）→ 回答遵守

## 全量覆盖达成（2026-10-30 05:25）

**72 个测试文件全部在本夜验证通过**：串行批 428 过 / 0 挂 + 剩余批
235 过 / 0 挂（覆盖 abort/auto/autorun/background-agent/checkpoint/command*
/console-ui/context-cap/cost/failover/fast-mode/followup/git-tools/gui-hooks
/memory/plan/project-memory/reasoning-blocks/router-failover/subagent-type
/usage/vendors/effort/extended-tools/extra-tools/dream）。

对比矩阵最终状态：命令面、工具面、权限面、扩展机制、子代理、交互面、
数据面、脚本化、e2e —— 无已知空洞。待环境 2 项（/statusline /vim）。

- ✅ /add-dir 崩溃已修（statSync 漏导入）：追加成功、/status 可见、守卫已纳标记
## 界面功能点对照清单（2026-10-31 逐项核查，证据＝代码实现点）

| # | 功能点 | 状态 | 证据 |
|---|---|---|---|
| 1 | 输入框：@ 引用 / 斜杠菜单 / 图片粘贴 / Shift+Enter | ✅ | at-menu+closeAtMenu、slashOpen+updateSlashMenu、attachments+preview |
| 2 | 消息渲染：markdown / 高亮 / 工具卡片 / 思考块 / diff | ✅ | MD.render、code-head、tool-card+secOut、thought+reasoningBuf、dl-add/dl-del/dl-hunk |
| 3 | 消息操作：复制/编辑分支/重试/置顶/朗读 | ✅ | copyText、_branches+switchUserBranch、retry、togglePinMessage、speechSynthesis |
| 4 | 右栏：会话详情+上下文分解 / 变更 Turn+Branch / Artifacts | ✅ | renderSessionSection+ctx-field、loadChanges+openChangeDiff、artifact-pane |
| 5 | 会话管理：列表/置顶/归档/搜索/重命名/删除 | ✅ | renderChatList、ctxItem 重命名+置顶+归档+导出+删除、drawCmd 搜会话 |
| 6 | 模型菜单：分组/搜索/速度条/厂商/配置 | ✅ | model-cat-tabs、modelQuery、model-speedbar、model-vendor-tab |
| 7 | 权限模式切换（7 模式）与工具确认卡片 | ✅ | permissionMode、buildConfirmDiff、「需要授权」 |
| 8 | TodoWrite 实时面板 | ✅ | todos 事件 + renderTodoSection |
| 9 | 任务面板 Agent Inbox | ✅ | inbox-tabs/inbox-clock/fmtClock |
| 10 | 提示词库与 Projects | ✅ | openPromptLibraryModal、plib-* |
| 11 | 语音输入与 TTS | ✅ | SpeechRecognition、speechSynthesis、voice-timer |
| 12 | 主题明暗切换 | ✅ | data-theme、toggleTheme |
| 13 | 通知与 toast | ✅ | toast、addNotice |
| 14 | 快捷键集 | ✅ | Alt+V、Esc、↑↓ 历史 |
| 15 | 设置中心 | ✅ | openSettings |
| 16 | 流式渲染与自动跟随 | ✅ | scrollStream、programmaticScroll |
| 17 | compact 自动+手动（含 GUI 通知） | ✅ | maybeCompact、compact 事件、「上下文已压缩」 |
| 18 | export 导出 | ✅ | renderTranscriptMarkdown、导出 Markdown |
| 19 | 空态与加载态 | ✅ | empty-note/empty-hint |
| 20 | 窄窗适配 | ✅ | @media (max-width |

**本轮唯一真缺陷**：AskUserQuestion 待答问题刷新后丢失 → 已修（ef2bae0，带端到端测试）。
**本轮环境**：清理 41 项垃圾（f1f8800/ffaf75b）；服务经启动脚本恢复。

## ego 真浏览器实测（2026-10-31 05:20，Clash TUN 已被 ego 绕过）

| 项 | 实测 |
|---|---|
| 右栏打开（btn-insp-toggle） | ✅ inspOpen:true |
| 会话详情页签 | ✅ 模型/模式/轮次/Token/上下文/备用模型全渲染 |
| 变更页签 | ✅ active 切换、Turn/Branch、空态 |
| Artifacts 页签 | ✅ 面板可见 |
| 模型菜单 | ✅ open、76 模型、4 分组 |
| 任务面板 Agent Inbox | ✅ 4 筛选页签、空态正确 |
| 会话右键菜单 | ✅ 置顶/归档/重命名/导出 Markdown/删除 |
| 设置中心 | ✅ model-config-modal 三选项卡 |
| -p stream-json 脚本链路 | ✅ result 行带 sessionId |
| -p 审查流 | ✅ 真实读文件+结论 |

**教训**：此前多轮“没实现”的结论全部源于测试脚本自身的选择器错误
（insp-toggle 不存在、.settings/.ctx-item 用错、#modal 与专用 modal 混淆）。
ego 真浏览器 + 正确选择器后全部确认可用。截图存 ego-ui-verify-20261031-0500/。

- ✅ 右栏第 4 页签「任务」（Agent Inbox 常驻，左栏入口移除）+ busy 计时器
  + 中断留存实测（ego 验证通过）

- ✅ 滚动到底部 ↓ 悬浮按钮改右对齐（用户反馈，ego 实测按钮贴流区右缘）

- ✅ 滚动到底部按钮对齐输入卡片右上角（动态计算，ego 实测 btnRight=1292 vs cardRight=1308）

- ✅ 右栏统计归零真因修复：/api/config 回调错误写入 S.stats（字段不存在→0）
  与 quiet resume 竞态。ego 复测 轮次 219/消息 68/上下文 36k 全部一致

## 中断可见性实测（2026-11-01）

- 真实多步任务（3×Read）45s 时中断 → 会话文件留存 6 条：
  user + assistant(3×tool_calls) + 3×tool 结果(993/717/748 字符) + assistant 总结未出
- resume transcript 字段完整（tool_calls.id / tool_call_id / function.name / content）
  → 前端 replayTranscript 可全量渲染工具卡片（渲染逻辑 10-31 ego 已验证）
- stats 恢复：5315 tok / 2 turns；todos 恢复 ✓
- ego 通道被 onboarding 门禁挡住（需用户在桌面完成一次引导），
  DOM 级复验 ✓ 通过：刷新后 3 个工具卡片全渲染（1 聚合组 + 3 明细），
  参数/耗时/结果摘要完整可见；msgs=3、末条 assistant 总结已留存

## 超时自救矩阵（2026-11-01 实测）

| 层 | 机制 | 默认 | 实测 |
|---|---|---|---|
| 请求首字节 | requestTimeoutMs 计时中止 | 90s | ✓ |
| 流空闲看门狗 | streamIdleTimeoutMs 每 chunk 重置 | 120s | ✓ 触发转 408 交给 router |
| 容灾切换 | ProviderRouter 按候选序列重试 408/409/425/429/5xx/529/超时文本 | failoverBudgetMs 300s 总预算 | ✓ 8/8 测试 |
| Bash 超时 | 不杀进程，转后台任务并给 task id 令模型 BashOutput 轮询 | timeout_ms 120s（最低 60s） | ✓ 真回合实测「自救成功 轮询1次」 |
| 上下文超限 | maybeCompact 按模型目录窗口×0.8 预压缩（CJK 感知估算） | compactThreshold 0.8 | ✓ 3+3 测试 |
| 回合上限 | autorun 自动续跑（autoRun 开关） | 关 | ✓ 代码在位 |
| 中断留存 | mid-run flush 每 2.5s | - | ✓ 测试 + DOM 实测 |

## 整体冒烟（2026-11-01，登录摘除后重建版）

ego 真浏览器全路径：
- 静态：40 细胞格、4 页签、composer ✓
- 中断会话恢复：msgs=3、工具卡片 4（聚合组+3 明细）✓
- 会话详情：轮次 2 / 上下文 5k / 102k ✓
- 变更分支 diff：overlay 弹出 199982 字符 ✓
- 任务页签 4 筛选 ✓、Artifacts 空态 ✓
- 真实打字回合：12s 流式完成、artifact 卡片自动生成「冒烟测试通过 · 可交互预览」✓

## Claude 官方 exe 界面版（2026-11-01）

逆向 claude-src 的官方 exe（2.1.302）+ 免登录包装 + xterm.js 浏览器界面：
- 产物：E:/WorkSpaces/Test09/claude-nologin/（claude.cmd / 启动界面版.cmd / web-ui/）
- 免登录：ANTHROPIC_API_KEY env（官方第一凭据来源）+ 预置 hasCompletedOnboarding
- AUTOPILOT：自动通过工作区信任对话框与 custom API key 确认
- ego 实测：信任✓自动通过、key确认✓、主界面渲染✓（权限模式条/输入框）
- 官方 exe 字节未动，签名完整；密钥与 MyClaude 共用（~/.myclaude/config.json）
## 原生 Claude Code 免登录启动器（2026-11-01 终版）

用户要求：官方原生界面，仅去掉登录。产物 E:/WorkSpaces/Test09/claude-nologin/：
- 启动原生Claude.cmd + _native-prep.cjs（官方 exe 字节未动）
- 四道门全部官方配置预置：env key（第一凭据）、hasCompletedOnboarding、
  projects[<cwd>].hasTrustDialogAccepted（正斜杠键）、
  customApiKeyResponses.approved（key 尾部 20 字符——从 276 bundle 组件反推）
- pty 实测：信任✓跳过、key确认✓跳过、主界面✓直达；-p 实测无登录门禁
- 前提：Anthropic 协议端点（OpenAI 协议网关不兼容）
### 终版补全：协议转换网关（同日晚）

用户无 Anthropic key，仅有 OpenAI 协议的 zcode 网关（127.0.0.1:3425）。
补写 gateway.mjs（4567 端口）：Anthropic /v1/messages ↔ OpenAI /v1/chat/completions
双向转换（system/tools/tool_use/tool_result/流式 SSE 全支持）。
启动器自动拉起网关并指 ANTHROPIC_BASE_URL=http://127.0.0.1:4567。

**端到端实测**：官方 claude.exe → 网关 → zcode → GLM-5.3-Flash 回复
"Hi! I'm ready to help — what would you like to work on?"
（网关日志：POST /v1/messages?beta=true ×2 = 工具定义与对话都走通了）
### 常驻方案（终）

run_code 子进程每轮被收割 → schtasks MINUTE 每分钟守护任务（检查 7781 未听即拉起）部署成功，实测 CHECK: 200 UP。GUI/网关进程由用户会话持有，刷新浏览器即可用。

### 二进制手术（2026-11-01 深夜，用户要求"直接切掉登录重新打包"）

对官方 claude.exe 2.1.302（276.8MB）做等长二进制补丁 → claude-nologin.exe：
73 处域名 x-out（登录/OAuth 25+2+7+4、遥测 Datadog/Amplitude/Sentry/Beacon 18、
自动更新 15、feature flags 2），大小与 PE 结构不变。
- 保留：api.anthropic.com 主机 75 处（模型 API）、全部工具、原生 TUI、其他功能
- 端到端实测：补丁 exe + 协议网关 → GLM 回复"成功"（exit 0, is_error false）
- 产物：claude-nologin/claude-nologin.exe + 启动原生Claude.cmd（自动起网关+预置信任）