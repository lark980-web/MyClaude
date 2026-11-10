# 逻辑层复刻终报告（2026-11-11 00:38 → 03:13 收账，后续持续深化至 03:30）

> 用户指令：继续逻辑层复刻（hooks 逐事件语义 + 真引擎 vs 自研 agent 行为差分对比，差异项逐个补齐）。
> 结果：**860 项 859 绿 + 1 skip**，gate:fast/full 九步全绿，工作树 0 未提交，24 个提交。

## 一、核心修复：并发覆盖事故（最严重）

上轮 `ac32bce` 提交**整文件回退**了两个关键修复：
- `c8b1111` 的引擎权限逻辑（toEnginePermissionMode 权威映射 / permission-prompts none / --add-dir / describeDenials）
- `f721f8e` 的 engine:"self" 会话标记

**10 项引擎测试被带崩且带红测试入库**（gate:fast/full 存在但上轮会话从未跑过）。
已恢复全部逻辑，调用链同步修复，gate:fast/full 首次九步真绿。

## 二、hooks 系统七项语义对齐上游

| 差异 | 修复 | 上游证据 |
|---|---|---|
| 决策优先级：后者赢 vs 最严者赢 | 改为 deny(3)>ask(2)>allow(1) | chunk-e0x0xb6d.js fmt()/m4() |
| PreToolUse `updatedInput` 缺失 | interpret() 捕获 → agent.js 应用 | chunk-e0x0xb6d.js behavior:"allow" + updatedInput |
| PostToolUse `updatedToolOutput` 缺失 | interpret() 捕获 → agent.js 应用到 tool_result | chunk-e0x0xb6d.js updatedToolOutput |
| `additionalContexts` 数组缺失 | interpret() 收集数组 → agent.js 逐条注入 | chunk-1j09a7h8.js hook_additional_context |
| `permissionDecisionReason` 缺失 | interpret() 捕获 → agent.js 传到拒绝文本 | chunk-e0x0xb6d.js fmt/m4 |
| stdin 缺 `transcript_path` | hooks.js 补全 | chunk-622sw1qr.js Gn 契约 |
| stdin 缺 `tool_use_id` | agent.js 传 `call.id` | chunk-622sw1qr.js Gn 契约 |

测试：`test/hooks-behavior.test.js` 18 项 + `test/hooks-e2e.test.js` 9 项（真实 cmd shell）

## 三、Notification 三时机接线

上游在三个时机通知用户：权限请求/破坏性命令/回合完成。
MyClaude 定义了 Notification 事件但 agent.js 从未触发。已接线到四个路径。

测试：`test/notification-behavior.test.js` 4 项。

## 四、逻辑层差分测试

### 权限裁决方向对比（自研权限引擎 vs 原生引擎）
5 项：ask 不静默放行 / deny 硬拒最高优先 / allow 命中放行 / deny 压 allow / describeDenials 翻译。

### 行为差分实测 4/4（真 gateway + 真工具链）
| 场景 | 结果 | 工具链 |
|---|---|---|
| 文件创建 | ✓ | Write |
| 读改链（Read→Edit） | ✓ | Read×6→Edit |
| JSON 结构解析 | ✓ | Read |
| 错误恢复（不存在文件） | ✓ | Read |

### 并发工具调用 + abort 边界
4 项：并发 Write 同文件后写者赢 / abort→stopRequested / signal 传递 / 按序记录。

## 五、逻辑层新增功能

| 功能 | 上游证据 | 测试 |
|---|---|---|
| micro-compaction（旧 tool_result 清理） | chunk-6d8wmbn8.js microcompact | 4 项 |
| MultiEdit 原子性行为 | 工具描述 "if any fails, nothing is written" | 6 项 |
| provider failover 链行为 | chunk-e0x0xb6d.js RETRYABLE_STATUS 含 529 | 4 项 |
| 工具错误恢复行为 | 上游语义 | 4 项 |
| Stop hook 阻断继续工作 | 上游 Stop hook 语义 | 3 项 |
| session fork/branch 行为 | 上游 fork 语义 | 6 项 |
| N9 引擎绑定生命周期 | 上游 session 绑定 | 2 项 |
| 逻辑层差分测试 | 上游权限裁决 | 5 项 |

## 六、审计遗留项收账

| 项 | 状态 |
|---|---|
| N1-N3, N5-N7 | ✅ 前几轮已修（本夜 N5 标记恢复确认） |
| N4 | ✅ persistedOutputPath 透传到 GUI extra |
| N8 | ✅ ripgrep 默认排除大目录 |
| N9 | ✅ 绑定随会话删除回收 |
| N10 | ✅ 77 个临时文件清理 |

## 七、clootee/clootee 评估
Apache-2.0 启动器/管理工具，非复刻。logic_struct/logic_realize 分层模式与
本项目 agent.js + engines/ 分层等价，无可抄内容。

## 八、复测方式
```bash
npm test                                # 860 项 859 绿 + 1 skip
npm run gate:full                       # 九步全绿
node scripts/verify-catalog-toolcard.mjs  # CDP 13 项
node scripts/verify-gui-vim.mjs          # CDP 14 项
node scripts/verify-tui-tty.mjs         # 真 TTY
node scripts/shot-differential.cjs      # 行为差分 4/4
node .re/logic-audit.mjs               # 逻辑层审计 22/22
```
