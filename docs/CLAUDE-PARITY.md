# MyClaude vs Claude Code 功能对照

> **对照依据**：`E:\WorkSpaces\Test09\claude-src`（Claude Code 2.1.276 逆向产物，1554 个模块）
>
> **重要：代码不可直接复用**。实测确认三个硬障碍：
> 1. 1554 个模块**全部**带 `@bytecode` 标记（Bun 预编译产物）
> 2. import 路径指向 `B:/~BUN/root/` 虚拟根，真实文件系统不存在
> 3. 核心逻辑（认证/遥测/marketplace）绑定闭源运行时
>
> 正确用法：**提取功能规格，重新实现**。

生成时间：2026-10-20 ｜ 最后更新：2026-10-23（本轮新增 /effort /fast /status /title /fork /branch，/memory 支持写入） ｜ 数据来源：源码静态分析

---

## 一、工具（Tool）

Claude 的基础工具集（从 `allowed_tools` 与 schema 定义确认）：

`Bash / Read / Write / Edit / Glob / Grep / Task / WebFetch / WebSearch / TodoWrite / NotebookRead / NotebookEdit / ExitPlanMode / AskUserQuestion / BashOutput / KillShell`

| 项 | Claude | MyClaude | 差距 |
|---|---|---|---|
| 工具数量 | 21 | 21 | ✅ 对齐 |
| Bash | 支持沙箱、`dangerouslyDisableSandbox`、超时自动转后台、输出持久化 | 基础执行 + 大输出落盘（超 30000 字符写入临时文件，回退路径保留） | ⚠️ 无沙箱（Claude 在 Windows 上也无，见下） |
| Grep | ripgrep | ✅ 已接 ripgrep（无 rg 自动回落 JS） | ✅ 对齐 |
| Task | 10 种任务类型（见下） | 6 种（local_bash/local_agent/mcp_task/monitor_mcp/monitor_ws/workflow） | ⚠️ 缺 auto_mode_scan / dream / in_process_teammate / yank
| 权限提示 | 带 diff 预览 + 「不再询问此命令」 | ✅ diff 彩色预览 + 不再询问 | ✅ 对齐 |

## 二、任务体系（Claude 的核心架构差异）

Claude 的任务类型（从 `964_chunk-0qdm07jf.js` 的 case 分支实测）：

```
local_bash           后台 shell
local_agent          子代理任务
local_workflow       工作流
mcp_task             MCP 调用
monitor_mcp          MCP 连接监控
monitor_ws           WebSocket 监控
dream                后台整理记忆
auto_mode_scan       自动模式审查（reviewer model 扫描动作）
in_process_teammate  进程内队友
teammate             队友
remote_agent         远程代理
```

> 订正说明：早期把 `yank / yanked` 列为任务类型是误读。实测它们是
> Vim 模拟器的 kill-ring 状态（`chunk-jpr2vtnw.js` 的
> `mode: { type: "yanked", start, length, index }`），与任务系统无关。

MyClaude 现状：**只有后台 Bash 一种**。

这解释了为什么 Claude 能「同时跑多个子代理」而 MyClaude 只能串行——
不只是缺少 `Promise.all`，而是**缺少整个任务编排层**。

## 三、斜杠命令

MyClaude 已有 **29 个**，Claude 侧提取到 **57 个候选**，确认缺 **24 个**：

| 优先级 | 命令 | 理由 |
|---|---|---|
| ~~P0~~ | ~~`/compact`~~ | ✅ 已完成 |
| ~~P0~~ | ~~`/cost`~~ | ✅ 已完成（按模型真实计价） |
| ~~P0~~ | ~~`/doctor`~~ | ✅ 已完成 |
| ~~P1~~ | ~~`/init`~~ | ✅ 已完成 |
| ~~P1~~ | ~~`/export`~~ | ✅ 已完成 |
| ~~P1~~ | ~~`/rewind`~~ | ✅ 已完成 |
| P2 | `/hooks` `/skills` `/plugin` | 扩展生态 | ✅ 已完成（hooks 7 事件、skills 目录制、plugin 组件打包） |
| P1 | `/effort` `/fast` | 思考深度与快速模式 | ✅ 已完成（2026-10-23） |
| P1 | `/status` | 一行显示会话状态 | ✅ 已完成（2026-10-23） |
| P1 | `/title` | 给会话命名 | ✅ 已完成（2026-10-23） |
| P1 | `/fork` `/branch` | 会话分叉 | ✅ 已完成（2026-10-23） |
| P1 | `/memory` 写入 | 追加/路径（原只能显示） | ✅ 已完成（2026-10-23） |
| P1 | `/loop` | 循环执行提示词 | ✅ 已完成（2026-10-23，默认有界） |
| P3 | `/login` `/remote` `/share` `/branch` `/fork` `/loop` | 依赖云端服务 |

## 四、关键机制缺口

| 机制 | Claude | MyClaude | 影响 |
|---|---|---|---|
| **文件改动回滚** | `/rewind` 回退文件到改动前 | ✅ `/rewind` 同时恢复文件与对话 | ✅ 已完成 |
| **diff 审批** | 渲染彩色 unified diff | ✅ buildConfirmDiff 渲染 unified diff | ✅ 已完成 |
| **checkpoint 快照** | 每轮记录文件快照 | ✅ CheckpointStore 且落盘（~/.myclaude/checkpoints） | ✅ 已完成 |
| **任务编排层** | 10 种任务类型 + 状态机 | ✅ 统一注册表 + 6 种类型，支持并行子代理 | 🟡 缺 4 种类型 |
| **hooks 配置** | 有界面与 CRUD | ✅ `/api/hooks` CRUD + `/hooks` 命令 | ✅ 已完成 |
| **hooks 事件** | 含 `PreCompact` / `SubagentStop` | ✅ 7/7 | ✅ 已完成 |
| **MCP OAuth** | 支持 | ✅ RFC 8628 设备流 + `/mcp login` | ✅ 已完成 |
| **Bash 沙箱** | 有（`dangerouslyDisableSandbox` 可绕过） | 无沙箱；用命令分级 + auto 审查模型替代 | 🟡 Windows 上 Claude 同样不可用 |
| **工具并发** | 并行 | ✅ 已实现（三阶段） | — |
| **checkpoint 快照** | 每轮记录 | ✅ 已实现并落盘（~/.myclaude/checkpoints） | — |
| **Grep** | ripgrep | ✅ 已接 ripgrep（无 rg 回落 JS） | — |
| **MCP OAuth** | 支持 | ✅ 已实现（RFC 8628 设备流） | — |

## 五、执行计划

### 第一梯队（用户直接感受到）
1. ~~**diff 审批**~~ ✅ 已完成 —— 改文件前渲染彩色对比 + 「不再询问此命令」
2. ~~**文件回滚**~~ ✅ 已完成（/rewind 恢复文件+对话） —— 引入快照，`/rewind` 同时恢复文件与对话
3. ~~**`/compact` `/cost` `/doctor`**~~ ✅ 已完成 —— 运维三件套

### 第二梯队（能力补齐）
4. ~~`/init` + `/export`~~ ✅ 已完成
5. ~~`/api/hooks` CRUD~~ ✅ 已完成
6. ~~Grep 接 ripgrep~~ ✅ 已完成

### 说明

`/new` 不是 Claude 的斜杠命令（它只是内部的 `newsession` 动作，由 `/clear` 触发），因此不复刻。

### 第三梯队（架构级）
7. ~~任务编排层~~ ✅ 已完成（6 种任务类型 + 统一注册表）
8. ~~MCP OAuth~~ ✅ 已完成
9. ~~`/skills` `/plugin` 扩展体系~~ ✅ 已完成（2026-10-21）

## 六、方法论

之前按「问题报告」逐条修 bug，但**修 bug ≠ 补功能**。
正确顺序：**提取规格 → 逐项对照 → 按影响面排序 → 全链路验证**。
