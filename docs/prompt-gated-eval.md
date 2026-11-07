# 上游提示词行为段评估表（R2）

> 依据：claude-re-2.1.302 `dfn()` 组装函数（`tools/re/_assembly-fn.txt`，sha256 前 12 位 `0b1ef309d34d`）。
> 24 个 mm() 段注册 − 7 个实验段（已在复刻轮 C 评估，见 iteration-backlog）= **17 个行为段注册，拆分插值名后 18 行**。
> 其中 ffr 与 env_info 的段名完全由变量/插值组成，枚举时合并为一个空名，本表拆开单列。
> 三态口径：**迁移**（R3 落地）/ **不迁移**（附理由）/ **不可得**（附证据）。
> 判定日期：2026-11-07；证据均为当日现测（函数字节长度 / 字面量长度 + 首句引用）。

| # | 段 | 触发条件（原样） | 静态证据 | 判定 | 理由 / R3 动作 |
|---|---|---|---|---|---|
| 1 | communication | `${D}${be?":send_user_msg":""}`，dfr(s) | dfr 3850B，头部即 `CLAUDE_CODE_TURN_UPDATES` 实验门控 + afr/iFs/Vcn 运行时插值 | **不可得** | 段文按 turn-updates 实验与运行时状态动态组装；MyClaude 的沟通纪律已由 # Tone and style 覆盖 |
| 2 | pronouns | `${w}`，S?uLs:yfr | **勘误（R3）**：yfr 为逗号续声明，转义感知扫描已定位主 chunk，357B plain 全文 | **迁移（延期）** | 文本已定位（use they/them / never infer pronouns from a name）；证据修正后新发现，**已落地（R3.5）** |
| 3 | action_caution | `${D}`，ufr(s,S) | ufr 588B 短版 + cLs 6059B（surface 长版）静态完整 | **不迁移** | 与已迁移的 # Executing actions with care（Mfr）语义重叠——同讲可逆性/确认纪律；cLs 长版为 surface 客户端专属。若 R3 后仍觉强度不足，短版 457 字符可作追加候选 |
| 4 | task_continuity | 无条件，cfr(y) | cfr 返回 457B 静态串："When a task has been agreed, the approval covers it end to end…" | **迁移** | 任务边界纪律：已同意的任务批准覆盖全程、不中途重新请示。通用高价值。**已落地（R3）** |
| 5 | ffr | 变量名 ffr，gfr(n) | ffr = "fable_identity" 1289B（pfr = "This iteration of Claude is Claude Fable 5.1…Mythos-cl…"） | **不迁移** | 上游模型身份专属段（Fable 5.1 identity）；MyClaude| 6 | tool_param_json | jzs()‖(GU‖nEe)&&实验门控 ? hfr : null | **勘误（R3）**：hfr 精确扫描为 **117B**（R2 记 ~496B 系污染值）"Object and array parameter values must be a single JSON value — never write parameter-tag markup inside a JSON value." | **迁移** | 工具参| 7 | session_guidance | `${D}${Se?":sdk":"}:${WK()}`，Nfr(_e,V,h,Se,S) | Nfr 1844B，静态子句含 `! <command>` 前缀建议 | **不迁移** | **勘误（R3）**：静态子句依赖上游 `!` 输入框前缀机制（会话内执行 shell 并回灌输出）；实测 MyClaude 无对应机制（grep src 零命中），照搬会教模型建议不存在的功能 |
| 6 | tool_param_json | jzs()‖(GU‖nEe)&&实验门控 ? hfr : null | hfr 静态 ~496B："Object and array parameter values must be a single JSON value — never write parameter-tag markup inside a JSON value." | **迁移** | 工具参数序列化纪律，与运行时无关、适用任何 agent。**已落地（R3）** |
| 7 | session_guidance | `${D}${Se?":sdk":""}:${WK()}`，Nfr(_e,V,h,Se,S) | Nfr 1844B，含静态子句 "If you need the user to run a shell command themselves (e.g., an interactive login like …"，其余按工具集插值 | **部分迁移** | 全段运行时组装不可得；但其静态子句（让用户自己跑交互式命令/登录）是通用纪律，R3 作为独立小节落地 |
| 8 | memory | `${D}`，Rvo(await pon(s,…)) | Rvo 函数体不在两主 chunk（读运行时 memory 文件） | **不可得** | 运行时读取 memory 产物；MyClaude 已有自有 project-memory 机制（src/project-memory.js），用自家实现 |
| 9 | surface | S 分支，`surface:${rfn()}`，Ufr() | Ufr 135B：`Eg()‖bde()‖jhe()?gLs:mLs` | **不迁移** | surface 客户端专属（gLs/mLs 按 surface 环境选择）；MyClaude 非 surface 客户端 |
| 10 | env_info | `${…env_info_static/simple}${w}`，qfr(Se,S) | qfr 381B + sfr："Claude Code is available as a CLI in the terminal, desktop app (Mac/Windows), web app (claude.ai/code), and IDE extensions…" | **不迁移** | 内容是上游分发渠道宣传 + 环境注入；MyClaude 已有 # Environment 段，且不引用上游渠道 |
| 11 | bg-session | `${w}`，Kfr(S) | Kfr 2705B，头部即读 `CLAUDE_CODE_JOB_DIR`，无 job 目录即 null | **不迁移** | 上游后台 job 会话机制（CLAUDE_JOB_DIR）MyClaude 无对应 |
| 12 | context_management | `${w}`，S?TLs:Vfr | Vfr 280B（plain）/ TLs 1198B（surface）双变体静态完整："When the conversation grows long, some or all of the current context is summarized…" | **迁移** | 上下文自动压缩的预期设定（摘要连续性），与 MyClaude /compact 机制直接互补。R3 用 plain 变体（Vfr）落地 |
| 13 | system_messages | S 分支，`${D}${g7e(n)?":turns":":tags"}`，OLs(xLs/PLs) | xLs/PLs 函数体未在两主 chunk 定位；且 S(surface) 条件分支内 | **不可得** | surface 专属 + 字面量未定位；MyClaude 已有自家 <system-reminder> 注入方式 || 16 | act_dont_rederive | `${w}`，Ffr()?S?ILs:$fr:null | **勘误（R3）**：$fr 精确扫描为 **277B**（R2 记 3742B 系污染值——把后续 Hfr/Bfr 连带计入）"When you have enough information to act, act…give a recommendation, not an exhaustive survey"；ILs 483B（surface） | **迁移** | 行动纪律：已有信息直接行动、不重新推导已确立事实、给推荐不做穷举。**已落地（R3，plain 变体）** |
| 17 | delivering_work_max | `${w}`，a.CLAUDE_CODE_BISON_CAIRN??(oIe‖cFs)?S?oLs:Hfr:null | **勘误（R3）**：Hfr（plain）为逗号续声明，已定位主 chunk **2017B** 全文（"# Delivering work\nDo ordinary work as asked…"）；oLs 3227B（surface 版更长） | **迁移** | 交付纪律（不猜测用户"真正想要"、不擅自收窄/扩| 18 | overcorrection | `${w}`，uFs(s)?S?sLs:Bfr:null | **勘误（R3）**：Bfr 为逗号续声明，已定位主 chunk **1245B** plain 全文（"# Corrections\nAvoid unnecessary or excessive self-correction…"） | **迁移（延期）** | 文本已定位且通用（不过度自我纠错、后续提问≠做错信号）；证据修正后新发现，**已落地（R3.5）**
| 15 | focus_mode | `${D}`，tpr(s,S) | Xfr 881B 静态完整："The user has focus mode enabled. In focus mode, the user only sees your final text message…" | **不迁移** | MyClaude 无 focus mode 机制（TUI/GUI 均流式渲染）；未来若加 focus mode 再迁（静态原文已在 v2-full 备查） |
| 16 | act_dont_rederive | `${w}`，Ffr()?S?ILs:$fr:null | $fr 3742B（plain）/ ILs 483B（surface）静态完整："When you have enough information to act, act. Do not re-derive facts already established in the conversation, re-litigate a decisi…" | **迁移** | 行动纪律：已有信息直接行动、不重新推导已确立事实。通用高价值，R3 用 plain 变体（$fr）落地 |
| 17 | delivering_work_max | `${w}`，a.CLAUDE_CODE_BISON_CAIRN??(oIe‖cFs)?S?oLs:Hfr:null | oLs 3227B（surface）静态完整："# Delivering work … avoid speculating about wha…"；Hfr（plain）未定位 | **迁移** | 交付纪律（不过度猜测、如实报告）。R3 先补抽 plain 变体 Hfr，抽不到则用 oLs 文本评估通用性后落地 |
| 18 | overcorrection | `${w}`，uFs(s)?S?sLs:Bfr:null | sLs 非 plain 字面量（y41y4f2h 中为复杂形式）；Bfr 无 import 记录；uFs 运行时门控 | **不可得** | 两变体字面量均未定位 + 运行时门控 uFs(s)；如实放弃，上游变动时重跑 R2 |

## 小结（R3 勘误后）

- **迁移（R3 落地）：5 段** —— task_continuity(457B) / tool_param_json(117B) / context_management(280B plain) / act_dont_rederive(277B plain) / delivering_work_max(2017B plain Hfr)
- **迁移（延期，下一轮）：2 段** —— pronouns(357B plain) / overcorrection(1245B plain Bfr)——R3 证据修正后新定位，按一轮一任务铁律不顺手扩 scope
- **不迁移：9 段** —— action_caution(已被 Mfr 覆盖) / ffr(上游模型身份) / surface / env_info(渠道宣传+已有段) / bg-session(无机制) / brief(无模式开关) / focus_mode(无机制) / session_guidance(`!` 前缀机制无对应，勘误) / [memory 归不可得，机制上用自家]
- **不可得：2 段** —— communication / system_messages（运行时组装，证据见各行）

> **R3 勘误说明**：R2 的字面量长度有 3 处污染值（tool_param_json 496→117 / act_dont_rederive 3742→277 / delivering_work_max 未定位→2017B），根因是非贪婪正则把逗号续声明的相邻变量连带；R3 改用转义感知扫描器后修正。教训：长度数字必须来自转义感知的精确扫描。

## 与已迁移段的关系（防重复迁移）

六基础段（intro/system/doing_tasks/actions/tools/tone）与 7 实验段中的 subagent_steer_delegation、autonomy_append 已在先前轮次迁移（docs/claude-code-2.1.302-parity.md §2）。本表只覆盖**尚未评估的 17 个行为段注册**，与已迁移内容无交集；action_caution 判"不迁移"正是为了避免与已迁移的 actions 段重复。
