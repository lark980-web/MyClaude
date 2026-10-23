# Recon map — Claude Code → MyClaude

基于 `E:\WorkSpaces\Test09\claude-src`（Claude Code 2.1.276 逆向产物）的规格提取，以及本仓库已实现的代码现状。

**方法偏差（必须记录）**：replica-recon 规则禁止读取目标应用的源码包/反编译产物，只允许公开文档与用户自有账号。但用户显式指令要求「所有开发必须以 claude-src 的真实实现为规格依据」，该指令优先级更高，故继续以 claude-src 为规格来源。公开 docs 本次不可达（搜索接口 401），留待后续交叉验证。

## 1. Scope

- **应用**：Claude Code（CLI + GUI 编码代理）
- **平台**：Web GUI（`src/ui/web`）+ 终端（`src/ui/ink-ui`），Windows 优先
- **切片**：编码代理的**核心回路**与其**扩展体系**
  - 核心回路：输入 → 权限判定 → 工具执行 → 结果呈现 → 会话持久化/恢复
  - 扩展体系：skills / plugins / hooks / MCP / 任务编排 / 斜杠命令
- **给谁**：自用（本机编码助手），非转售产品

## 2. Sources

| source | 给出什么 | 状态 |
|---|---|---|
| `claude-src` 逆向产物 | 功能规格、字段结构、提示词原文 | 已用（违反 recon 规则，按用户指令） |
| 本仓库代码 | 已实现事实 | 已用 |
| Claude Code 公开 docs | 交叉验证 | **不可达**（搜索 401），待补 |

（App store / 营销站：不适用 —— 开源 CLI，无商店页）

## 3. Screen inventory

按本仓库 GUI 的实际容器划分（功能对照，非像素级还原）。

| ID | screen | 容器 | purpose | key components |
|---|---|---|---|---|
| S01 | 会话侧栏 rail | `.rail` | 会话列表、新建、归档、资料 | `.new-chat` `.rail-item` `.rail-archive-btn` `.profile` |
| S02 | 顶栏 topbar | `.topbar` | 模型切换、导出、工具展开 | `.icon-btn` `.top-model-pill` `.ghost-btn` |
| S03 | 主对话区 | `main-col` | 消息流、流式输出、工具结果 | `.msg` `.codeblock` `.mini-btn` `.followup-chip` |
| S04 | 输入区 composer | `.prompt-bar` | 输入、附件、权限模式、风格、思考、发送 | `.round-btn` `.mode-select-wrap` `.style-btn` `.model-btn` `.send-btn` |
| S05 | 检查面板 inspector | `.inspector` | 会话详情、Artifacts | `.insp-tab` `.artifact-pane` |
| S06 | Artifact 面板 | `.artifact-pane` | 预览/代码/对比/编辑、写入工作区 | `.artifact-view-btn` `.artifact-select` `.artifact-apply-btn` |
| S07 | 命令面板 | `.cmd-item` | 斜杠命令与会话搜索 | `.cmd-item` |
| S08 | 设置/模型配置 | `config-dialog` | 模型、供应商、权限、hooks | `.config-tab-btn` `.cfg-select` `.icon-btn` |
| S09 | 项目面板 | `projects` | 项目切换、指令库 | `.proj-mode-tab` `.proj-tab` `.plib-*` |

## 4. User flows

F01 用户发起任务并得到执行
    S04 输入 → 权限判定 → 工具执行 → S03 呈现 → 会话落盘
    edge: 权限拒绝、超时转后台、大输出落盘、token 超限压缩 → **已实现**

F02 撤销一次改动
    S04 /rewind → 文件快照恢复 + 对话回退（CheckpointStore 落盘）→ **已实现**
    edge: 快照缺失、文件被外部修改、跨会话恢复

F03 后台任务管理
    S04 /tasks → 任务注册表 → 子代理/后台 shell 状态查看与取消 → **已实现 6/11 类型**
    剩余类型：in_process_teammate / teammate / remote_agent（依赖进程内多智能体协作，不可克隆）

F04 扩展能力装载
    skills 目录 → /skills；plugin.json → /plugin；hooks 配置 → /hooks；MCP → /mcp → **已实现**
    edge: manifest 非法、脚本缺失、MCP 需 OAuth

F05 会话管理
    /sessions → /resume → /fork → /title → /rm → **已实现**
    edge: 会话不存在、空会话分叉拒绝、标题超长截断

F06 成本与自检
    /cost → 按模型计价；/doctor → 配置/网关/MCP/权限自检 → **已实现**

## 5. Components（重复出现的 UI 部件）

| 部件 | 变体/状态 | 用在哪 |
|---|---|---|
| icon-btn | default / hover / active / off | S01 S02 S06 S08 |
| round-btn | + / @ / 视觉 / 麦克风 | S04 |
| style-btn | normal / active（accent） | S04 S07 S08 S09 |
| mode-select | 常用/特殊/危险三组 + 高级模式 | S04 |
| chip / pill | followup-chip（pill） | S03 |
| tab | insp-tab / proj-tab / config-tab-btn / model-vendor-tab | S05 S08 S09 |
| select | voice-select / artifact-select / archive-policy-select | S06 S04 |
| modal | 命令面板 / 设置 / 提示词库 / Projects | 全局 |
| toast | ok / warn / err | 全局 |
| codeblock | 高亮 / 复制 / 展开 | S03 S06 |
| 空态 | (no sessions) / (no tasks) / (no skills) / (no plugins) / (no hooks) | 各处 |

## 6. Inferred data model

Session   id, savedAt, updatedAt, messages[], turnCount, title, pinned, archived, cwd, model, provider, permissionMode, forkedFrom
          证据：src/session.js（saveSession / setSessionTitle / forkSession 字段）—— 本仓库自有代码，confidence: high

Task      id, type(local_bash|local_agent|mcp_task|monitor_mcp|monitor_ws|workflow|dream|auto_mode_scan),
          status(pending|running|completed|failed|cancelled), label, output, meta
          证据：src/tasks/registry.js 的 TASK_TYPES / TASK_STATUS
          confidence: high

Checkpoint  filePath → {existed, content}。落盘于 ~/.myclaude/checkpoints/<session>/index.json + <hash>.snap
          证据：src/agent/checkpoint.js
          confidence: high

Hook      event(UserPromptSubmit|PreToolUse|PostToolUse|Notification|Stop|PreCompact|SubagentStop) → groups[].hooks[].command
          证据：src/hooks.js 的 HOOK_EVENTS 与 definitions 结构
          confidence: high

Skill     <skill>/SKILL.md（frontmatter: name, description, allowed-tools）
Plugin    <plugin>/plugin.json（name, version, description, commands, agents, skills, hooks, mcpServers）+ 组件目录 commands/ skills/ hooks/ agents/ lspServers/
          证据：src/skills.js、src/plugins.js
          confidence: high

## 7. Feature matrix

见 `replica/features.csv`（feature, area, priority, original, clone, notes）。`clone` 列在推进中逐行填写。

## 8. What cannot be cloned

| 项 | 原因 |
|---|---|
| Bash 沙箱 | Claude 在 Windows 上同样不可用（`1379_unnamed.js`: `eval kept-sandbox seal unavailable on windows`）。已用命令分级 + auto 审查模型替代 |
| teammate / in_process_teammate / remote_agent | 依赖进程内多智能体协作架构（`teammate_mailbox` 消息队列、`teammate-spawn` 生命周期、iTerm2 分屏），属架构级改造，非补一个类型 |
| `/login` `/remote` `/share` | 依赖 Anthropic 云端服务 |

## 9. Size

- 屏幕 9、流程 6、实体 6、已实现命令 46、任务类型 7/11
- 硬骨头：多智能体协作（不可克隆）、沙箱（平台限制）、成本/压缩（已实现）
- 规模：**M**（数周）—— 剩余可在数个轮次内推进

## 10. 下一步

按 features.csv 的 `must` 行逐条推进，每条：写测试 → 改代码 → 跑全量 → 重编译 exe 验证。
