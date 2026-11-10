# 复刻占比总表（Claude Code 2.1.302 ↔ MyClaude）

> 2026-11-07 夜航后终账。所有数字现测可得（`node scripts/parity-metrics.mjs --json`），
> 判定口径见各节；「物理不可达」项单列，不计入占比分母（REPLICATION-ROADMAP §0/§5）。

## 1. 总览

| 维度 | 占比 | 口径 |
|---|---|---|
| 命令面（TUI） | **100%** | 本地相关 64，TUI 64/64，零缺失（测于 2026-11-08 via node scripts/parity-metrics.mjs --json；/theme /restart 已实现，见下） |
| 命令面（GUI） | **100%** | 同口径，GUI 64/64，零缺失（/restart 经命令桥实现） |
| 工具契约 | **17/17 可对齐项 = 100%** | 上游 96 条目中 79 个为云侧/生态/模板（不可达）；本地 17 个工具全部逐字采用上游 description+schema |
| 输出样式 | **5/5 = 100%** | default/Proactive/Concise/Explanatory/Learning 逐字（含 turnReminder/waitingTurnReminder） |
| 系统提示词 | **六段结构 ✓** | 13,147 字符；高价值子句逐字对照（system-prompt-parity 测试锁定） |
| 权限引擎 | **✓** | 上游真实代码参与判定（B 路线：isReadOnly 进程内调用；rm -rf 实测拦截） |
| 执行后端 | **✓** | self/upstream 双后端可切换；上游 stream-json→MyClaude SSE 翻译；会话落盘 |
| 引擎会话连续性 | **✓** | /engine --resume 绑定 + 失效降级 |
| 编辑器模式 | **✓** | editorMode normal/vim：TUI（ink）与 GUI（textarea）双面；remaps；指示器；双击 esc |
| 会话面 | **✓** | resume/fork/branch/title/compact/rewind(depth)/checkpoints |
| 验证基建 | **708/708 单测 + CDP 双回归 27 项 + 真 TTY + smoke 46** | 七闸门（六闸门 + 真 TTY） |

## 2. 本轮（夜航）增量

### 2026-11-11 凌晨增补（并发覆盖事故修复 + 逻辑层深化）
1. **并发覆盖事故修复**：ac32bce 误回退了 c8b1111 的引擎权限逻辑（权威模式映射/
   permission-prompts none/--add-dir/describeDenials）与 f721f8e 的 engine:"self" 标记
   —— 10 项引擎测试被带崩且无人发现（上轮提交带红测试）。已恢复，gate:fast/full 首次真绿。
2. **逻辑层差分测试**（5 项）：自研权限引擎与原生引擎裁决方向对比（ask 不静默放行/
   deny 硬拒最高优先/allow 命中放行/deny 压 allow）。
3. **N9 闭环**：引擎绑定随会话删除回收（GUI DELETE + TUI /rm）+ 运行时生命周期测试。
4. **流式对齐**：--include-partial-messages 上游 flag 接入 + stream_event 翻译
   （text_delta/thinking_delta，差量补发防双倍）。真引擎管道模式未发增量（如实记录）。
5. **压缩边界行为测试**（表驱动 5 项）：悬空 tool_result 不入保留尾部。
6. **clootee/clootee 评估**：Apache-2.0 启动器（非复刻），logic_struct/logic_realize 分层
   模式与本项目 agent.js/engine 分层等价，无可抄内容。

追加轮（时间盒内继续）：turnReminder 逐回合提醒（上游 Aer/Per/Oer 逐字 + waiting 变体）、
TUI /config 交互面板（enum 循环取值：Editor mode/Output style/autoCompact）、
真 TTY 验证闸门（winpty）。


R1 Esc+Esc 编辑上一条消息（TUI 选择器 + depth rewind）／
R2 工具契约 12→17（EnterPlanMode/Skill 新工具 + MCP 资源 + ExitPlanMode merge）／
R3 测试与盘根仓库解耦（全量首次满绿）／
R4 GUI vim 输入模式 + statusline vim.mode 契约字段／
R7 输出样式五态逐字／
追加轮 turnReminder 逐回合注入（Proactive/Concise）／
顺带修复：TUI bridge.user 缺失、ink-app 裸 dimColor（真 TTY 一渲染即崩的 P0）、
vim 机器码作用域（boot 链炸）、消息目录三 bug、工具卡截断（前一轮）。

## 3. 物理不可达（不计入分母，逐项有据）

- 命令 44 个（R4 重推：回收 restart/theme 为本地可实现；brief 改判上游实验门控默认关闭；feedback/bug/stickers 维持排除，理由修正。逐条证据见 docs/command-denominator.md）。
- 工具 79 个：云侧/模板/stub（RemoteTrigger/DesignSync/self_hosted_runner_* 等）。
- 上游服务端行为：遥测、远端会话、marketplace 分发。

## 4. 已知残余差异（如实清单，均为「结构已对齐、细节未深挖」）

1. diff 视图的 TUI 端深层细节（上游逐 hunk 渲染参数）——结构已对齐，待专项抽取。
2. vim：无宏/搜索/redo（上游动作表未见对应实现）；GUI 输入框 vim 与系统剪贴板键并存；VISUAL 选区高亮已用原生 setSelectionRange 实现（截图 shots/10）。
3. TaskCreate/TaskGet/TaskUpdate/TaskList（上游跨代理任务列表系统）——本地无对应系统，契约未接入（不假装）。
4. 输出样式 turnReminder 的 waiting 判定按「有 running 后台任务」近似上游语义。

## 5. 复测方式

```bash
node scripts/parity-metrics.mjs --json   # 命令面/工具契约现测
npm test                                  # 707 项单测
node scripts/verify-catalog-toolcard.mjs  # 目录/工具卡 CDP 13 项
node scripts/verify-gui-vim.mjs           # GUI vim CDP 14 项
npm run test:smoke                        # 46 命令 0 崩溃
node scripts/verify-features.mjs         # 功能完整性
npm run inspect:prompt                    # 提示词体检
```
