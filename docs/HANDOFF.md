# 交接文档（HANDOFF）

> 目的：让任何新的会话（或换了模型之后的会话）能在 5 分钟内准确接手，
> 不重复已做的事、不误判当前状态。**本文档中的所有状态都标注了核实方式。**

> **接手先读 `docs/EXECUTION-PLAN.md`（v2 轮次制）**：五条铁律 → §1.1 六步启动仪式 → §8 状态行取任务 → 按轮次卡执行。每卡自包含（目标/输入锚/步骤/验收/禁止），gate 定红绿，状态 = §8 行 + git + gate-metrics，不依赖任何会话记忆——换模型不影响执行。

## 1. 现在是什么状态

| 项 | 值 | 怎么核实 |
|---|---|---|
| HEAD | 见 `git log --oneline -1` | `git rev-parse --short HEAD` |
| 测试 | **717** 项，全绿（测于 2026-11-07 via `npm run gate:fast`；高水位基线在 test/gate-metrics.json） | `npm run gate:fast` |
| 提示词 | SYSTEM_PROMPT 21,391 常量（7 段全部迁移）；组装现测 autoRun=false **24,527** / autoRun=true **27,690**，19/20 段，0 error | `npm run inspect:prompt`（测于 2026-11-07） |
| 内置技能 | verify 正文 10,412 字符 | `node -e "import('./src/skills-builtin.js').then(m=>console.log(m.BUILTIN_SKILLS[0].body.length))"` |
| exe | 构建时间见 `dist\myclaude.exe` | `git status` 与源文件 mtime 比对 |
| 服务 | `--gui --no-open` 在 7788 | `Get-NetTCPConnection -LocalPort 7788` |
| 端到端 | 真发一条消息能答（实测「2+3」→「5」） | 浏览器里发一句话 |

**每次改动后**：`npm run gate:fast`（单测[趋势断言] + 提示词体检 + 功能 marker，一条跑完）；改了 src/ 再 `npm run build:exe`——exe 不重打，双击启动的还是旧代码；轮末涉 UI/构建跑 `npm run gate:full`。

## 2. 已经做完的（有提交可查）

| 提交 | 内容 |
|---|---|
| `b0f108a` | 按 Claude Code 2.1.302 对齐：提示词六段结构、内置 verify 技能、委派纪律、Anthropic provider（Messages API + prompt caching）、Shift+Tab 模式轮转 |
| `bd0239d` | 记录并发进程覆盖源码的事故 |
| `2202df7` | 项目内存按真实路径去重（此前每轮请求重复加载 MYCLAUDE.md，白多 4KB） |
| `e5c7c6d` | `scripts/inspect-prompt.mjs`：系统提示词体检，七类检查 |
| `9842e45` | verify 技能补 CLI/HTTP/GUI/TUI/库 五类表面 playbook |
| `48074ba` | 自主段扩为循环工作口径（What to act on / How far to go / When idle） |

## 3. 真正还没做的（已核实，勿信旧 backlog）

命令面实测（`src/main.js` 的 case + `src/ui/web/js/app.js` 的 handlers）：

- `/statusline` — ✅ 已做（`1f2d305`，按上游 stdin 契约真执行外部命令）。
- `/vim` — ✅ 已做（TUI 输入框 vim 键位，`src/ui/vim.js` 纯状态机 + `ink-app.js` 接线；
  上游 2.1.302 把 /vim 并入了 /config → Editor mode，本项目保留开关并真生效，
  同时写上游真键 `editorMode` 与兼容键 `vimMode`）。
- `/sandbox` — **不做**。本项目有意用命令分级替代沙箱（见 `docs/PERMISSION-MODEL.md`）。
- `/output-style` — 已实现；注意上游已把它并入 `/config`，属已知差异，不是缺陷。

其余待办（非命令面）：

- Esc+Esc 编辑上一条消息（TUI）+ GUI 等价物
- 消息目录只列「已渐进渲染」的消息，长对话目录不完整
- 右栏「备用模型」空池时的禁用态文案
- 提示词库 / Projects 模态框仍是旧视觉语言
- Anthropic 真实 API 未实测（本机无 `ANTHROPIC_API_KEY`）

## 4. 关键约束（都是踩过的坑）

1. **exe 与源码是两回事**。改完源码不 `npm run build:exe`，双击启动的还是旧代码。
2. **构建偶尔 EPERM**。89MB 产物被杀软瞬时锁住；重试即可，不是代码问题。锁住时连 `Start-Process` 都会失败。
3. **测试全绿不代表功能正常**。`test/smoke-commands.smoke.js` 需要 exe，用 `npm run test:smoke` 单独跑；`npm test` 的 glob 是 `test/*.test.js`。
4. **提示词要按运行时验证**。读源码加断言只能证明「写了什么」。`npm run inspect:prompt` 转储真实组装结果并做七类检查。
5. **Windows 大小写不敏感**。`MYCLAUDE.md` 与 `myclaude.md` 是同一文件；任何「多个候选文件名」的去重都必须按 `realpathSync` 而非字面路径。
6. **测试里的 HOME 必须隔离**。`process.env.MYCLAUDE_HOME` 要在**动态 import 之前**设置；静态 import 会被提升到赋值之前，隔离失效。
7. **本仓库可能被别的进程同时修改**。曾有并发进程在 01:34:10 覆盖了 4 个源文件。改完尽快 commit。
8. **不要开可见浏览器**。验证界面用无头 CDP（`--headless=new --remote-debugging-port=9333`），用完关掉。

## 5. 逆向产物在哪、怎么用

- `E:\WorkSpaces\Test09\claude-re-2.1.302` — Claude Code 2.1.302 全量提取（2683 模块、2433 明文 JS、22934 条依赖边、双路径交叉验证）。
- 入口：`REPORT.md`（总览）、`03-features/`（工具/权限/架构）、`04-prompts/`（提示词）、`07-assets/docs/`（244 个资产正文）、`docs/claude-code-2.1.302-parity.md`（本项目的对齐记录）。
- 旧产物 `claude-src`（2.1.276）**依赖图是断的**（75% import 无法解析），只能用来看字符串常量，不要用它做模块级判断。

## 6. 接手时建议的第一件事

```bash
npm test                      # 确认基线全绿
npm run inspect:prompt        # 确认提示词健康
git log --oneline -6          # 看最近做了什么
```

然后读 `docs/iteration-backlog.md` 的最后一节（最新轮次在最上面），按其中未打勾项继续。
## 7. 验证闸门（R1 起一条链）

| 闸门 | 命令 | 内容 |
|---|---|---|
| **gate:fast**（每轮必经） | `npm run gate:fast` | 单测（高水位断言，回退即红）→ 提示词体检（errors=0）→ verify-features marker |
| **gate:full**（轮末，涉 UI/构建时） | `npm run gate:full` | fast + build:embed/exe → smoke → 目录/工具卡 CDP → GUI vim CDP → 真 TTY |

- 证据：每次运行全量日志落 `.local/gate/<runId>/`；基线 `test/gate-metrics.json` 随仓库提交。
- **跳过 gate = 必须改 package.json**——跳过本身留下证据。
- 反向验证由 test/gate.test.js 锁死：marker 缺失/测试数回退/基线损坏/缺脚本/prompt error 全部红。
- 注意：TTY 步依赖 winpty（Git Bash 自带，当前不在 PATH——需从 Git 的 usr\bin 目录运行或补 PATH）。

## 8. 这一系列改动留下的设计决定

1. **提示词按上游六段结构**，但内容本地化：`TaskCreate`→`TodoWrite`、`CLAUDE.md`→`MYCLAUDE.md`、不冒用 `You are Claude Code` 身份。
2. **自主段只在 `autoRun` 时注入** —— 普通交互里说「不必确认」会与用户的即时确认预期冲突。
3. **不做的三件事**：`/vim`（上游已移除）、`/sandbox`（有意用命令分级替代）、`isReadOnly`/工具 schema 还原（产物不可得）。
4. **token 估算 CJK 感知**，三处共用一份口径；前端保留同公式副本并有测试锁死一致性。
5. **所有去重按真实路径**，不按字面路径 —— Windows 大小写不敏感，`A.md` 与 `a.md` 是同一文件。
## 9. 环境陷阱（2026-11-06 实测踩到，会咬人）

**git 不在 PATH 里，但它没丢。** `HKLM\SOFTWARE\GitForWindows` 记录 `InstallPath=F:\Tools\Git`（2.47.0），
二进制就在 `F:\Tools\Git\cmd\git.exe`。Machine PATH 里**有** `F:\Tools\Git\cmd`，但 agent 进程的
环境快照里没有，只剩一条指向**不存在目录**的陈旧条目 `f:\Program Files\Git\cmd`。
表现是 `git` 时好时坏 —— 一度让我以为仓库坏了。

- 可靠做法：用完整路径 `F:\Tools\Git\cmd\git.exe`，或每次调用先 `$env:PATH += ';F:\Tools\Git\cmd'`。
- 仓库 `.git` 全程完好（HEAD/refs/objects 正常）。**git 命令不可用 ≠ 数据有问题**，先查路径再下结论。

**杀软会打断工具调用。** 本机同时跑 Windows Defender 与 360 全家桶
（`360sd` / `360rp` / `360tray` / `ZhuDongFangYu`）。2026-11-06 11:37:25 Defender 记录
`Trojan:PowerShell/Powdow.RRA!MTB`，命中对象是**命令行本身** —— 一个
`$b64='...'; Invoke-Expression [Text.Encoding]::UTF8.GetString(...)` 的 pwsh 调用。
（Defender 会把 CmdLine 当资源来匹配，这是它自己的检测类型。）

- **教训：排查脚本要落成文件再执行**（`.mjs` / `.ps1`），不要用 base64 + `Invoke-Expression` 内联。
  同一天两个子代理：一个把 18 个分析脚本落成 `.mjs` 文件跑，零告警；
  另一个用 base64+IEX 内联跑测试，脚本被当成木马命中。
- 检测时间（11:37:25）与 git 失效时间吻合，但**因果未证实** —— Defender 隔离区为空，
  360 恢复区里也没有 git。如实记为「时间相关，机制未知」。

**`C:\.git` 盘根仓库（2026-11-07 实测咬人）。** 盘根 `C:\` 下存在一个 `.git`
（来源不明，疑似某工具误初始化）。git 的目录向上搜索让 **C: 盘所有目录都「在 git
工作树内」**，包括 mkdtemp 出来的临时目录。后果：`test/changes-api.test.js` 的
「non-git 目录降级」用例把临时目录判成了工作树内，服务端走到 diff 才失败，
分类成 `git-failed` ≠ 期望的 `non-git` —— **这是环境性失败，不是代码回归**。
换到 D: 盘的临时目录（或删掉 `C:\.git`，需先确认里面没有别人要的东西）即可让该用例恢复绿。
## 10. 原生引擎（/engine）与复刻度量

**/engine 的连续会话**（2026-11-06 起）：

- 上游原生支持 `--resume <session-id>`；引擎模块按 **MyClaude 会话键**绑定上游 sessionId，
  存在 `~/.myclaude/engine-sessions.json`（或 `MYCLAUDE_HOME`）。
- GUI 与 TUI 都会自动带上已有绑定 → 连续追问同一件事时上下文是连着的。
- `/engine reset` 解绑（开新会话）。
- 上游会话失效（报 `No conversation found with session ID`）会自动改开新回合并在结果里标注。

**复刻度量**：`node scripts/parity-metrics.mjs`（加 `--json` 输出机器可读）。

- 上游侧数据**运行时取**（bun 执行上游 `getBuiltinCommands()`），不用手抄清单当分母。
- 同时报两个口径：全量 133 个内置命令 / 本地相关 81 个（排除云侧、账号、生态类）。
- 也报工具契约采用数、上游工具条目数、上游代码规模。

> 需要 bun 与 `B:` 虚拟根映射（见 §9）；缺任一则上游侧标记为不可用，脚本**不会用旧数字凑数**。
## 11. 执行后端切换（2026-11-06）

MyClaude 的主对话 `/api/chat` 现在可切换执行后端：

- **GUI**：输入框内「自研 / 原生 Claude」两段开关（默认自研）。
- **配置**：`POST /api/config {engineBackend: "upstream"}` 持久化；
  `GET /api/config` 回传当前值。
- **环境变量**：`MYCLAUDE_ENGINE_BACKEND=upstream` 临时覆盖（不改用户设置）。

切到 upstream 后，界面正常聊天但底下跑的是原生 Claude Code 2.1.302：
上游 stream-json 由 `src/engines/upstream-chat.js` 翻译成 MyClaude SSE 事件，
回合文本写进 MyClaude 会话（`engine: "upstream"`），上游 sessionId 按 `--resume` 绑定。
默认 `self` 保持自研 agent，零回归。

> 前提：bun 与 `B:` 虚拟根映射（见 §9）；缺任一则上游不可用，`/api/config` 仍会显示 upstream 但回合会报错。