# 执行决策记录

## R1：安全恢复与度量口径（2026-11-07）

- 原计划：测试失败或状态不明就整仓 checkout。发现：工作区已有大量其他会话产物及 HANDOFF 修改。决定：禁止自动整仓回滚；保存状态、定位失败，只改本轮所属文件，无法判定归属则停下报告。理由：测试失败不是销毁未提交工作的授权。
- 原计划：gate 尚未实现却要求启动先跑 gate。决定：R1 为引导阶段，先读现有 scripts 并运行基线；后续轮次使用新 gate。
- 原计划：full 写三套 CDP，但明确列名只有两套。决定：接已有 verify-catalog-toolcard 与 verify-gui-vim，不虚构第三套；build 在 smoke 前，防止测旧 exe。
- 原计划：excluded 单独去重仍要求 133−81 闭合。发现：重复来自上游注册条目，不是 Set 排除名单。决定：保留原始注册计数及重复诊断，所有覆盖率统一按唯一命令名统计；不在 R1 改排除语义（留 R4）。
- 反向验证：使用隔离 fixture 模拟 marker 缺失/测试数量下降，不破坏真实代码或用户测试。
- 测试数仅是退化信号，不等于行为完备性；失败/skip/零测试不得生成通过基线。

## R1 结果（2026-11-07，测于 via npm run gate:fast）

- **gate:fast 三步全绿**：单测 → 提示词体检（errors=0）→ 功能 marker。基线 testCount=**717** 落盘 test/gate-metrics.json（随仓库提交，新会话可凭 git 验证）。
- **反向验证（隔离 fixture，9/9 绿）**：marker 缺失→红；测试数回退（3<4）→红且基线不被覆盖；基线损坏→原文件保全、不自愈变绿；缺脚本→红而非跳过；prompt errors≠0→红；TAP 空摘要/零测试/skip/fail→全部拒绝。未触碰真实源码。
- **命令覆盖唯一名口径（现测）**：上游 133 条注册 → **108 个唯一命令**（24 个名字有重复注册，ultrareview×3）；本地相关 **62**（旧口径 81 含重复计数，虚高 19），排除 46（旧 52 含 6 个重复注册）。TUI/GUI 覆盖率仍 100%，但分母首次诚实。**46 个排除项的判定本身未动，留 R4 重推。**
- **gate:full 链已接线**：fast + build:embed/exe → smoke → catalog-cdp → vim-cdp → tty（build 在 smoke 前，防测旧 exe）。端到端结果见下一条。

## R1 gate:full 端到端（2026-11-07 实测）

- 前六步全绿：tests(717) → prompt → features → build-embed → build-exe → smoke；**catalog-cdp 红在第 6 步**：14/14 行为检查全 ok（目录/工具卡/live/0 异常），但脚本收尾 `rmSync` 临时 Chrome 目录 EPERM（杀软锁，HANDOFF §4.2 已知环境行为）→ exit 1。闸门按设计拒收。**缺陷在该脚本自身清理逻辑，已记 iteration-backlog，下轮处置；gate 链与拒收行为本身正确。**
- vim-cdp 未执行到（链在 catalog 处停）；单跑留待修完 catalog 清理后。
- **TTY 单独验证通过**：winpty 在 F:/Tools/Git/usr/bin（不在 PATH），gate.mjs 已按 `MYCLAUDE_GATE_WINPTY_DIR` 或默认路径为 tty 步注入 PATH；真 pty 四项 {welcome:true, sawTyped:true, cfgPanelSeen:true, cleanExit:true}。注意 TTY 脚本自身全 false 也 exit 0——gate.mjs 的行为断言补住了这个洞（不改脚本内部逻辑）。
- **已知竞态**：gate:full 先 build-exe 再 TTY，杀软可能瞬时锁新 exe（实测发生一次，重试即过）——full 链偶发红属环境，重跑前先确认无 myclaude 进程残留。

## R1 补遗 + R2（2026-11-07）

- **R1 补遗**：package.json 的 gate:fast/gate:full 在首次提交后被并发进程还原（HEAD 与磁盘均无），`npm run gate:fast` 一度不存在。已补回并单独提交（1890042），npm 实测三步绿。教训再证 HANDOFF §4.7：改完尽快 commit，多文件拆两次提交也要每次立即提交。
- **R2 完成**：锚验通过（v2-full 030d9f7e4ed0 / dynamic-sections c042647072e2）；从 _assembly-fn.txt 枚举 24 个 mm() 注册 − 7 实验段 = 17 行为段注册（ffr 与 env_info 段名全为插值/变量，拆分后 18 行）写入 docs/prompt-gated-eval.md；system-prompt-parity.test.js 删除过期 10,707 数字密度断言的旧锚（改为区间断言），新增两条：①v2-full sha256 前 12 位锚（上游一动即红，红=重跑 R2）②评估表 18 行无空白机检。parity 12/12、gate:fast 全绿。
- **R2 判定结果**：迁移 5（task_continuity / tool_param_json / context_management / act_dont_rederive / delivering_work_max）+ 部分 1（session_guidance 静态子句）+ 不迁移 8 + 不可得 4。R3 依此落地，先补抽 delivering_work_max 的 plain 变体 Hfr。

## R3 迁移落地（2026-11-07，测于 via npm run inspect:prompt + gate:fast）

- **证据勘误（重要）**：R2 的字面量长度有 3 处污染值——非贪婪正则把 minified 源码里**逗号续声明**（`var a="…",b=`…``）的相邻变量连带。转义感知扫描器修正：tool_param_json 496→**117B**、act_dont_rederive 3742→**277B**、delivering_work_max plain 未定位→**2017B**；并意外定位了 R2 判"不可得"的 pronouns(357B) 与 overcorrection(1245B)。评估表已勘误。教训：**长度数字必须来自转义感知的精确扫描**。
- **session_guidance 改判不迁移**：静态子句依赖上游 `!` 输入框前缀机制（会话内执行 shell 并回灌输出），实测 MyClaude 无对应（grep src 零命中）——照搬会教模型建议不存在的功能。
- **迁移 5 段**（plain 变体、逐字、无上游专属引用需本地化）：task_continuity(457B) 与 act_dont_rederive(277B) 进 # Doing tasks bullets；tool_param_json(117B) 进 # Using your tools；context_management(280B) 与 delivering_work_max(2017B) 为独立段。SYSTEM_PROMPT 16,619→19,783 常量；组装现测 22,919（autoRun=false）/ 26,082（autoRun=true）。
- **验收**：inspect:prompt 0 error（size 预算 24,000→28,000，因迁移后 autoRun 组装 26,082 与上游 v2-full 24,476 同量级）；parity 新增 5 条逐字子句断言 + 密度区间 12,000–22,000；gate:fast 三步全绿。
- **并发观察**：迁移脚本首跑锚点失配——R3 开头读到的 prompt.js 是并发会话的瞬时状态（Using your tools 长版），git 对照后以 HEAD 为准重跑成功。再证：**锚定写入前先 git status 校验基线**。
- **延期项**：pronouns(357B) / overcorrection(1245B) 已定位未迁移（一轮一任务），下一轮落地。

## R4 分母重推（2026-11-07，测于 via node scripts/parity-metrics.mjs --json）

- **六疑点逐条判定**（证据全部来自上游源码 chunk+偏移，见 docs/command-denominator.md）：**restart 回收**（纯本地：重启进程保留会话，TTY 门控是环境检测非云侧）；**theme 回收**（纯本地 TUI 主题；MyClaude GUI 已实现 /theme，TUI 缺——真实缺口此前被排除名单掩盖）；brief 维持排除但理由修正（上游实验门控 tengu_kairos_brief_config 默认关闭，非云侧）；feedback/bug/stickers 维持排除（理由修正为准确表述）。
- **真数**：本地相关 62→64，排除 46→44；TUI 62/64=**97%**、GUI 63/64=**98%**。**headline 从虚高的 100% 降为真数——降下来的这天起才可信。**
- **防回退**：test/command-denominator.test.js 断言 restart/theme 不得回到排除集 + 六疑点行齐全。
- **暴露的真实缺口**：TUI /restart、TUI /theme、GUI /restart——实现属后续轮次，不在度量轮内。
- **执行事故（小）**：回收 theme 时两次 edit 锚错（多行假设错、相邻项猜错），grep 实际文本后修正——再证写入前先读实际文本。
- **gate 环境噪音（R4 验收期间两次）**：第 1 次红在 fork.test.js（EPERM rename 临时文件，杀软锁）；第 2 次红在 anthropic-provider-e2e（exitCode 0xC0000409 原生层崩溃）；**两案单独跑均绿**，第 3 次全量 gate 全绿。判定：环境瞬时问题（HANDOFF §4.2 已知模式），非代码回归。处置规则：gate 红且怀疑环境噪音时，先单跑失败用例复验，单跑绿 + 重跑全量绿 = 通过（全程留 .local/gate 日志为证）。**gate 本身不加 skip——环境噪音靠复验处置，不靠放宽闸门。**

## R5 权限模型抽取（证伪轮，2026-11-07）

- **产物**：claude-re-2.1.302/03-features/permissions.md——6 模式枚举、模式→判定映射（auto→classify / bypass→allow / **dontAsk→deny** / 其他→ask）、bypass 三重门、settings 两键（defaultMode / disableBypassPermissionsMode:"disable"）、规则语法（Bash(git *) 形式 + 运行时剥离清单）、dangerouslyDisableSandbox 参数级语义、子进程 env scrub 联动。全部带 chunk+偏移。
- **最重要发现**：上游 dontAsk 的判定结果是 **deny**（不问即拒），不是静默允许——若 MyClaude 语义相反则是对齐缺陷（已列入对照表待验证，不在本卡改代码）。
- **纪律执行**：未尽项 5 条（allow/deny 数组 schema、规则匹配器内部、Bash 危险命令清单、sandbox 本体、tF 语义）有搜索入口但无定义级证据，**全部如实列为 R5.5 候选，未猜测填写**。
- **证伪轮铁律执行**：全程未读 MyClaude 的 docs/PERMISSION-MODEL.md（被告不参与判决）；对照表仅声明"待验证"。

## R5.5-a dontAsk 语义对照 + R6 扩展体系（2026-11-07）

- **R5.5-a（10 分钟验证）**：MyClaude modes.js 的 dontAsk 描述"不再提问 / 需要确认的一律拒绝"——与上游 IBt 的 deny 语义**一致**，R5 标记的高风险差异点排除。新发现待验证点：MyClaude bypassPermissions 保留 deny 规则（"跳过确认（deny 规则仍生效）"），上游 IBt 字面为全放行——bypass 模式下 deny 规则是否仍评估需进一步证据，已记入 permissions.md 对照表。
- **R6**：extensions.md 从 1,183 字节重写为带证据规格——hooks 配置结构（matcher+hooks[]）、**matcher 仅匹配工具名不能按命令内容过滤**（上游自述）、命令变量 CLAUDE_* 白名单、PreToolUse 阻塞语义、plugin.json 位置（.claude-plugin/）与组件目录、MCP 双传输 zod schema（stdio: command+args / http: url+headers+oauth）、OAuth token exchange 与两种 secret 传递。未尽 4 项如实列出。skills 引用 07-assets/skills.md 不重做。

## R7 运行时观察（2026-11-07，部分完成——凭据受限）

- **已完成**：三次真实上游 CLI 转录落盘（凭据失败三路径：假 key / OAuth 过期 / 本地代理格式不符）；观察到 synthetic 响应路径的稳定行为（`model:"<synthetic>"`、`subtype:"success"`+`is_error:true` 微妙组合——subtype 说 success、is_error 说错，翻译器必须采信后者）；**翻译对照验收 3/3 分类正确、0 unhandled、sessionId/isError 正确捕获**。
- **既有真模型证据引用**：HANDOFF §11（11-06 带凭据实测）的完整 SSE 事件序 + 思考面板 + 工具卡渲染，覆盖 tool_use/tool_result 往返。
- **阻塞声明（如实）**：真模型工具调用会话本机当前不可得（OAuth 过期 + 无 key + 代理 OpenAI 格式）。解除条件：上游 CLI /login 或提供 Anthropic 格式端点。**不以 synthetic 会话冒充真模型观察。**
- **执行事故（小）**：录制脚本三处笔误连改（导入路径/变量名）——每处都是跑一次才暴露，脚本类产物首跑前应 node --check。

## R7 附带：修好一个空转假绿的并发测试（2026-11-07）

- **发现路径**：gate 连续四次红在四个不同测试（fork EPERM / e2e 0xC0000409 崩溃 / subagent-parallel 计时 / turn-files 崩溃），单跑均绿——表面是环境噪音，深挖 subagent-parallel 时发现**旧断言从未验证过并发**。
- **根因**：测试 mock 的 isSubAgent 判定用 `String(system).includes("Sub-agent mode")`，但 (a) Agent 把 system 拼进 messages（agent.js @427），(b) OpenAI provider 的 streamChat 解构里根本没有 system 字段（openai.js @170）——判定恒 false，3 个子任务的 sleep 从未发生，`elapsed<700ms` 测的是框架开销。单跑快→假绿，负载慢→假红。
- **修复**：判定改为在 messages 里找 role:"system" 且含 "Sub-agent mode"（匹配真实数据流）；断言改为**执行窗口重叠证明**（3 个子任务的 [start,end] 区间存在共同重叠 = 真并发，与负载无关）+ 30s sanity 上界。修复后 864ms 通过（3×300ms 并发 + 框架开销，数学合理）。
- **gate 加固**：tests 步加 `--test-concurrency`（默认 4，MYCLAUDE_GATE_TEST_CONCURRENCY 可覆盖）——高并发下 0xC0000409 原生崩溃消失。
- **教训**：连续红在不同测试 + 单跑全绿 ≠ 纯环境噪音，可能混着坏测试；时序断言（elapsed<Nms）在并发套件里天生脆弱，测并发性应该测**重叠**而不是**时长**。

## R8 trailer 哈希：正式放弃（2026-11-07）

- **尝试**：7 种哈希函数（djb2/fnv1a/sdbm/murmur3/md5/sha1/sha256）× 名字/内容 × 多变体，全部 0 命中。分布分析排除偏移/长度编码（值不等于任何 contentLen/contentOff/bcOff/bcLen；升降序 ≈ 随机）。与注册表 hash 字段不同源（交集 1/2423）。
- **阻塞**：Bun 源码不可达（GitHub raw 5 路径全 404；web_search API key 失效）。
- **放弃理由**：无源码无法确证算法，猜测被计划规则禁止。值域上限 ~16.7M 暗示可能是 wyhash/xxhash 截断或 Bun 自定义哈希——但这是推断不是结论。
- **保留**：原始字节 trailer.bin + 分段结构（payload-forensics.md）+ 尝试脚本（.local/r8-*.mjs）。详见 claude-re-2.1.302/01-artifact/trailer-hash.md。

## 剩余项收口（2026-11-08）：catalog 修复 + bypass/deny 验证 + 三命令补齐 + gate:full 首绿

- **catalog-cdp EPERM 修复**（895f2a3）：verify-catalog-toolcard.mjs 清理改 rmResilient（退避重试 + 残留锁降级警告）；13 项行为检查全过、exit 0。gate:full 不再卡此步。
- **R5.5-b bypass/deny 验证**（6bdea31）：上游证据链——规则匹配器 zce（chunk-e0x0xb6d @923379）deny 命中返回硬 behavior:"deny"（type:"rule"）自身不查模式；逐工具模式处理器 SFt/at 对 bypass 返回 passthrough + "handled in main permission flow"（不在规则前短路）。MyClaude agent.js askPermission 先 evaluate（deny→false）后 bypass→true，顺序一致。回归测试 2/2。
- **三命令补齐**：/theme（TUI：config.theme 持久化 + 状态行指示 + light 深橙强调色 + /config 行；3/3 测试）；/restart + /update 别名（src/restart.js：restartArgs 保留旗标替换 --resume + performRestart detached 重启；TUI case + GUI /api/command 桥；4/4 测试）。**现测 TUI 64/64=100%、GUI 64/64=100%，零缺失**——R4 回收后的真缺口闭合，100% 这次是挣来的。
- **gate:full 首次全 9 步绿**：tests→prompt→features→build-embed→build-exe→smoke→catalog-cdp→vim-cdp→tty。修了两处链缺陷：catalog 清理 EPERM（上述）+ build-exe 后杀软瞬时锁新 exe（error 0x20）撞 TTY——加 build settle（默认 3s，MYCLAUDE_GATE_BUILD_SETTLE_MS 可调）。
- **纪律**：每步 gate 验证；环境竞态（杀软锁）靠 settle/重试处置而非放宽闸门；所有数字现测。

## 自检自测补强（2026-11-08，回应"自检自测都做了吗"）

- **自检发现的薄弱点（诚实）**：上轮 theme/restart 测试多为"源码含某字符串"的存在性断言，非行为测试；/restart 只用注入 spawner 测了参数构造、没真重启；/theme 没在真 TTY 看过渲染。本轮补真行为验证。
- **/theme 真 TTY 行为**（.local/verify-theme-tty.mjs）：winpty 真终端里输入 /theme light → 欢迎屏✓、"主题→light"消息✓、状态行出现 "· light ·"✓、config.json 持久化 theme=light✓。
- **/restart 真进程行为**（.local/verify-restart-*.mjs）：-p 播种会话(2消息)→TUI --resume 恢复(状态行 "2 msg")→/restart→"重启并恢复会话"消息✓、原进程退出✓、tasklist 证实新 myclaude.exe(Console)存活✓。期间一度误判"新进程没出现"——实为 Get-Process 查询时机问题，tasklist 纠正。
- **自检发现的真实加固点**：restart 原 stdio:"inherit" 让重启子进程继承父终端，父进程(winpty)退出可能拆毁它；改 stdio:"ignore" 让 OS 给新控制台，真正独立。隔离测试证明 detached 机制正确（子进程存活写标记）。
- **gate 再加固**：catalog-cdp 复发 spawn EBUSY（杀软锁新构建 exe，smoke 之后）——gate 对 exe 启动步（smoke/catalog/vim/tty）加 EBUSY/EPERM 退避重试（4 次）。gate:full 复跑全 9 步绿。
- **结论**：行为级自检补上了存在性断言测不到的东西（真渲染、真重启、真持久化），并揪出 stdio inherit 的真实健壮性缺口。存在性测试保留作快速回归，行为验证作深度确认。
