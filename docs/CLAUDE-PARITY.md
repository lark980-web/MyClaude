# MyClaude vs Claude Code 功能对照

> **对照依据**：`E:\WorkSpaces\Test09\claude-src`（Claude Code 2.1.276 逆向产物，1554 个模块）
>
> **重要：代码不可直接复用**。实测确认三个硬障碍：
> 1. 1554 个模块**全部**带 `@bytecode` 标记（Bun 预编译产物）
> 2. import 路径指向 `B:/~BUN/root/` 虚拟根，真实文件系统不存在
> 3. 核心逻辑（认证/遥测/marketplace）绑定闭源运行时
>
> 正确用法：**提取功能规格，重新实现**。

生成时间：2026-10-20 ｜ 数据来源：源码静态分析

---

## 一、工具（Tool）

Claude 的基础工具集（从 `allowed_tools` 与 schema 定义确认）：

`Bash / Read / Write / Edit / Glob / Grep / Task / WebFetch / WebSearch / TodoWrite / NotebookRead / NotebookEdit / ExitPlanMode / AskUserQuestion / BashOutput / KillShell`

| 项 | Claude | MyClaude | 差距 |
|---|---|---|---|
| 工具数量 | 21 | 21 | ✅ 对齐 |
| Bash | 支持沙箱、`dangerouslyDisableSandbox`、超时自动转后台、输出持久化 | 基础执行 | ⚠️ 无沙箱、无大输出持久化 |
| Grep | ripgrep | 手写 JS 遍历 | ⚠️ 大仓库慢约 10 倍 |
| Task | 10 种任务类型（见下） | 1 种 | ⚠️ 差距最大 |
| 权限提示 | 带 diff 预览 + 「不再询问此命令」 | 只有 y/n | ⚠️ 最高频交互缺失 |

## 二、任务体系（Claude 的核心架构差异）

Claude 有 **10 种任务类型**，每种带独立的 `kill()` 与状态机：

```
local_agent          子代理任务
local_bash           后台 shell
local_workflow       工作流
mcp_task             MCP 调用
monitor_ws           WebSocket 监控
auto_mode_scan       自动模式审查（reviewer model 扫描动作）
dream                后台思考/整理
in_process_teammate  进程内队友（Team）
yank / yanked        任务占位与回收
```

MyClaude 现状：**只有后台 Bash 一种**。

这解释了为什么 Claude 能「同时跑多个子代理」而 MyClaude 只能串行——
不只是缺少 `Promise.all`，而是**缺少整个任务编排层**。

## 三、斜杠命令

MyClaude 已有 **29 个**，Claude 侧提取到 **57 个候选**，确认缺 **24 个**：

| 优先级 | 命令 | 理由 |
|---|---|---|
| **P0** | `/compact` | 手动压缩，长对话必需 |
| **P0** | `/cost` | 花费统计（token 数据已有，只需聚合） |
| **P0** | `/doctor` | 环境自检（配置/网关/MCP/权限） |
| P1 | `/init` | 生成 MYCLAUDE.md 项目记忆 |
| P1 | `/export` | 导出对话（GUI 有，CLI 缺） |
| P1 | `/rewind` | 回退文件改动（见下） |
| P2 | `/hooks` `/skills` `/plugin` | 扩展生态 | ✅ 已完成（hooks 7 事件、skills 目录制、plugin 组件打包） |
| P3 | `/login` `/remote` `/share` `/branch` `/fork` `/loop` | 依赖云端服务 |

## 四、关键机制缺口

| 机制 | Claude | MyClaude | 影响 |
|---|---|---|---|
| **文件改动回滚** | `/rewind` 回退文件到改动前 | `agent.js:185` 只回退**对话**，不碰文件 | 🔴 改错了无法撤销 |
| **diff 审批** | 渲染彩色 unified diff | `confirm` 事件只传 `name, args`（裸 JSON） | 🔴 最高频交互，看不到改了什么 |
| **checkpoint 快照** | 每轮记录文件快照 | 无 | 🔴 依赖上一条 |
| **任务编排层** | 10 种任务类型 + 状态机 | 1 种 | 🟡 无法并行子代理 |
| **hooks 配置** | 有界面与 CRUD | 只有引擎，无接口 | 🟡 用户无法配置 |
| **hooks 事件** | 含 `PreCompact` / `SubagentStop` | 5/7 | 🟡 压缩前无钩子 |
| **MCP OAuth** | 支持 | 无 | 🟡 只能连无鉴权服务器 |
| **Bash 沙箱** | 有（`dangerouslyDisableSandbox` 可绕过） | 无沙箱 | 🟡 权限模式下仍有风险 |
| **工具并发** | 并行 | ✅ 已实现（三阶段） | — |

## 五、执行计划

### 第一梯队（用户直接感受到）
1. **diff 审批** —— 改文件前渲染彩色对比 + 「不再询问此命令」
2. **文件回滚** —— 引入快照，`/rewind` 同时恢复文件与对话
3. **`/compact` `/cost` `/doctor`** —— 运维三件套

### 第二梯队（能力补齐）
4. `/init` + `/export`
5. `/api/hooks` CRUD 接口（界面交前端）
6. Grep 接 ripgrep（无 rg 自动回落）

### 第三梯队（架构级）
7. 任务编排层（多类型任务 + 并行子代理）
8. MCP OAuth
9. ~~`/skills` `/plugin` 扩展体系~~ ✅ 已完成（2026-10-21）

## 六、方法论

之前按「问题报告」逐条修 bug，但**修 bug ≠ 补功能**。
正确顺序：**提取规格 → 逐项对照 → 按影响面排序 → 全链路验证**。
