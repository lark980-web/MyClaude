# 对齐 Claude Code 剩余目标（2026-10-30 夜间循环）

> 本文件是「逐项对比→实现→测试」循环的工作清单。完成的划掉并更新
> replica/features.csv。对照基准：claude-src 2.1.276 + 已安装 CLI 2.1.302。

## 已完成

- [x] /review —— ca93a72（TUI customPrompt 通道 + GUI runCommand 组提示词）
- [x] /output-style —— a748fe6 + 862c319 + 14a0663（内置三风格 + 自定义 md +
      agent.setOutputStyle 重建系统提示 + /api/output-styles + config 白名单）

## 待做（按价值排序）

### 1. Esc+Esc 编辑上一条消息（TUI）
- Claude Code：按两次 Esc 打开上一条用户消息进行编辑/回退，改动作为新回合发出
- MyClaude 现状：main.js TUI 有输入历史（上箭头），无 Esc+Esc 回溯编辑
- 实现点：main.js 的 TUI 输入处理（TerminalUI/bridge keybinding），
  双击 Esc → 取上一条用户消息填回输入框并把会话 rewind 到该消息前
- 注意：agent.rewind(text) 已存在（/undo 用过），复用

### 2. /statusline 自定义状态行（TUI）—— 首次实现有挂起问题已回滚，待交互调试
- Claude Code：statusline 命令 + settings.json 的 statusLine 字段，
  自定义脚本输出一行状态（模型/分支/token 等）
- 实现点：config.statusLineCommand；TUI 每次渲染底行时 spawn 脚本取输出；
  /statusline 无参说明 + 带参设置/清除

### 3. /bashes（低优先）
- /tasks 已超集覆盖（含 LOCAL_BASH 筛选与 BashOutput/KillShell）；
  可加别名让 /bashes 等价 /tasks，一行代码

### 4. /vim（低优先，工作量大）
- TUI 输入框 vim 模式（normal/insert、hjkl、w/b、dd…）
- 建议：只做 normal/insert 切换与基础移动，其余放后续

## 明确跳过（Anthropic 生态专属，本地复刻无意义）

- /ide、/login、/logout、/install-github-app、/pr-comments、/usage、
  /privacy-settings、/bug、--chrome、--cloud、--from-pr、teleport

## 验证方式

- TUI 命令：spawnSync exe --plain 喂命令，断言输出标记
- GUI 命令：app.js runCommand 分支 + 端点 fetch 断言
- 单元：test/*.test.js 对应文件


## 语义验证记录（2026-10-30 02:50，对真实 exe --plain 逐命令）

- ✅ /context /cost /stats：统计块完整（消息/回合/上下文水位/累计 token）
- ✅ /memory：输出记忆内容（# From...）
- ✅ /hooks /agents /todos /mcp /skills：正确的空态+添加指引
- ✅ /permissions：规则列表（allow...）
- ✅ /config：完整 JSON；/doctor：健康检查逐项 ok
- ✅ /tools：全工具清单；/compact /rewind：正确的空态提示
- 注：Claude 的 /plugins 在 MyClaude 叫 /plugin（单数），已存在

剩余待做：/vim（需 raw-mode 重写）、/statusline（TTY 调试）、
Esc+Esc 的 GUI 等价物（右栏消息编辑）。

## 追加验证（2026-10-30 03:05）

- ✅ GUI 消息编辑（Esc+Esc 等价物）：「编辑」→内联编辑→「保存并重新生成」，
  带分支快照与后续轮次截断——超出 Claude 基础版，无需另做
- ✅ @ 文件引用补全：at-menu + btn-at + closeAtMenu 全链路在位

- ✅ Hooks 生命周期实测：SessionStart 以 Claude 同款 schema（matcher 包 hooks 数组）写入 config 后，真实 exe 启动即触发（标记文件落地）
