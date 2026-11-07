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
