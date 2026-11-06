# 交接文档（HANDOFF）

> 目的：让任何新的会话（或换了模型之后的会话）能在 5 分钟内准确接手，
> 不重复已做的事、不误判当前状态。**本文档中的所有状态都标注了核实方式。**

## 1. 现在是什么状态

| 项 | 值 | 怎么核实 |
|---|---|---|
| HEAD | 见 `git log --oneline -1` | `git rev-parse --short HEAD` |
| 测试 | **588** 项，全绿 | `npm test` |
| 提示词 | SYSTEM_PROMPT 13,147 / AUTONOMY_SECTION 3,161 字符（autoRun 时实际 21,773） | `npm run inspect:prompt` |
| 内置技能 | verify 正文 10,412 字符 | `node -e "import('./src/skills-builtin.js').then(m=>console.log(m.BUILTIN_SKILLS[0].body.length))"` |
| exe | 构建时间见 `dist\myclaude.exe` | `git status` 与源文件 mtime 比对 |
| 服务 | `--gui --no-open` 在 7788 | `Get-NetTCPConnection -LocalPort 7788` |
| 端到端 | 真发一条消息能答（实测「2+3」→「5」） | 浏览器里发一句话 |

**每次改动后必须做的三件事**：`npm test` → `node scripts/inspect-prompt.mjs` → `node scripts/build-exe.mjs`。
exe 不重打，双击启动的还是旧代码。

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

- `/statusline` — **确实缺**。需要新功能（自定义状态行），不是接线。
- `/vim` — **不做**。上游 2.1.302 已移除该命令（见 `claude-re-2.1.302/07-assets/docs/recent-changes-j2j9vm5c.md`），改由 `/config` → Editor mode。
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
## 7. 五道验证闸门（收尾时全绿）

| 闸门 | 命令 | 通过标准 |
|---|---|---|
| 单元/集成测试 | `npm test` | 588/588 |
| 产物完整性 | `node scripts/verify-features.mjs` | 输出「功能完整性 ✓」 |
| 提示词体检 | `npm run inspect:prompt` | 0 error（七类检查） |
| 构建产物闸门 | `npm run test:smoke` | 46 条命令 0 崩溃（`/exit` 无输出属预期） |
| 端到端 | 浏览器发一句话 | 有回复、无错误条、busy 释放 |

**注意**：`npm test` 的 glob 是 `test/*.test.js`，`*.smoke.js` 需要单独跑 —— 那条曾经写了却从没执行过。

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