# 命令分母判定表（R4 重推）

> 目的：命令覆盖率的"本地相关"分母曾按"CLOUD"直觉排除，R4 逐条重推六疑点。
> 证据全部来自上游源码现测（claude-re-2.1.302/02-modules/files/，chunk + 字节偏移），不以 MyClaude 既有文档为依据。
> 判定日期：2026-11-07。复现：node .local/r4-suspects.mjs（脚本随 ADR 归档说明）。

| 命令 | 上游定义证据 | 上游门控 | 判定 | 理由 |
|---|---|---|---|---|
| restart | chunk-e0x0xb6d.js @2195979：`{type:"local",name:"restart",aliases:["update"],description:"Restart Claude Code and keep this session"}` | isEnabled=$en()&&VXo()，$en 要求 stdout/stdin 均 TTY | **回收（本地可实现）** | 纯本地机制：重启进程 + 保留会话。MyClaude 有会话持久化（session restore），技术可实现。TTY 门控是交互环境检测，非云侧依赖 |
| theme | chunk-e0x0xb6d.js @2182394：`{type:"local-jsx",name:"theme",description:"Change the theme",requires:{ink:!0}}` | 无（TUI 内命令） | **回收（本地可实现）** | 纯本地 TUI 主题切换。MyClaude GUI 已实现 /theme（app.js @6104 深浅切换），TUI 未实现——这是**真实缺口**，此前被排除名单掩盖 |
| brief | chunk-bvf35nat.js @5004：`{type:"local-jsx",name:"brief",description:"Toggle brief-only mode",isEnabled:()=>a().enable_slash_command}` | `tengu_kairos_brief_config` 实验配置控制 enable_slash_command | **维持排除（理由修正）** | 原排除理由"云侧"不准确；修正为：上游实验门控（tengu_kairos_brief_config）默认未启用，上游用户默认不可见。MyClaude 不做实验性上游功能不算缺口 |
| feedback | chunk-e0x0xb6d.js @1677942：`{type:"local-jsx",name:"feedback",description:"Send feedback to Anthropic or report a bug"}` | 无 | **维持排除** | 反馈通道指向 Anthropic 服务端，本机无对应接收方 |
| bug | chunk-e0x0xb6d.js @1678123：`{aliases:["share"],type:"local-jsx",name:"bug",description:"Report a bug or share your conversation"}` | 无 | **维持排除** | bug 报告通道是 Anthropic 的（云侧）；share 部分与 MyClaude 自有 /share 重叠，但命令本体是上游反馈通道 |
| stickers | chunk-e0x0xb6d.js @2190573：`{type:"local",name:"stickers",description:"Order Claude Code stickers"}` | 无 | **维持排除** | 上游营销/周边订购（贴纸商店），无本地等价意义 |

## 重推结果（现测）

| 项 | 旧（CLOUD 直觉） | 新（R4 重推） |
|---|---|---|
| 唯一命令 | 108 | 108 |
| 排除 | 46 | **44**（−restart −theme） |
| 本地相关 | 62 | **64** |
| TUI 覆盖 | 62/62 = 100%（虚高） | **62/64 = 97%**（真数：缺 restart、theme） |
| GUI 覆盖 | 62/62 = 100%（虚高） | **63/64 = 98%**（真数：缺 restart；theme 已有） |

> **headline 从 100% 降为 96.9%/98.4%——降下来的这天起它才可信。**
> 两个真实缺口（TUI /restart、TUI /theme）的实现是后续轮次的任务，不在 R4 度量轮内。

## 维持排除的完整清单依据（44 项，R4 抽查 6 项后其余沿用原判定）

云侧/账号/生态类（login/logout/setup-*/usage-*/remote-*/desktop/mobile/chrome/ide 等）与上游专属实验位（brief）。
R4 只重推了六疑点；若后续审计发现更多误排，按本表同格式追加行并更新 metrics。
