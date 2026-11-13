# 夜航报告 2026-11-14：@ 引用 / 技能双布局 / 断线续跑 / 面板全校验

> 用户指令：继续优化——任务中断；无法使用技能、无法创建技能、无法使用 @；
> 右侧分栏功能不全、左栏功能未实现；广泛调查逐项确认，对比 Claude web 版全部功能。
> 结果：**895 项全绿（894 通过 + 1 诚实 skip）**，gate:fast 三步绿，
> 断线续跑真浏览器 e2e 通过，4 个提交。

## 〇、决定性发现：用户跑的是 upstream 引擎，两个世界的技能互不可见

排查「无法使用技能」时，`/api/agent-debug`（本次新增的诊断面）给出铁证：
`sessionKeys: []`——**所有 GUI 回合都跑在 upstream 分支**（原生 Claude Code 子进程），
自研 Agent 的 skill_listing/skill_mention 注入从未生效。

上游引擎只读 Claude Code 原生布局：`<项目>/.claude/skills/` 与 `~/.claude/skills/`；
而 MyClaude 全套（GUI 面板、createSkill、loadSkills、TUI）读写 `.myclaude/skills/`。
GUI 建的技能上游引擎永远看不见——这就是「无法使用技能、无法创建技能」的断层。

e2e 对照（真实模型回合，sessionKey e2e-skill-2 vs e2e-skill-5）：
- 修复前：模型回答「/ping-test 未注册，把它当普通文本」，转头 Grep 仓库自己找定义
- 修复后：upstream 引擎逐字执行技能正文，回复 **PONG-OK-2026**

## 一、修复清单（对应用户六项主诉）

| 主诉 | 根因 | 修复 | 提交 |
|---|---|---|---|
| 无法使用 @ | 文件索引 DFS+400 条上限：根目录上百个导出文件耗光配额，src/、test/、docs/ 整体缺席；首次请求赶上后台建索引返回空列表，@ 菜单闪没 | BFS + 1500 上限 + 跳过垃圾目录（`/^[-%]/`）；首请求等索引建好；服务启动预热 | bf487d8 |
| 无法使用技能 | ① 双布局断层（见上）② GUI runCommand 把 /技能名 拦成「未知命令」③ 元消息裸文本被弱模型当闲聊忽略 | ① skillDirs 增读 .claude/skills、createSkill 双布局落盘 ② default 分支 findSkill passthrough（未命中懒刷新复查）③ <system-reminder> 包裹 + 系统提示词补上游条款 | 7a1aa6d |
| 无法创建技能 | GUI 只有 /skills 文本列表，无创建面 | POST/DELETE /api/skills + 技能管理面板（列表/新建/删除/覆盖，写入双布局）；左栏「技能」入口 + 徽标 | bf487d8 |
| 任务执行中断 | ① SSE 断开（刷新/断网/睡眠）→ res.close 直接 abort 整回合 ② 优雅关机代码被误粘进 gitNumstat 的 git-failed 分支，正常进程没有任何信号处理 | ① turnBus：回合事件进每会话缓冲并扇出；断开只摘客户端不杀回合；GET /api/turn-state + /api/turn-events 重放+跟随；前端 reattachRunningTurn 复用 handleStreamEvent；409 自动转跟随 ② 信号处理移回 startGui 顶层 | bf487d8 |
| 右栏功能不全 | （巡检后确认接线完整，无真缺口） | inspector 四 tab + artifact 19 控件全实测：全通过 | — |
| 左栏功能未实现 | TUI 97 命令中 14 条 GUI 缺失；部分入口没进菜单 | 补齐 attach/attachments/detach/base/key/computer-use/continue/rm/save/reload-memory/vision/skill/dream/loop（含服务端 save/dream 分支）+ 全部进斜杠菜单 | 7a1aa6d + 9c22357 |

## 二、真浏览器验证（CDP，非代码断言）

1. **@ 引用**：`@src/ski` → 弹出 `@src/skills.js`、`@src/skills-builtin.js` ✓
2. **斜杠菜单**：`/ver` → `/verify`（内置技能）+ `/reverse-engineer-anything`（用户技能）✓
3. **技能管理面板**：左栏入口打开、列出全部 scope 徽标、新建/删除表单在位 ✓
4. **技能真回合**：GUI 发 `/ping-test` → upstream 引擎执行 → PONG-OK-2026 ✓
5. **断线续跑（用户主诉场景）**：发长任务 → 回合运行中刷新页面 →
   新页面显示「检测到后台任务仍在运行 — 已重新接上（刷新 / 断网不再中断任务）」
   → 后台生成的全文经跟随流完整渲染 → 「回合完成 · 40 秒」→ busy 释放 ✓
6. **面板巡检**：inspector 四 tab（info/artifact/tasks/changes）全渲染；
   左栏七入口（搜索/会话/Projects/提示词库/文件/工具/智能归档）全 opens ✓

## 三、对比 claude.ai web 版功能面（逐项）

已实现且实测：新对话、会话侧栏（置顶/重命名/删除/归档/恢复/按项目/按时间）、
全文搜索、Projects 知识库（上传/片段/容量计）、提示词库、文件浏览、工具清单、
技能管理、智能归档、composer 全家桶（附件/粘贴折叠/@引用/斜杠命令+技能/语音输入/
视觉开关/风格/深度思考/权限模式/模型与供应商切换）、Artifacts 画布（预览/代码/
diff/编辑/写入工作区/版本切换/下载/弹窗/全屏/迭代）、右栏（会话详情/待办/后台任务/
变更 diff/备用模型/MCP）、导出（MD/HTML/PDF）、主题三态、快捷键面板、上下文用量、
状态行、断线续跑。

## 四、守护测试

- test/disconnect-abort.test.js 改新契约：断开保活 + turn-events 重放 + 重连收尾
  （断言 busy 保持 true → 409 → follow 流含 done → 会话释放 → 新任务可发），3/3 绿 4s
- test/skills.test.js 双布局 3 项：上游布局读取 / .myclaude 同名覆盖 / 双写双删
- test/gui-auto-command.test.js「提示中的命令必须可派发」扩展认可 EXTRA_COMMANDS
  注册表键（新命令全被旧正则误判）
- test/skills-e2e.test.js 三附件契约 8/8 保持绿

## 五、gate 与提交

```
npm run gate:fast   # tests / prompt / features 三步 PASS，1 诚实 skip
npm test            # 895 项：894 绿 + 1 登记 skip
```

提交链：bf487d8（@ 索引 + 技能 GUI 面 + turnBus 断线续跑 + 优雅关机归位）→
7a1aa6d（技能双布局 + system-reminder 包裹 + 14 命令 + agent-debug）→
9c22357（菜单补齐 + hint 守卫扩展）→ 本报告与 gate 基线随最后一提交入库。

## 六、复测方式

```bash
npm run gate:fast
node --test test/disconnect-abort.test.js        # 断线续跑 3 项
node --test test/skills.test.js test/skills-e2e.test.js   # 技能 19 项
curl -s localhost:7801/api/agent-debug            # 服务进程的技能目录/工具/meta 视图
# 浏览器实测：发长任务 → F5 刷新 → 应见「已重新接上」并继续出字
```

## 七、遗留（非本轮主诉）

- GUI 的 @ 菜单在技能管理弹层开着时选文本焦点异常（关闭弹层后一切正常）——低频
- upstream 引擎的技能热发现依赖引擎自身（会话中途新装技能需新会话才可见）——上游行为
- 快速模式（fastMode）窗口下的 meta 注入位置与全量模式一致，未单独实测弱窗口场景
