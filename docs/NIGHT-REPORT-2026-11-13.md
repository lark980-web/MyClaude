# 夜航报告 2026-11-13：中断修复 + 技能契约 + Computer Use + 控件全校验

> 用户指令：继续完善和拓展功能，所有控件的功能都要校验并完成对应功能；修正任务
> 中途中断与轮数超限自动终止；验证技能安装使用；复刻 Claude 关键技能（computer use）。
> 结果：**892 项 891 绿 + 1 诚实 skip**，gate:full 九步全绿，6 个提交。

## 一、P1 任务中断 / 轮数超限修复（用户主诉）

| 病灶 | 修复 | 提交 |
|---|---|---|
| maxTurns 到顶硬停（轮数超限自动终止） | 上游主循环无回合上限（提取树 grep 证实）——maxTurns 改「检查点」：压缩后继续；maxTurns×4 绝对上限兜底；到顶才如实 maxTurnsReached（autorun 用户续跑接管） | 025bb02 |
| maybeCompact 从未在生产路径调用 | 首次真正接入 runLoop 循环（原先只被测试直接调用——生产死代码） | 025bb02 |
| 单 provider 下一次 429/529/断流即整轮中断 | router 同候选指数退避重试（默认 2 次 1.2s 起），耗尽才走 fallback；AbortError/noRetry 永不重试；**401/403 不做同候选重试**（同 key 等不出结果） | 025bb02 + b666736 |
| 重试静默卡顿 | onRetry 通知上 UI（`provider error (...) — retrying in 1s (attempt 1/2)`） | 025bb02 |

## 二、P2 技能系统（三附件契约 + 两个真 bug）

上游 chunk-e0x0xb6d.js 三附件契约逐字对齐：

| 契约 | 实现 |
|---|---|
| skill_listing | 可用技能清单随请求注入（pendingMeta 机制：不落历史——落了会污染会话标题/计数/transcript）；清单变化重发=热发现；压缩后去重重置 |
| skill_mention | 消息里的 /技能名 → 提示模型调用 Skill 工具（逐字语义"只提及不执行"）；/技能名 不再报未知命令，原文 passthrough（TUI/plain/agent 三层） |
| invoked_skills | Skill 调用体记录，压缩后重放（指南不丢、明确不重执行一次性动作） |

**修复的 bug**：
1. Skill 工具 description 抽到上游注册残渣 `"Execute skill: undefined"`（truthy 导致静态回退永不生效）→ 改上游真实静态描述（dpr 逐字）
2. main.js 被 import 即启动整个 CLI（测试挂死）→ MYCLAUDE_SKIP_MAIN 入口守卫

## 三、P3 Computer Use 复刻（真浏览器 e2e 全链路通过）

上游证据：chunk-1h2r50md.js 的 computer 工具族完整 schema（`_computer-use-full.txt`）。
上游执行宿主是 Claude-in-Chrome 扩展桥 → MyClaude 用 **CDP 直接驱动本机 Chrome/Edge** 达成同一动作面。

- `src/tools/browser-cdp.js`：单 WebSocket flat session（Target.attachToTarget + sessionId 路由）、浏览器自动定位（chrome/msedge/brave + PATH）、`--remote-debugging-port=0` 拉起、进程树清理
- **8 个工具**，schema 上游逐字：`computer`（13 动作：screenshot/zoom/三种点击/拖拽/hover/type/key 组合键+repeat/scroll 四向/wait/scroll_to）、`navigate`（url/back/forward）、`tabs_context_mcp`/`tabs_create_mcp`/`tabs_close_mcp`、`get_page_text`、`resize_window`、`browser_batch`（顺序执行/遇错即停/禁嵌套）
- 注册按 `config.computerUse` 开关（上游语义：只有浏览器会话才暴露 browser 工具）；`/computer-use on|off` + GUI 设置项
- **真浏览器 e2e**：启动 → 导航 data: URL → 截图 PNG magic → zoom 区域 → CDP 点击真实生效（document.title 变 CLICKED）→ 打字/滚动/悬停/等待 → 正文提取

## 四、P4 控件全校验（0 挂死、0 产品缺陷）

| 面 | 结果 |
|---|---|
| TUI 命令面 | 97 个内建命令对真实 Agent 逐个执行：0 挂死、0 抛错（7 个初判 throw 全是手写审计桩缺方法）；restart/update 单列（spawn 后 process.exit） |
| GUI 端点 | 23 端点冒烟全 200（1 个 400 是冒烟脚本字段名用错，非产品缺陷） |
| 固化 | test/command-surface.test.js：新命令自动被正则扫进覆盖面 + 3s 挂死超时 + /computer-use 开关断言 |

## 五、gate 排障两例

1. TTY `cfgPanelSeen:false` → 旧 exe 未含 403 快速失败修复 → 重建后全绿
2. vim-cdp FAIL → 杀软锁临时目录 EPERM（验证本体 15 项已全 ok）→ 清理容错

## 六、复测方式

```bash
npm test                                # 892 项 891 绿 + 1 skip
npm run gate:full                       # 九步全绿（exit 0）
node scripts/verify-tui-tty.mjs         # {"welcome":true,"sawTyped":true,"cfgPanelSeen":true}
node --test test/computer-use.test.js   # Computer Use 7 项（含真浏览器 e2e）
node --test test/skills-e2e.test.js     # 技能三附件契约 8 项
node --test test/command-surface.test.js # 命令面 97 命令
node .re/audit-commands.mjs             # 命令审计 → _audit-result.txt
node .re/audit-gui.mjs                  # GUI 冒烟 → _audit-gui.txt
```

## 七、提交清单

025bb02 fix(agent) 回合检查点+退避重试 → P2 技能三附件 → P3 Computer Use →
test(commands) 命令面固化 → b666736 fix(gate) 403 重试+EPERM
