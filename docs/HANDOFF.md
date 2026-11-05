# 交接文档（HANDOFF）

> 目的：让任何新的会话（或换了模型之后的会话）能在 5 分钟内准确接手，
> 不重复已做的事、不误判当前状态。**本文档中的所有状态都标注了核实方式。**

## 1. 现在是什么状态

| 项 | 值 | 怎么核实 |
|---|---|---|
| HEAD | 见 `git log --oneline -1` | `git rev-parse --short HEAD` |
| 测试 | 572+ 项，全绿 | `npm test` |
| 提示词 | SYSTEM_PROMPT 13,147 字符 / AUTONOMY_SECTION 3,161 字符 | `npm run inspect:prompt` |
| 内置技能 | verify 正文 10,412 字符 | `node -e "import('./src/skills-builtin.js').then(m=>console.log(m.BUILTIN_SKILLS[0].body.length))"` |
| exe | 构建时间见 `dist\myclaude.exe` | `git status` 与源文件 mtime 比对 |
| 服务 | `--gui --no-open` 在 7788 | `Get-NetTCPConnection -LocalPort 7788` |

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