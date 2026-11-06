# 用本机 Bun 引导原版 Claude Code 2.1.302 提取树（实测记录）

- 记录人：bootstrap-scribe（共享任务 task-2）
- 实测时间：2026-11-06 11:21 – 11:40（Asia/Shanghai）
- 被测对象：`E:\WorkSpaces\Test09\claude-re-2.1.302\02-modules\files`（Bun 独立可执行文件的提取明文树）
- 工作区：`E:\WorkSpaces\Test09\MyClaude`（git HEAD `7fb754804f2f5a8a4d27971d6df827df4540a717`，分支 main）
- 一句话结论：**该提取树可以用本机 Bun 1.4.2 直接引导运行 `--version` / `--help` / `--print`；把 `ANTHROPIC_BASE_URL` 指向本地网关后能完整跑完一个回合，并且真的调用了 Read 工具读到工作区文件。**

文中命令、输出、耗时都是本次实测采集的。凡是没测到的，在第 6 节明确写成未测。

---

## 1. 两类陈述的标记

| 标记 | 含义 |
| --- | --- |
| **【观测】** | 本次实际执行命令后看到的东西（输出、退出码、耗时、文件树、git 状态） |
| **【推断】** | 由观测结果推出的解释，未被独立实验证明 |

---

## 2. 前置条件（本次实测时的状态）

**【观测】** 逐条核对：

```text
B:\: => E:\WorkSpaces\Test09\_bunroot
junction: E:\WorkSpaces\Test09\_bunroot\~BUN\root -> E:\WorkSpaces\Test09\claude-re-2.1.302\02-modules\files (Junction)
bun --version: 1.4.2
git HEAD = 7fb754804f2f5a8a4d27971d6df827df4540a717
```

- `B:` 是 subst 映射（不是新盘符设备），目标 `E:\WorkSpaces\Test09\_bunroot`。
- `B:\~BUN\root` 是 Junction，指向 `E:\WorkSpaces\Test09\claude-re-2.1.302\02-modules\files`。
- 入口是 `B:\~BUN\root\cli`（24 614 字节，无扩展名，首行 `// @bun @bytecode`，文件头自带 `// Version: 2.1.302`）。
- `~BUN/root` 下实际文件数：**5 129**。
- `~BUN/root` 下 2 444 个 .js 文件中，**2 239 个**文本里含 `B:/~BUN/root/` 这种绝对导入路径。
- 本机 PATH 里**没有** bun，必须写全路径 `C:\Users\Admin\.bun\bin\bun.exe`。

**【推断】** `B:` 不是装饰：提取树的模块解析用了写死的绝对路径 `B:/~BUN/root/...`（原版是 Bun 独立可执行文件，这些路径在它自带的虚拟文件系统里存在）。文件只有落在 `B:\~BUN\root` 之下，这些 specifier 才能解析到真实文件。

**【观测】** 本地网关：

```text
GET  http://127.0.0.1:3425/v1/models    -> 200，data 数组长度 = 49
POST http://127.0.0.1:3425/v1/messages  -> 200，返回标准 Anthropic message 对象
```

49 个 id 的完整清单可自行复现：

```powershell
(Invoke-WebRequest 'http://127.0.0.1:3425/v1/models' -UseBasicParsing).Content |
  ConvertFrom-Json | ForEach-Object data | Select-Object -ExpandProperty id | Sort-Object
```

**【观测】** 本次用到的两个 id 都在清单里：`loomy/DeepSeek-V4.1-Flash`（可用）、`amd/Gemma-4-31B-IT`（网关收下，但上游 502）。同批抽测还看到 `sensenova/glm-5.3` 返回 429、`zcode/GLM-5.3-Flash` 返回 502。

---

## 3. 运行环境（把状态写进隔离 HOME）

每次 claude 运行都在下面这份环境里执行：

```powershell
$bun  = 'C:\Users\Admin\.bun\bin\bun.exe'
$cli  = 'B:/~BUN/root/cli'
$iso  = 'E:\WorkSpaces\Test09\_bunroot\_iso_home'   # 隔离 HOME，可随时删

$env:HOME = $iso
$env:USERPROFILE = $iso
$env:ANTHROPIC_BASE_URL = 'http://127.0.0.1:3425'
$env:ANTHROPIC_API_KEY  = 'sk-local-gateway'         # 本地网关不校验真实 key
Remove-Item Env:ANTHROPIC_AUTH_TOKEN -ErrorAction SilentlyContinue
```

**【观测】** 本机 shell 里本来没有任何 `ANTHROPIC_*` / `CLAUDE_*` 环境变量（枚举为空），所以上面是唯一来源。

**【观测】** 会话状态确实跟着 HOME 走：指向 `$iso` 后，产物落在 `$iso\.claude\...` 与 `$iso\.claude.json`；真实 `C:\Users\Admin\.claude` 的 LastWriteTime 全程停在 2026/11/6 11:03（早于本次实测开始时间），本次运行没有改写它。

**【观测｜踩坑】** 把 prompt 当 PowerShell 参数传容易被拆错：

```text
Error: Input must be provided either through stdin or as a prompt argument when using --print
```

可靠做法是把 prompt 写进文件、用 stdin 重定向喂进去（见 G4/G5）。

---

## 4. 逐步实测（命令 + 真实输出 + 耗时）

耗时是 Get-Date 差值（墙钟），**随缓存冷热浮动**。

### G1 —— 能不能启动、报不报版本

```powershell
& $bun $cli '--version'
```

```text
2.1.302 (Claude Code)
```

**【观测】** 退出码 0，耗时 **294 ms**。同一命令在本会话最早一次运行时是 **5 458 ms** —— 差别只在 Bun 首编译/缓存冷热。

### G2 —— `--help` 能不能产出真实命令面

```powershell
& $bun $cli '--help'
```

**【观测】** 退出码 0，**311 行**，耗时 **2 583 ms**。节选（原样）：

```text
Usage: claude [options] [command] [prompt]

Claude Code - starts an interactive session by default, use -p/--print for
non-interactive output

Arguments:
  prompt                                Your prompt

Options:
  --add-dir <directories...>            Additional directories to allow tool
                                        access to
...
  -p, --print                           Print response and exit (useful for
                                        pipes). Note: The workspace trust dialog
                                        is skipped when Claude is run in
                                        non-interactive mode (via -p, or when
                                        stdout is not a TTY, e.g. piped or
                                        redirected output). Only use this in
                                        directories you trust. ...
...
  --tools <tools...>                    Specify the list of available tools from
                                        the built-in set. Use "" to disable all
                                        tools, "default" to use all tools, or
                                        specify tool names (e.g. "Bash,Edit,Read").
...
Commands:
  agents [options]                      Manage background agents
  auth                                  Manage authentication
  doctor                                Check the health of your Claude Code
                                        installation. ...
  gateway [options]                     Run the enterprise auth/telemetry
                                        gateway
  mcp                                   Configure and manage MCP servers
  plugin|plugins                        Manage Claude Code plugins
  setup-token                           Set up a long-lived authentication token
                                        (requires Claude subscription)
  ultrareview [options] [target]        Run a cloud-hosted multi-agent code
                                        review ...
  update|upgrade                        Check for updates and install if
                                        available
```

**【观测】** `Options:` 段 1 处、`Commands:` 段 1 处，共 311 行 —— 这是完整的 CLI 面，不是残桩。

### G3 —— 不带任何凭据时 `--print` 的行为

```powershell
# 全新隔离 HOME，并显式清掉两个网关变量
$env:HOME = "$work\home_nocred"; $env:USERPROFILE = "$work\home_nocred"
Remove-Item Env:ANTHROPIC_BASE_URL, Env:ANTHROPIC_API_KEY -ErrorAction SilentlyContinue
Set-Content "$work\p.txt" -Value 'Reply with exactly: pong' -NoNewline
Start-Process -FilePath $bun -ArgumentList @($cli,'--print') -NoNewWindow -PassThru -RedirectStandardOutput "$work\G3.out" -RedirectStandardError "$work\G3.err" -RedirectStandardInput "$work\p.txt"
```

```text
stdout: Not logged in · Please run /login
stderr: (空)
退出码: 1        耗时: 10 151 ms
```

**【观测】** 报的是「未登录」，不是模型不存在、也不是崩溃；退出码 1；stdout/stderr 分离正常。

**【观测】** 未登录的一次运行也会在隔离 HOME 建出状态：

```text
<probe>\home_nocred\.claude.json
<probe>\home_nocred\.claude\backups\.claude.json.backup.1793936270795
<probe>\home_nocred\.claude\projects\E--WorkSpaces-Test09-MyClaude\memory
<probe>\home_nocred\.claude\projects\E--WorkSpaces-Test09-MyClaude\60cb1bf5-....jsonl
<probe>\home_nocred\.claude\sessions
<probe>\home_nocred\AppData\Roaming
```

那条 .jsonl 的最后一条就是失败记录：

```json
{"type":"assistant","error":"authentication_failed","isApiErrorMessage":true,
 "message":{"model":"<synthetic>","role":"assistant","stop_reason":"stop_sequence",
 "content":[{"type":"text","text":"Not logged in · Please run /login"}]}}
```

### G4 —— 指向本地网关，跑通一个纯文本回合

```powershell
'Reply with exactly: pong' | & $bun $cli --print --model 'loomy/DeepSeek-V4.1-Flash' --output-format json
```

**【观测】** 退出码 0；与 G5 并行时两者公共墙钟 **18 740 ms**；该进程自报 `duration_ms: 5370`、`duration_api_ms: 4902`。stdout 是一行 JSON（关键字段原样摘录）：

```json
{"duration_api_ms":4902,"stop_reason":"end_turn","session_id":"502f510a-71f7-41f3-a53a-be7ff7fa694a",
 "total_cost_usd":0.0392376,
 "usage":{"input_tokens":9180,"cache_read_input_tokens":12288,"output_tokens":3},
 "modelUsage":{"loomy/DeepSeek-V4.1-Flash":{"contextWindow":200000,"maxOutputTokens":32000,
   "canonicalModel":"loomy/deepseek-v4.1-flash","provider":"firstParty","costBasis":"unknown"}},
 "permission_denials":[],"terminal_reason":"completed","is_error":false,"num_turns":1,
 "subtype":"success","result":"pong","ttft_ms":5293,"duration_ms":5370,"type":"result"}
```

stderr 只有一行告警：

```text
[claude-code:unrecognized_model] {"model":"loomy/DeepSeek-V4.1-Flash","query_source":"sdk"}
```

**【观测】** 回合真的完成（`subtype: success`、`is_error: false`、`result: pong`），且 `cache_read_input_tokens=12288` 说明 prompt 缓存在网关侧也命中了。

### G5 —— 真的调用 Read 工具、读到真实工作区文件

```powershell
$prompt = 'Use the Read tool to read the file package.json in the current working directory. Then reply with exactly two lines and nothing else: NAME=<value of the name field> and VERSION=<value of the version field>. Do not modify any file.'
Set-Content "$work\p5.txt" -Value $prompt -NoNewline
Get-Content "$work\p5.txt" -Raw | & $bun $cli --print --model 'loomy/DeepSeek-V4.1-Flash' --output-format json --allowed-tools Read --permission-mode dontAsk
```

**【观测】** 退出码 0，自报 `duration_ms: 4075`，`num_turns: 2`（一次工具调用 + 一次收尾），result：

```text
NAME=myclaude
VERSION=0.19.0
```

```json
{"num_turns":2,"is_error":false,"subtype":"success","permission_denials":[],
 "usage":{"input_tokens":616,"cache_read_input_tokens":42880,"output_tokens":67},
 "result":"NAME=myclaude\nVERSION=0.19.0","duration_ms":4075}
```

**【观测】** 会话记录 `$iso\.claude\projects\E--WorkSpaces-Test09-MyClaude\055688b8-....jsonl` 里有一次真实工具调用与结果：

```text
[tool_use]    {"id":"call_00_w15i6e5y8ittpf4m7opil9dt",
               "input":{"file_path":"E:\\WorkSpaces\\Test09\\MyClaude\\package.json"},
               "name":"Read","type":"tool_use"}
[tool_result] {"tool_use_id":"call_00_w15i6e5y8ittpf4m7opil9dt","type":"tool_result",
               "content":"1\t{\n2\t  \"..."}
```

只读核对工作区真实 package.json：`name`: `myclaude`、`version`: `0.19.0` —— 与模型回答**逐字一致**。

**【观测】** 该 jsonl 统计：`api-request` 2 条、`tool_use` 1 条、`api_error` 0 条 —— 原版 harness 的工具循环完整跑通，答案不是猜的。

**【观测】** 参数是 `--allowed-tools Read --permission-mode dontAsk`：只放开读工具，且不弹权限询问。

### G6 —— 上游挂掉的模型会怎样（意外收获，也很重要）

网关里 `amd/Gemma-4-31B-IT` 能收下请求，但它背后的上游不通。同一 id 直接打网关：

```text
502 {"error":{"message":"AMD: Post \"http://127.0.0.1:8890/radeon/api/v1/responses\": dial tcp
127.0.0.1:8890: connectex: No connection could be made because the target machine actively
refused it.","type":"api_error"},"type":"error"}
```

用 harness 跑同一条命令：

```powershell
'Reply with exactly: pong' | & $bun $cli --print --model 'amd/Gemma-4-31B-IT' --output-format json
```

**【观测】** 45 秒上限内**没有任何 stdout**（只有 stderr 那行 `unrecognized_model`），进程仍在跑，被我用 taskkill 掐断。会话 jsonl 里的重试节奏：

```text
api-request @ 11:27:25  ->  api_error 502
api-request @ 11:27:58  ->  api_error 502
api-request @ 11:28:29  ->  api_error 502
api-request @ 11:29:03  ->  api_error 502
api-request @ 11:29:39  ->  api_error 502
api-request @ 11:30:13  ->  api_error 502
api-request @ 11:30:55  ->  api_error 502
api-request @ 11:31:44  ->  api_error 502
api-request @ 11:32:56  ->  api_error 502
api-request @ 11:34:05  ->  (仍在进行中，被外部结束)
```

**【观测】** 9 次 502 之后仍在重试，间隔从 33 s 涨到约 69 s；`--print` 不会自己放弃。
**【推断】** 这是网关/上游不健康时的表现，不是引导方式的问题。实操含义：**给 `--print` 加外部超时是必需的保险**（本次就用 45 s 上限把它掐掉）。

---

## 5. 仓库卫生：运行前后 git 状态

**【观测】** 每次跑 claude 前后各取一次 `git -C E:\WorkSpaces\Test09\MyClaude status --porcelain`，**逐字节相同**：

```text
git status lines BEFORE = 26   (G1/G2/G3 前后)
IDENTICAL = True
no porcelain diff

git status lines AFTER  = 26   (G4/G5/G6 前后)
IDENTICAL = True
no porcelain diff
```

26 行全部是任务开始前就存在的未跟踪文件，HEAD 保持 `7fb7548`。本次实测没有新增、修改或删除仓库内任何文件。

**【观测｜复验限制】** 写文档之后想再复验一次 git 状态时，本会话的 shell 里 `git` 已经不可用（`git --version` 无输出、cmd 里报 `'git' is not recognized`；PATH 中的 `F:\Program Files\Git\cmd` 已不存在，`C:\Program Files\Git` 也不存在）。所以上面的 before/after 快照是**当时取的**，事后无法再取一次；这个限制与本次引导实测无关。可用旁证：同一批未跟踪文件（`_p*.txt`、`_rea_probe*.txt`、`myclaude-export-*.md` 等）在文档写完后仍原样在盘上，且 `docs\` 下只多出本文档一个文件。

**【观测】** 会话状态全部写在隔离 HOME 下，例如 G4/G5/G6 三个会话：

```text
$iso\.claude\projects\E--WorkSpaces-Test09-MyClaude\
  502f510a-....jsonl   236 993 B   api-requests=1  tool_use=0
  055688b8-....jsonl   244 319 B   api-requests=2  tool_use=1
  dfd3ca70-....jsonl   118 131 B   api-requests=2  (被掐断的那次)
```

---

## 6. 限制 / 没测的部分（不要当成已验证）

1. **跑的是原版 harness，模型不是 Claude。** 模型来自本地网关；CLI 自己会打 `[claude-code:unrecognized_model]` 告警，并把 canonicalModel 记成 `loomy/deepseek-v4.1-flash`。上下文窗口、max output、价格都是 harness 对未知模型套的默认值（`contextWindow: 200000`、`maxOutputTokens: 32000`、`costBasis: unknown`）。
2. **写权限流程完全没测。** 本次只放开 Read，且全程 `--print`。Edit / Write / Bash / PowerShell 的权限询问、`acceptEdits` / `bypassPermissions` 行为、写入被拒后的输出，全部**未验证**。
3. **交互式 TUI 没测。** 没有启动过不带 `--print` 的会话（会占住终端）；终端渲染、`/login` 交互流程、状态栏、快捷键都没碰。
4. **真实 Anthropic 登录没测。** 没有走 OAuth / keychain / `setup-token`；G3 只证明「无凭据点会报未登录」。
5. **没和官方安装做对照。** 没有验证提取树与原独立可执行文件的运行差异（native 附件、.node 扩展、bytecode 与 JS 的行为差异）。
6. **模型可用性取决于网关上游。** 同一个网关里就有 200 / 429 / 502 三类 id；换模型失败先怀疑上游，再怀疑引导方式。
7. **没测 MCP / 插件 / hooks / subagent / 后台会话**（`--bg`、`claude agents` 等）。
8. **没测超长上下文、图片输入、stream-json 流式输出。**
9. **耗时不是固定值。** 同一命令见过 294 ms 和 5 458 ms；表里是本次单点观测。
10. **与任务描述不一致的一处**：`~BUN/root` 文件数实测 **5 129**，任务描述写的是 5 111（差 18）；以本次 `Get-ChildItem -Recurse -File` 计数为准。

---

## 7. 清理方法

本次实测只新增了本文档这一个仓库内文件；临时产物全部落在仓库外。

### 7.1 实测留下的临时目录（可直接删）

| 路径 | 内容 |
| --- | --- |
| `E:\WorkSpaces\Test09\_bunroot\_iso_home` | 隔离 HOME（.claude 会话 jsonl、.claude.json） |
| `E:\WorkSpaces\Test09\_probe` | 探针脚本、stdout/stderr 抓取、`home_nocred`、git 前后快照、日志 |
| `E:\WorkSpaces\Test09\_iso_nocred` | 早前一次中断探针的残留；不存在就跳过 |

```powershell
Remove-Item 'E:\WorkSpaces\Test09\_bunroot\_iso_home' -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item 'E:\WorkSpaces\Test09\_probe'            -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item 'E:\WorkSpaces\Test09\_iso_nocred'       -Recurse -Force -ErrorAction SilentlyContinue
```

### 7.2 拆掉引导环境（会失去可运行状态，按需执行）

```powershell
subst B: /D                                                      # 先撤盘映射
Remove-Item 'E:\WorkSpaces\Test09\_bunroot' -Recurse -Force      # 再删 _bunroot（含 ~BUN\root 这个 Junction）
```

要点：

- 必须**先** `subst B: /D` 再删目录。`~BUN\root` 是 Junction，删之前请自己确认一遍解析后的绝对路径，别对着计算出来的路径直接下手。
- 实测中 **B: 映射与 Junction 都是既有环境，我没有创建、修改或删除它们**；本节只是收尾参考。
- 卸掉 B: 之后提取树仍在 `E:\WorkSpaces\Test09\claude-re-2.1.302\02-modules\files` 原地不动；本次实测没有写入该目录下任何文件。

### 7.3 只想让某次运行不留痕

把 `$env:HOME` / `$env:USERPROFILE` 指向临时目录，跑完删掉即可（本次就是这么做的）。若改用真实 HOME，产物会落到 `C:\Users\Admin\.claude\projects\E--WorkSpaces-Test09-MyClaude\` 和 `C:\Users\Admin\.claude.json`，需要另做清理。

---

## 8. 最小可复制流程

```powershell
# 0) 前提：B: 已 subst 到 E:\WorkSpaces\Test09\_bunroot；~BUN\root 已 Junction 到提取树
$bun = 'C:\Users\Admin\.bun\bin\bun.exe'
$cli = 'B:/~BUN/root/cli'
$iso = 'E:\WorkSpaces\Test09\_bunroot\_iso_home'
New-Item -ItemType Directory -Force -Path $iso | Out-Null

# 1) 启动自检
& $bun $cli --version     # -> 2.1.302 (Claude Code)
& $bun $cli --help        # -> 311 行完整命令面

# 2) 接本地网关
$env:HOME = $iso; $env:USERPROFILE = $iso
$env:ANTHROPIC_BASE_URL = 'http://127.0.0.1:3425'
$env:ANTHROPIC_API_KEY  = 'sk-local-gateway'

# 3) 只读回合（prompt 走 stdin 最稳）
Set-Content "$env:TEMP\claude-p.txt" -NoNewline -Value 'Use the Read tool to read the file package.json in the current working directory. Then reply with exactly two lines and nothing else: NAME=<value of the name field> and VERSION=<value of the version field>. Do not modify any file.'
Get-Content "$env:TEMP\claude-p.txt" -Raw | & $bun $cli --print --model 'loomy/DeepSeek-V4.1-Flash' --output-format json --allowed-tools Read --permission-mode dontAsk
# -> result:"NAME=myclaude\nVERSION=0.19.0", num_turns:2, is_error:false

# 4) 收尾
Remove-Item "$iso" -Recurse -Force
```

---

## 9. 一页速查

| 步骤 | 命令要点 | 实测结果 | 耗时（本次观测） |
| --- | --- | --- | --- |
| G1 启动 | `bun B:/~BUN/root/cli --version` | `2.1.302 (Claude Code)`，exit 0 | 294 ms（冷启动 5 458 ms） |
| G2 帮助 | 同上 `--help` | 311 行完整 CLI 面，exit 0 | 2 583 ms |
| G3 无凭据 | `--print`（无 ANTHROPIC_*） | `Not logged in · Please run /login`，exit 1 | 10 151 ms |
| G4 网关文本回合 | `--print --model loomy/DeepSeek-V4.1-Flash --output-format json` | result `pong`，num_turns 1，exit 0 | 自报 5 370 ms |
| G5 网关 + 工具回合 | 同上 + `--allowed-tools Read --permission-mode dontAsk` + stdin prompt | 真读 package.json，答 `NAME=myclaude / VERSION=0.19.0`，num_turns 2，exit 0 | 自报 4 075 ms |
| G6 上游挂掉 | `--model amd/Gemma-4-31B-IT` | 45 s 内无输出，502 重试 9 次仍未停，被外部掐断 | — |
| 仓库卫生 | 运行前/后 `git status --porcelain` | 逐字节相同（26 行未跟踪文件，与基线一致） | — |
