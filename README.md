# MyClaude

一个原创的终端 AI 编程助手（CLI agent），支持工具调用、流式输出、多轮自主执行。

**不是** Claude Code 的复制品：全部代码原创，无任何 Anthropic 专有代码。

变更记录见 [CHANGELOG.md](./CHANGELOG.md)。

---

## 快速开始

```bash
cd E:\WorkSpaces\Test09\MyClaude

# 交互 TUI（Ink，默认）
node bin/myclaude.js
.\dist\myclaude.exe

# Web GUI（浏览器）
.\dist\myclaude.exe --gui
# 或双击 MyClaude GUI.lnk

# 简单 REPL（无 React）
.\dist\myclaude.exe --plain

# 一次性提问
.\dist\myclaude.exe --auto -p "列出当前目录的文件"
```

## 三种界面

| 界面 | 启动 | 特点 |
|---|---|---|
| **TUI**（默认） | `myclaude` | Ink + React；圆角输入框、工具调用卡片、底部状态栏、Ctrl+C 中断、Ctrl+L 清屏 |
| **GUI** | `myclaude --gui` | 本地 HTTP 服务（:7788）+ 浏览器界面；工具卡片可展开、确认弹窗、模式下拉、模型切换 |
| **Plain** | `myclaude --plain` | 纯 readline REPL，零 React 依赖，适合管道/远程终端 |

### TUI 界面元素

```
⏺ Read(file_path: E:\project\src\main.js)
  ✔ 12ms
  │ 1  import ...
  │ 2  ...

> Ask anything, /help for commands
╭─────────────────────────────────────────╮
│ model deepseek-v4.1-flash │ mode ask │ provider openai │ working… │
╰─────────────────────────────────────────╯
```

- 工具调用显示为 `✔ ⏺ 名称(参数)  12ms` + 输出预览（默认 3 行，最近一次自动展开）
- `Ctrl+O` 展开/收起全部工具输出
- `↑` / `↓` 浏览命令历史
- 流式文本用洋红色实时渲染，带 spinner
- 权限询问以黄色圆角框弹出，输入 `y`/`n`
- `Ctrl+C` 中断当前请求；空闲时退出
- `Ctrl+L` 清屏
- 底部状态行：model / mode / provider / turn / 消息数 / working

### GUI 界面元素

三栏布局，视觉语言参考 Claude 自己的界面：暖中性色 + 单一陶土橙强调色、发丝级边框、克制的留白。

```
┌────────────┬──────────────────────────────┬──────────────────┐
│ New chat   │  new chat · model · mode     │  INSPECTOR       │
│            ├──────────────────────────────┤  Session         │
│ CHATS      │                              │   model / mode   │
│  会话 1    │        Welcome               │   cwd / session  │
│  会话 2    │   建议卡片 · 快捷键提示      │  Tasks (TodoWrite)│
│            │                              │  Tools           │
│ WORKSPACE  ├──────────────────────────────┤                  │
│  Files     │  [⎘] Ask anything…  ask  ▣ ↑ │                  │
│  Tools 17  │  Enter 发送 · Esc 停止       │                  │
└────────────┴──────────────────────────────┴──────────────────┘
```

- **左栏（rail）**：新建对话、搜索（命令面板）、会话列表（点击恢复、hover 删除）、工作区入口（Files / Tools / Tasks）、历史（Sessions / Settings）、底部主题切换
- **中栏**：会话顶部信息（模型 · 模式 · 目录 · 轮次）、消息流、底部输入区
- **右栏（inspector）**：Session 元信息、Tasks（TodoWrite 实时列表 + 进度条）、Tools 清单
- **消息渲染**：助手回复用 Markdown 渲染（标题、列表、任务清单、表格、引用、代码块带语言标签与一键复制、行内代码、链接），流式过程中带光标
- **工具卡片**：折叠式，显示状态点、工具名、一行参数摘要与耗时；展开看完整参数 JSON 和输出
- **主题**：暗色 / 亮色一键切换，选择记在 localStorage；`?theme=light|dark` 可强制
- **快捷键**：`Ctrl+K` 命令面板 · `Ctrl+B` 收起侧栏 · `Ctrl+L` 新对话 · `Ctrl+U` 附件 · `Ctrl+,` 设置 · `Esc` 停止生成 / 关闭弹层

#### 动效与流畅度

- 动效令牌统一在 `styles.css` 的 `:root`：`--ease / --ease-out / --ease-spring` 与 `--dur-1..4`（90–340ms）
- 消息、工具卡、通知、建议卡片逐条进场（上浮 + 淡入，建议卡片阶梯延迟）
- 控件反馈：按钮按压下沉、主按钮悬浮抬升并带色晕、焦点环延迟展开、会话删除按钮渐显
- 状态指示：流式光标呼吸、思考图标缓慢旋转、运行中工具的状态点涟漪、进度条缓动
- 流式渲染按帧合并（`requestAnimationFrame`），不再每个 token 重建整段 DOM
- 滚动带「贴底」判断：向上翻阅历史时不会被新内容拽回，偏离 240px 后出现回到底部按钮
- 尊重 `prefers-reduced-motion`；也可以用 `?motion=off` 或设置项强制关闭

#### 消息操作

| 操作 | 位置 | 说明 |
|---|---|---|
| 复制 | 助手消息 / 用户消息 | 复制原始 Markdown 或原文 |
| 重试 | 助手消息 | 回退上下文后重新回答，不会重复历史 |
| 编辑重发 | 用户消息 | 把内容填回输入框，改完再发 |
| 导出 | 会话右键菜单 | 下载整段对话为 Markdown |
| 重命名 / 置顶 | 会话右键菜单 | 置顶的会话排在列表最前 |
| 图片预览 | 消息内图片 | 点击全屏查看，`Esc` 关闭 |

#### 思考过程与用量

- 等待首个 token 时显示「Thinking…」条，首字到达后变为「Thought for Ns」，可展开
- 顶栏右侧的用量环显示当前上下文占用：70% 转琥珀色、90% 转红色，悬停看精确 token 数

#### 会话管理

- 每个浏览器标签页有独立会话（`sessionKey`），互不干扰
- 每轮对话结束自动写盘到 `~/.myclaude/sessions/`；左栏列出全部历史会话，标题取自第一条用户消息
- 点击会话恢复上下文并重放消息流，`×` 删除

#### 停止生成

生成过程中发送按钮变为停止按钮（或按 `Esc`），调用 `POST /api/abort` 中止当前 provider 请求并解除挂起的确认框。

#### 文件浏览与后台任务

- `/api/fs` 列出工作目录（限制在 cwd 内，越界返回 403），点击文本文件以高亮只读视图打开，二进制文件只显示大小
- `/api/tasks` 列出 `Bash(run_in_background=true)` 启起的后台任务及退出码

#### 附件上传（视觉能力）

三种方式，效果一致：

1. 点击输入框左侧 📎 选择文件（可多选）
2. 直接把文件拖进浏览器窗口（出现虚线拖放区）
3. 在输入框里粘贴截图（Ctrl+V）
4. 命令行：`/attach <路径> [更多路径…]`

- 图片（png/jpg/jpeg/gif/webp/bmp，≤5MB）以 base64 走 `image_url` 多部分消息发给模型
- 文本文件（≤200KB）内联成 `[attached file: name]` 文本块
- PDF 等二进制只传引用，由 agent 自己用 `Read` 打开
- 附件以 chip 显示在输入框上方，可单个删除；发送后自动清空
- 顶栏 `vision: on/off`（或 `/vision off`）可关闭图片上传——模型不支持视觉时，图片只发送文件名说明，避免 400
- 工具返回的图片（例如 `Read` 一个 .png）会自动转成一条后续 user 消息，因为 `tool` role 只接受字符串

#### 模式切换

- 顶栏下拉或 `/mode ask|auto|plan`，**立即生效**（`agent.setMode()` 重建系统提示词，不用重启）
- `plan` 模式是真正的只读：Read/LS/Glob/Grep/WebFetch/WebSearch/NotebookRead/TodoWrite/AskUserQuestion/ExitPlanMode/BashOutput 免确认放行，Write/Edit/MultiEdit/NotebookEdit/Bash/KillShell 直接拒绝
- 计划写好后模型调用 `ExitPlanMode`，浏览器弹出「Approve / Reject」；Approve 后自动切回 `ask` 模式开始执行

#### 交互式提问

模型调用 `AskUserQuestion` 时，GUI 渲染单选/多选卡片，支持选项点击或自由文本作答；TUI 渲染数字选择面板。

## 命令

| 命令 | 说明 |
|---|---|
| `/help` | 显示帮助 |
| `/exit` `/quit` | 退出 |
| `/clear` | 清空对话历史 |
| `/model [name]` | 查看/切换模型 |
| `/provider [name]` | 查看/切换 provider |
| `/base [url]` | 查看/设置 API base URL |
| `/key [key]` | 查看/设置 API key |
| `/mode [ask\|auto\|plan]` | 权限模式（立即生效） |
| `/attach <path…>` | 附加图片/文本文件到下一条消息 |
| `/attachments` | 查看待发送附件 |
| `/detach` | 清空待发送附件 |
| `/vision [on\|off]` | 是否把图片发给模型 |
| `/tools` | 列出可用工具 |
| `/mcp` | 查看 MCP 服务器连接状态 |
| `/stats` | 会话统计 |
| `/config` | 显示当前配置 |
| `/models` | 列出 provider 可用模型 |

## 命令行参数

```
-h, --help        帮助
-v, --version     版本
-p, --print TEXT  一次性执行后退出
--auto, --yes     自动批准所有工具调用
--plan            只读模式，拒绝所有写操作
--gui, --web      启动 Web GUI（默认端口 7788）
--port N          指定 GUI 端口
--no-open         GUI 启动时不自动开浏览器
--plain           用 readline REPL 而非 Ink TUI
--config-path     打印配置文件路径
```

## 工具集（21 个）

**文件**
| 工具 | 能力 |
|---|---|
| `Read` | 读文件（带行号，支持 offset/limit）；图片返回可视附件，PDF 尽力抽取文本 |
| `Write` | 写文件（自动建父目录） |
| `Edit` | 精确字符串替换（唯一性校验 / replace_all） |
| `MultiEdit` | 单文件多编辑，全量校验后才落盘（原子） |
| `LS` / `Glob` / `Grep` | 列目录、通配查找、正则搜索 |
| `NotebookRead` / `NotebookEdit` | 读写 Jupyter 笔记本（含 percent 脚本） |

**执行**
| 工具 | 能力 |
|---|---|
| `Bash` | 执行 shell 命令（PowerShell / sh），支持 `run_in_background` |
| `BashOutput` | 按 offset 增量读取后台任务输出 |
| `KillShell` | 终止后台任务（Windows 用 `taskkill /T /F` 结束进程树） |
| `Task` | 委派子 agent（general 全权限 / explore 只读），**不可递归委派** |

**Git**
| 工具 | 能力 |
|---|---|
| `GitStatus` | 分支、staged/unstaged/untracked、最近提交（结构化返回） |
| `GitDiff` | 统一 diff，同时返回解析后的 files/hunks/add/del，GUI 渲染为着色视图 |
| `GitLog` | 提交历史（count / paths / range / oneline） |
| `GitCommit` | 按 paths 或 add_all 暂存后提交，拒绝空消息与空暂存区 |

**网络与交互**
| 工具 | 能力 |
|---|---|
| `WebFetch` | 抓取 http(s) 页面并转可读文本（30s 超时） |
| `WebSearch` | 联网搜索（支持 allowed_domains / block_domains） |
| `TodoWrite` | 任务列表（按会话隔离，整体替换语义） |
| `AskUserQuestion` | 向用户提澄清问题（单选/多选/自由文本） |
| `ExitPlanMode` | 提交方案等待批准，批准后自动切回 ask 模式 |

此外还有 MCP 桥接工具，以 `<server>__<tool>` 命名。

### 子 agent（Task）

```
Task(description="查找配置", prompt="完整自包含的指令…", subagent_type="explore")
```

- 独立上下文，不污染主会话
- `explore` 走只读白名单（Read/LS/Glob/Grep），`general` 全工具
- 子 agent 不阻塞交互（自动批准，只读性由工具白名单保证）
- 工具调用以 `↳` 前缀显示在主界面

### MCP

在 `~/.myclaude/config.json` 的 `mcpServers` 里添加，支持三种传输：

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "E:\\WorkSpaces"]
    },
    "github": {
      "url": "https://api.githubcopilot.com/mcp/",
      "headers": { "Authorization": "Bearer <token>" }
    },
    "legacy-sse": {
      "url": "http://127.0.0.1:3001/sse",
      "transport": "sse"
    }
  }
}
```

| 写法 | 传输 | 说明 |
|---|---|---|
| `command` + `args` | stdio | 本地子进程 |
| `url` | Streamable HTTP | 现代协议；若服务器只支持旧式 SSE，会自动回退 |
| `url` + `transport: "sse"` | HTTP + SSE | 强制使用 2024 拆分协议 |

- MCP 工具以 `<server>__<tool>` 命名暴露给模型
- `/mcp`（TUI）或 GUI 检查器的「MCP 服务器」分区查看状态：待连接 / N 工具 / 失败原因
- `disabled: true` 可临时停用某个服务器而不删配置
- 每个服务器支持 `timeoutMs`（默认 60 秒）与 `headers`（鉴权）

## 配置

配置文件：`~/.myclaude/config.json`（首次运行自动创建）

```json
{
  "provider": "openai",
  "baseUrl": "http://127.0.0.1:8000/v1",
  "apiKey": "wb-local-8888",
  "model": "deepseek-v4.1-flash",
  "maxTokens": 8192,
  "temperature": 0.7,
  "permissionMode": "ask",
  "vision": true,
  "maxTurns": 100,
  "contextWindow": 1000000,
  "compactThreshold": 0.8
}
```

### 备用模型与自动切换

主端点的 API 出问题（限流、配额、5xx、超时、网络不可达）时，自动切到备用免费模型，对话不中断。

配置里的 `fallbacks` 是一个**完整的 provider 覆盖列表**，可以指向完全不同的主机和密钥：

```json
{
  "model": "deepseek-v4.1-flash",
  "requestTimeoutMs": 90000,
  "fallbacks": [
    { "name": "gpt-oss-20b",  "baseUrl": "https://integrate.api.nvidia.com/v1", "apiKey": "<NVIDIA key>", "model": "openai/gpt-oss-20b" },
    { "name": "glm-5.3-flash","baseUrl": "https://integrate.api.nvidia.com/v1", "apiKey": "<NVIDIA key>", "model": "z-ai/glm-5.3-flash" }
  ]
}
```

- **切换条件**：429 限流、配额耗尽、5xx、408 超时、网络错误、401/403（换密钥可能成功）
- **不切换**：400/422 等请求本身有问题的情况直接报错，避免每个模型都白试一遍
- **不切断**：用户主动中断（`Esc`）不会被当成失败去切换
- **选中即记住**：切换成功后后续轮次都用新模型，GUI 检查器里能看到当前模型与累计切换次数
- **超时保护**：`requestTimeoutMs` 默认 90 秒；只在等响应头时计时，流式生成中途不会被打断

NVIDIA 密钥放在环境变量里即可，默认备用池会自动读取：

```powershell
$env:MYCLAUDE_NVIDIA_KEY = "<your NVIDIA NIM key>"
```

把 `fallbacks` 设为 `[]` 就关闭自动切换。

### 环境变量覆盖

```
MYCLAUDE_BASE_URL
MYCLAUDE_API_KEY
MYCLAUDE_MODEL
MYCLAUDE_PROVIDER
```

### 切换后端

任何 OpenAI 兼容端点都可以：

```bash
# WorkBuddy 国际版 (:8000)
/base http://127.0.0.1:8000/v1
/key wb-local-8888
/model deepseek-v4.1-flash

# WorkBuddy 国内版 (:8001)
/base http://127.0.0.1:8001/v1
/key wb-cn-8888
/model hy3

# qoder-bridge (:8102)
/base http://127.0.0.1:8102/v1
/model qfmodel

# 官方 OpenAI / 任何兼容服务
/base https://api.openai.com/v1
/key sk-...
/model gpt-4o
```

## 权限模式

| 模式 | 行为 |
|---|---|
| `ask` | 每个写操作前询问（默认） |
| `auto` | 全部自动批准 |
| `plan` | 只读：探索类工具放行，写操作拒绝；`ExitPlanMode` 审批后自动切 `ask` |

运行时切换：TUI/GUI 下拉或 `/mode`，走 `agent.setMode()`，即时重建系统提示词，无需重启。

## 架构

```
src/
├── main.js              CLI 入口、参数解析、TUI/GUI/Plain 路由、命令处理
├── config.js            配置加载/保存（~/.myclaude/config.json）
├── session.js           会话持久化（~/.myclaude/sessions/）
├── attachments.js       附件读取、mime 识别、多部分消息组装、vision 开关
├── agent/
│   ├── agent.js         Agent 主循环（stream → tool calls → 回灌 → 重复）、setMode/setVision
│   ├── runtime.js       装配扩展工具 + MCP
│   ├── permissions.js   权限规则引擎 + MYCLAUDE.md 记忆
│   └── prompt.js        系统提示词
├── providers/
│   ├── openai.js        OpenAI 兼容 SSE 流式客户端 + tool_calls 累积 + 请求超时
│   └── router.js        ProviderRouter：错误分类与备用模型故障转移
├── mcp/
│   ├── client.js        MCP 客户端（stdio / Streamable HTTP / SSE 自动协商）
│   └── http-transport.js 两种 HTTP 线格式的实现
├── tools/
│   ├── index.js         核心工具（Read/Write/Edit/MultiEdit/LS/Glob/Grep/Bash/BashOutput/KillShell）
│   ├── extra.js         TodoWrite / WebFetch
│   ├── extended.js      WebSearch / NotebookRead / NotebookEdit / AskUserQuestion / ExitPlanMode
│   ├── git.js           GitStatus / GitDiff / GitLog / GitCommit + diff 解析器
│   └── tasks.js         后台任务注册表
├── ui/
│   ├── ink-app.js       Ink TUI 组件（App / ToolItem / StatusBar / AttachmentBar）
│   ├── ink-ui.js        Ink 渲染入口
│   ├── tui-bridge.js    Agent ↔ Ink 的状态桥（subscribe/emit）
│   ├── gui-server.js    GUI 的 HTTP + SSE 服务（路由、多会话、abort、文件浏览）
│   ├── assets.js        GUI 静态资源加载：磁盘优先，exe 内嵌兜底
│   └── web/             浏览器端代码（无构建步骤，原生 ES）
│       ├── page.html    页面骨架
│       ├── css/styles.css   完整样式（明暗双主题、三栏布局）
│       └── js/
│           ├── app.js       交互逻辑（消息流、工具卡、会话、面板）
│           └── markdown.js  Markdown 渲染 + 轻量语法高亮
└── scripts/bundle-gui.mjs  把 web/ 内联进 assets.js（构建 exe 前执行）
```

**UI 抽象**：`Agent` 只依赖 6 个 UI 方法（`streamText` / `endStream` / `toolStart` / `toolEnd` / `confirmTool` / `info|warn|error|success`），因此三种界面可以互换。TUI 通过 `TuiBridge` 做状态订阅，GUI 通过 SSE 事件推送。

### Agent 循环

```
user input
  → provider.streamChat(messages, tools)
  → 流式渲染 text
  → 若返回 tool_calls：
      逐个执行（权限检查 → 运行 → 结果回灌为 role:"tool"）
      → 回到 streamChat（下一轮）
  → 若无 tool_calls：结束
```

上限 `maxTurns`（默认 100）防止无限循环。

### 上下文压缩

超过 `contextWindow × compactThreshold` 时，保留最近 6 条消息，其余替换为一条压缩标记。当前是简单截断策略，可替换为 LLM 摘要。

## 测试

```bash
node --test "test/*.test.js"
```

130 个测试覆盖：工具边界（偏移读取、歧义编辑、无匹配、非零退出码）、附件（mime 识别、超大拒绝、多部分消息组装、工具图片回灌）、模式切换（plan 只读白名单、ExitPlanMode 审批后自动切 ask）、Markdown 渲染（XSS 转义、危险协议拦截、表格/列表/代码块）、GUI HTTP/SSE 端到端（上传、聊天、提问往返、多会话隔离、abort、文件浏览越界拒绝、权限规则、会话增删、
重命名与置顶、Markdown 导出、上下文用量）、Git 工具（在临时仓库中跑真实 git，覆盖状态/差异/日志/提交与解析器）、MCP HTTP 传输（mock 服务器验证 Streamable 与 SSE 两种协议、自动回退、失败上报）、故障转移（限流/超时/5xx 切换、400 不切换、用户取消不切换）。

Token 用量：端点上报 `usage` 时按真实值累加，未上报时回退为字符估算（界面标 `≈`）。

测试使用 `MYCLAUDE_HOME` 指向临时目录，不会读写你真实的 `~/.myclaude/`。

## 构建

```bash
npm run build      # 先内联 GUI 资源，再编译单文件
```

`scripts/bundle-gui.mjs` 会把 `src/ui/web/` 下的页面、样式与脚本写进 `src/ui/assets.js`
的 `EMBEDDED` 块，因此编译出的 exe 不依赖任何外部文件。直接改 `web/` 后记得重新执行
`npm run build:embed`（或 `npm run build`）。

用 `node bin/myclaude.js --gui` 运行时不会用到内嵌副本：服务器优先读取磁盘上的 `web/`，
改完前端刷新浏览器即可生效，无需重启、无需构建。

产物 `dist/myclaude.exe`（82.6 MB，含 Bun 运行时 + Ink/React，无需 Node）。

> **注意**：`node_modules/react-devtools-core` 是一个 no-op stub（`vendor/` 有源），
> 仅用于满足 Ink 的 `process.env.DEV === 'true'` 分支静态解析。正常运行时该分支不执行。

## 与 Claude Code 的差异

| 方面 | MyClaude | Claude Code |
|---|---|---|
| 代码来源 | 原创 | Anthropic 专有 |
| 后端 | 任意 OpenAI 兼容 | Anthropic API / Bedrock / Vertex |
| 登录 | 无需登录 | OAuth / API Key |
| 界面 | Ink TUI + Web GUI + Plain REPL | Ink TUI |
| 工具数 | 17 | ~20+ |
| 子 agent | 有（Task） | 有 |
| 附件/视觉 | 有（GUI 拖放/粘贴/选择 + `/attach`） | 有 |
| MCP 支持 | 有（stdio） | 有 |
| 会话恢复 | 有（JSON 持久化） | 有 |

## 许可

本项目代码为原创，可自由使用和修改。



<!-- test -->
