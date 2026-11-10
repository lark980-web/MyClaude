# 逻辑层复刻报告（2026-11-11 夜航终态）

> 目标：对照上游 Claude Code 2.1.302 的 agent 运行时逻辑，逐模块补齐行为级复刻 + 测试。
> 结果：全量 **842 项 841 绿 + 1 skip**，gate:fast/full 九步全绿，工作树 0 未提交。

## 一、今晚修复与新增（按发现顺序）

### 1. 并发覆盖事故修复（最严重）
ac32bce 提交整文件回退了 c8b1111 的引擎权限逻辑（90 行）和 f721f8e 的 engine:"self" 标记
——10 项引擎测试被带崩且**带红测试入库**。gate:fast/full 存在但从未被上轮会话跑过。
已恢复全部逻辑，调用链同步修复，gate 首次九步真绿。

### 2. hooks 系统七项语义对齐上游
| 差异 | 修复 |
|---|---|
| 决策优先级：MyClaude 后者赢 vs 上游最严者赢 | 改为 deny(3)>ask(2)>allow(1)，与上游 fmt() 一致 |
| PreToolUse `updatedInput`：上游可修改工具入参 | hooks.js 捕获 → agent.js 应用到权限判定与执行 |
| PostToolUse `updatedToolOutput`：上游可修改工具输出 | hooks.js 捕获 → agent.js 应用到 tool_result |
| `additionalContexts` 数组：上游逐条注入 | interpret() 收集数组 → agent.js 逐条 push |
| `permissionDecisionReason`：上游与裁决成对出现 | interpret() 捕获 → agent.js 传到拒绝文本 |
| stdin 缺 `transcript_path`/`tool_use_id` | 补全（上游 hook_event_name 契约） |
| PreToolUse stdin 缺 `tool_use_id` | agent.js 传 `call.id` |

### 3. Notification 三时机接线
上游在权限请求/破坏性命令/回合完成时通知用户。MyClaude HOOK_EVENTS 定义了
Notification 但 agent.js 从未触发。已接线到四个路径：
- auto 模式破坏性命令确认前
- auto review 拦截/不确定时
- ask 模式工具确认前
- 回合完成时（task_complete）

### 4. N9 引擎绑定生命周期
engine-sessions.json 的绑定随会话删除回收（GUI DELETE + TUI /rm 路径），
运行时行为测试覆盖 remember/读回/forget/空值边缘。

### 5. 流式对齐
buildEngineArgs 加 `--include-partial-messages`（上游 chunk-5hm1rmk2.js 实证）。
translateUpstreamLine 处理 stream_event（text_delta/thinking_delta），
streamedText 记账防重发已流部分。真引擎管道模式未发增量——如实记录。

### 6. 压缩边界行为测试
findKeepBoundary 保证保留尾部首元素不是 tool（上游 400 语义）。
表驱动测试覆盖：尾部含孤立 tool/全是 tool/干净尾部/want>消息数。

### 7. micro-compaction（上游语义）
新增 `Agent.microCompact(keepRecent)`：移除旧 tool_result 正文保留结构。
maybeCompact 集成：先试 micro（释放够就不走全量），仍超阈值才全量压缩。
上游证据：microcompact 在 chunk-6d8wmbn8.js 事件流中出现。

### 8. MultiEdit 原子性行为测试
上游描述 "All edits are validated first; if any fails, nothing is written."
测试 6 项验证：全部成功/一个失败整体不写/第一个失败后续不执行/
文件不存在不创建/replace_all/空编辑。

### 9. provider failover 链行为测试
4 项：主模型正常不切换/fallbacks 过滤无 endpoint/切换计数与模型追踪/
retryable 状态码覆盖 529 overloaded（上游 529 = Anthropic overloaded）。

### 10. 工具错误恢复行为测试
4 项：throw → ok:false 回传（不中断回合）/ok:false 错误内容回传/
并行一个失败其他成功不丢失/多轮错误恢复。

### 11. 逻辑层差分测试
5 项：自研权限引擎与原生引擎裁决方向对比
（ask 不静默放行/deny 硬拒最高优先/allow 命中放行/deny 压 allow）。

## 二、clootee/clootee 评估
Apache-2.0 启动器/管理工具（一键装 Node、启停脚本、多会话队列）。
logic_struct/logic_realize 分层模式与本项目 agent.js + engines/ 分层等价。
不是 Claude Code 复刻，无可抄内容。

## 三、测试统计
- 全量：**842 项 841 绿 + 1 skip**（真引擎 denials 实测需要 ANTHROPIC_API_KEY，如实 skip）
- gate:fast 三步全绿；gate:full 九步全绿
- 截图证据链三批 14 张 PNG + TUI 真 TTY 帧转储
- 行为差分实测 4/4 场景通过（真 gateway + 真工具链）

## 四、残余差异（如实，全部有据标注）
1. diff 视图 TUI 端深层渲染参数（上游字节码无 ⎿ 字符——工具结果行格式与 MyClaude 不同源）
2. vim 无宏/搜索/redo（上游动作表未见实现）；GUI VISUAL 选区用原生 setSelectionRange
3. 上游跨代理任务列表系统（TaskCreate 系）本地无对应系统，契约未接入（不假装）
4. 52 云侧命令 + 79 云侧工具（物理不可达：本机无服务端）
5. 真引擎流式增量：flag 已发但引擎管道模式内部缓冲——运行时行为取决于引擎流式实现
