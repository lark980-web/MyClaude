# 开发计划 v2：模型无关的轮次制

> 版本：v2，2026-11-07。取代同日 v1（W 任务表），任务已卡片化。
> 设计目标：**任何模型、零对话记忆，只读本文件 + docs/HANDOFF.md，即可正确执行下一轮。**
> 状态只存在于三个地方：**文件状态行（§8）+ git 提交 + test/gate-metrics.json**。会话记忆一律不存在。
> 背景（可跳过）：本计划来自两项审查——claude-re-2.1.302 完整度审查（AUDIT.md）与 MyClaude 三盲区现测（栅栏过期 / 分母无守望 / 文档互斥）。

## 0. 五条铁律（写给每一个新接手的模型，先读完再动手）

1. **会话记忆不存在。**对话里的「已完成」一律是待验证的 claim。当前状态以 §8 状态行 + `git log` + gate 现测为准。
2. **gate 定红绿，你不自评。**任务完成的唯一标准是卡片里的验收命令全过。gate 不绿 = 没完成，无论你多有信心。
3. **一轮一任务。**执行中发现的新东西，追加一行到 docs/iteration-backlog.md，本轮不处理。中途扩 scope 是违规。
4. **改计划先留 ADR。**对 docs/EXECUTION-PLAN.md 的任何修改，先在 docs/adr.md 追加一行（计划了 X / 发现了 Y / 决定 Z / 因为 W），再改。
5. **一切数字现测。**引用任何数字必须能当场重跑其来源命令。文档里的旧数字不算数。

## 1. 会话协议

### 1.1 启动仪式（每次会话开始，六步，缺一不可）

```
1. 读 docs/HANDOFF.md —— 只信「怎么核实」列，不信数字本身
2. 读本文件 §8 状态行 —— 找最上面一个「未开始」的轮
3. git log --oneline -5 && git status —— 有未提交改动 = 上一轮没按 §1.3 收尾，先走恢复程序
4. npm run gate:fast —— 现测当前状态。红 = 先修回归，绿 = 状态行可信
5. 核对所选轮次卡片的输入锚（sha256 前 12 位）。锚不对 = ground truth 动了 → 该卡作废，先跑对应证伪项
6. 开始执行该卡片，只做该卡片
```

### 1.2 轮循环（八步，任何模型同一套）

```
① 选卡：§8 最上面的「未开始」轮
② 验锚：卡片输入文件的 sha256 前缀逐一比对
③ 执行：只做卡片步骤
④ gate:fast 必须绿（轮末跑 gate:full，若卡片要求）
⑤ 更新 §8 行：状态=已完成 + 提交哈希 + 测于日期
⑥ 有偏离 → docs/adr.md 追加一行
⑦ git commit（改完尽快提交，防并发覆盖——HANDOFF §4.7）
⑧ 收轮。gate 不绿不许收轮
```

### 1.3 中途死亡恢复（上一轮没提交）

```
gate:fast 绿 + 改动与某卡片吻合   → 补完，按 1.2 ⑤⑥⑦⑧ 收轮
gate:fast 红                        → 保留全部改动与失败日志，定位失败；仅修本轮范围，不自动整仓回滚
拿不准                              → 保存现场并报告，确认归属/授权后再处置；不得丢弃用户或其他会话改动
```

### 1.4 证伪轮（每执行 3 张卡，插一轮）

菜单 = 卡片标注「证伪轮」的任务（R5 / R6 / R8）。铁律：**禁读 MyClaude 自家 parity/权限/文档作为依据**（被告不参与判决），一切从 claude-re-2.1.302 树重推。

## 2. 轮次卡片（每张自包含；模型换一百次，卡片不变）

### R1 闸门接线

- **目标**：让「跳过检查」从靠自觉变成显眼动作；让趋势可机检。
- **输入**：package.json；scripts/ 下 verify-features.mjs、inspect-prompt.mjs、smoke-commands.mjs、verify-catalog-toolcard.mjs、verify-gui-vim.mjs、verify-tui-tty.mjs；test/*.test.js
- **步骤**：
  1. 新增 scripts/gate.mjs 与两个脚本：`gate:fast` = 单测 → verify-features → inspect:prompt；`gate:full` = gate:fast + smoke + 三套 CDP + 真 TTY + build:exe。
  2. gate 末尾写 test/gate-metrics.json（testCount / ts / commit），与上次比较：**testCount 回退即 exit 1**。
  3. verify-features.mjs 接在 gate:fast 链尾（不再依赖人记得跑）。
  4. 修 scripts/parity-metrics.mjs 的 excluded 数组重复 bug（ultraplan/teleport/remote-control/autofix-pr/usage-credits/extra-usage 各出现两次），加去除断言。
- **验收**：`npm run gate:fast` exit 0 且 metrics 落盘；**故意删一个 verify-features marker → gate:fast exit 1**（守望者必须会叫）；**故意注释掉一个测试 → 因 testCount 回退 exit 1**；`parity-metrics --json` 的 excluded 无重复。
- **产出**：scripts/gate.mjs、test/gate-metrics.json、package.json、gate 基线提交。
- **禁止**：不动七闸门各自内部逻辑；不做 R2 的任何事。

### R2 提示词评估表 + parity 换锚

- **目标**：17 个行为段每段有判定；parity 测试从过期栅栏（10,707）换到 v2-full 锚。
- **输入（先验 sha256 前 12 位）**：
  - claude-re-2.1.302/04-prompts/system-prompt-v2-full.md → `030d9f7e4ed0`
  - claude-re-2.1.302/04-prompts/dynamic-sections.md → `c042647072e2`
  - claude-re-2.1.302/tools/re/_assembly-fn.txt（dfn 组装函数全文）、_gated-literals.json、_prompt-extra.json（静态原文已抽：action_caution 6024 / act_dont_rederive 3742 / delivering_work_max 3227 / focus_mode 881 / context_management 280+1198 / task_continuity 457 / act_dont_rederive:surface 483 / tool_param_json 约496）
- **步骤**：验锚 → 从 _assembly-fn.txt 枚举 17 个行为段（24 个 mm() 注册 − 7 个实验段，实验段此前已评估过）→ 每段三态判定（迁移 / 不迁移+理由 / 不可得+证据）写入 docs/prompt-gated-eval.md → test/system-prompt-parity.test.js 增加断言：v2-full 的 sha256 前缀 == `030d9f7e4ed0`（上游文件一变测试即黄，黄 = 重跑本卡）。
- **验收**：评估表 17 行无空白；parity 测试引用锚且 npm test 绿。
- **禁止**：本轮不迁移任何内容（迁移是 R3）；不改 src/agent/prompt.js。

### R3 高相关段迁移落地

- **目标**：R2 判「迁移」的段落进 MyClaude 提示词。
- **输入**：docs/prompt-gated-eval.md（R2 产物）+ 各段静态原文（R2 输入文件）。
- **步骤**：逐段移植进 src/agent/prompt.js，本地化三规则（TaskCreate→TodoWrite、CLAUDE.md→MYCLAUDE.md、不冒用 Claude 身份、不引用 MyClaude 不存在的工具）→ 每段至少一条断言锁关键子句 → `npm run inspect:prompt` 现测字数。
- **验收**：npm test 绿；HANDOFF §1 提示词行更新（附 测于+命令）；R2 评估表对应行改「已迁移」。
- **禁止**：迁移 R2 判「不迁移」的段。

### R4 分母重推（诚实性修正）

- **目标**：headline 从「可能虚高的 100%」改为「真数」。
- **输入**：scripts/parity-metrics.mjs；claude-re-2.1.302/02-modules/files/（上游命令定义，2432 明文 chunk）。
- **步骤**：六疑点（restart / theme / brief / feedback / bug / stickers）逐条判定——在上游模块找命令定义证据 → 判本地可实现性 → 写 docs/command-denominator.md → PARITY-SCORECARD 双口径并存并各自加断言。
- **验收**：denominator 文档六行判定齐全且每行带证据；SCORECARD 附现测；若回收了排除项，81/81 相应下调并留 ADR——**降下来的那天起 headline 才可信**。
- **禁止**：以 MyClaude 既有文档为判定依据。

### R5 权限模型抽取（证伪轮）

- **目标**：上游权限规格逐条带证据落盘。
- **输入**：claude-re-2.1.302/02-modules/files/。
- **步骤**：grep 定位 permissionMode 枚举、allow/deny/ask 匹配器、settings.json permissions 解析、Bash 危险命令判定、dangerouslyDisableSandbox 等开关 → 逐条抽取规则语法与匹配语义 → 可选：沙箱求值匹配器跑样例规则（复用 tools/re/eval-prompt.mjs 的桩技术）→ 写 claude-re-2.1.302/03-features/permissions.md。
- **验收**：每条规则带 chunk 文件 + 字节偏移；无证据的规则不许写。
- **禁止**：引用 docs/PERMISSION-MODEL.md（那是 MyClaude 自家模型，是待对照对象，不是依据）。下游任务（MyClaude 权限引擎对齐上游语法）待本卡产物落地后另行立卡。

### R6 扩展体系补全（证伪轮）

- **目标**：extensions.md 从 1,183 字节敷衍件变为逐字段带证据的规格。
- **步骤**：hooks 配置结构（事件→命令映射 schema）、plugin.json 清单字段、MCP 传输与 OAuth 配置结构，逐字段在 claude-re-2.1.302/02-modules/files/ 找证据；skills 部分直接引用 07-assets/skills.md（28 个 SKILL frontmatter 已完整，勿重做）。
- **验收**：claude-re-2.1.302/03-features/extensions.md 重写（预期 >5KB），逐字段带 chunk+偏移。

### R7 运行时观察

- **目标**：静态推断的行为契约与一次真会话对上。
- **步骤**：借现有 /engine 通道（上游 stream-json 已实测可用）录一次真会话（含工具调用 + 权限提示）→ 转录落盘 claude-re-2.1.302/05-runtime/session-transcript/ → 事件序对照 src/engines/upstream-chat.js 翻译映射。
- **验收**：转录落盘；对照 diff 为空（或差异逐条解释并记 adr.md）。

### R8 trailer 哈希算法（可明确放弃）

- **目标**：解出 claude-re-2.1.302 trailer 2,431 条哈希的算法；或正式放弃。
- **验收**：2,431 条全匹配才算解出 → 写 claude-re-2.1.302/01-artifact/trailer-hash.md；解不出 → AUDIT.md 记「放弃 + 理由」。**猜错被静默采用是最坏结局，禁止。**

## 3. 节奏表

| 守望者 | 节奏 | 看什么 | 动作 |
|---|---|---|---|
| 机器（gate 链） | 每轮必经（gate:fast）；轮末 gate:full | 单测趋势 + marker 完整性 + 提示词体检 | 红了不许收轮 |
| 证伪轮 | 每 3 张卡插一轮 | R5/R6/R8 菜单；禁读 MyClaude 自家文档 | 重推 ground truth |
| 你（人） | 每轮 ~10 分钟 | ①两文档报同一个数→立刻对账 ②新打的 ✅ 抽 1 条跑核实命令 ③known-gaps 两轮未动→强制 triage | 发现即打断当轮 |
| 新会话 | 每次交接 | §1.1 六步仪式 | 一切以现测为准 |

## 4. 为什么这套东西换模型不失效（机制说明）

1. **状态外置**：进度 = §8 行 + git 提交 + gate-metrics.json。新模型不读历史对话，读文件即重建全部状态。
2. **仪式固定**：六步启动、八步轮循环。模型的性格差异被流程洗掉——它只能按卡执行。
3. **完成由 gate 裁决**：换模型换不掉 npm test 的 exit code。自评无效。
4. **输入带锚**：ground truth 被 sha256 钉死。上游一动、下游即黄、证伪轮自动触发。
5. **卡片自包含**：每轮只依赖锚定文件，不依赖「上文」。轮与轮之间零记忆依赖。
6. **恢复程序**：中断的轮按 git 状态决定补完或回滚，死亡会话不污染下一轮。

## 5. 本计划的失效形态（自指）

- 本计划也会过期：claude-re-2.1.302 解出新产物（新提示词段、trailer 破解）→ R2/R4 的锚失效 → 下游断言黄。
- 变红条件：`030d9f7e4ed0`（v2-full）/ `b68d10cf6fee`（manifest）/ `c042647072e2`（dynamic-sections）任一变化。
- 谁在看：证伪轮（重推）+ 你（抽查）。
- 失效处理：按铁律第 4 条留 ADR，改本文件再动手。

## 8. 状态行（唯一进度准绳；新会话由此取任务）

| 轮 | 任务 | 状态 | 提交 | 测于 |
|---|---|---|---|---|
| R1 | 闸门接线 | 已完成（结果见 adr.md） | 本提交 | 2026-11-07 via gate:fast 全绿 + 反向 fixture 9/9 |
| R2 | 提示词评估表 + parity 换锚 | 已完成 | 本提交 | 2026-11-07：锚验 030d9f7e4ed0 ✓；18 行表 docs/prompt-gated-eval.md；parity 12/12 绿 |
| R3 | 高相关段迁移落地 | 未开始 | - | - |
| R4 | 分母重推 | 未开始 | - | - |
| R5 | 权限模型抽取（证伪） | 未开始 | - | - |
| R6 | 扩展体系补全（证伪） | 未开始 | - | - |
| R7 | 运行时观察 | 未开始 | - | - |
| R8 | trailer 哈希（可放弃） | 未开始 | - | - |
