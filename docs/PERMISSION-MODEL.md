# 权限模型对照

本文记录 MyClaude 的权限判定行为，每一条都注明 Claude Code（`claude-src`）的
对应实现。改权限逻辑前先看这里，避免和参考实现走偏。

> 提问："软件层面还有拒绝指令的情况吗？"
> 答：默认配置下不会。拒绝只来自下面五个来源，且每一个都能由用户解除。

## 五个拒绝来源

| 来源 | 默认状态 | 解除方式 |
|---|---|---|
| 权限模式 | `ask` | `/mode` 或 GUI 切换，7 种可选 |
| deny / ask 规则 | 空 | `config.json` 的 `permissions` |
| Hooks 拦截 | 空（不配置就不存在） | 删掉 `hooks` 配置 |
| plan 模式只读 | 非默认 | 切模式 |
| 模型故障切换 | 会发生，但必定提示 | 配 `fallbacks` |

## 权限模式

MyClaude 有 7 种。Claude Code 的对应实现在 `1070_unnamed.js`：

```js
var be = new Set(["default", "acceptEdits", "auto"]);
```

| MyClaude | Claude | 说明 |
|---|---|---|
| `ask` | `default` | 每次写入前确认 |
| `acceptEdits` | `acceptEdits` | 自动批准文件编辑与常见文件命令 |
| `auto` | `auto` | 不再询问 |
| `dontAsk` | — | 需要确认的一律拒绝（MyClaude 独有） |
| `plan` | `plan` | 只读 |
| `bypassPermissions` | `bypassPermissions` | 跳过确认，deny 规则仍生效 |
| `fullAccess` | — | 跳过确认与 deny 规则（MyClaude 独有） |

Claude 判断"要不要问用户"的实现在 `1057_unnamed.js`：

```js
function Z(n) {
  let e = n.permissions();
  return (
    !n.isNonInteractiveSession &&
    e.mode !== "bypassPermissions" &&
    !(e.mode === "plan" && e.isBypassPermissionsModeAvailable)
}
```

MyClaude 的等价实现在 `src/agent/agent.js` 的 `askPermission()`。

## 各模式的实际行为

实测（7 种模式 × 5 类工具，`permissions.deny` 未配置）：

| 模式 | Write | Bash | Read | WebFetch |
|---|---|---|---|---|
| `ask` | 询问 | 询问 | 放行 | 询问 |
| `acceptEdits` | 放行 | 常规命令放行 | 放行 | 询问 |
| `auto` | 放行 | 放行 | 放行 | 放行 |
| `dontAsk` | 拒绝 | 拒绝 | 放行 | 拒绝 |
| `plan` | 拒绝 | 拒绝 | 放行 | 拒绝 |
| `bypassPermissions` | 放行 | 放行 | 放行 | 放行 |
| `fullAccess` | 放行 | 放行 | 放行 | 放行 |

只有 `fullAccess` 会连 deny 规则一起绕过（`agent.js` 里它在规则引擎之前短路）。

## 与 Claude 的差距：acceptEdits 的命令校验

这是当前最大的功能差距。

Claude 在 `acceptEdits` 下用 **PowerShell AST 解析**判断命令能否自动放行，
实现在 `chunk-41tke5jp.js`。它给出的 40 余条拒绝理由，每一条都对应一种
真实的攻击面：

| Claude 拒绝 | 风险 |
|---|---|
| `Invoke-Expression` | 任意代码执行 |
| `New-Item -ItemType SymbolicLink/Junction/HardLink` | 链接绕过路径验证 |
| `Set-Location` / `Push-Location` + 写操作 | 用陈旧 cwd 做路径验证 |
| `schtasks /create` | 持久化 |
| 写 `.git/hooks/`、`.git/config` | 植入恶意 hook，下次 git 自动执行 |
| `wmic` | 任意进程创建、脚本执行 |
| `-EncodedCommand` | 隐藏真实意图 |
| `Invoke-Item` | 默认处理器执行可执行文件 |
| 下载并执行远程代码 | 远程代码执行 |
| `New-Object` COM / `Add-Type` 加载 .NET | 任意代码执行 |
| 修改环境变量、别名、变量 | 影响后续命令解析 |
| `Start-Process` 嵌套 PowerShell | 无法静态验证 |
| `ForEach-Object -MemberName` | 按名调用方法 |
| 文件重定向 `>` | 可写入任意路径 |
| UNC 路径 | 触发网络请求 |
| 含子表达式 `$()`、可展开字符串、splatting、`--%` | 无法静态验证 |

MyClaude 目前用正则（`src/agent/modes.js` 的 `DANGEROUS_PATTERNS`）挡明显破坏性
命令，**上面这些全部漏过**。

## 破坏性命令识别

`src/agent/modes.js` 的 `isDestructiveCommand()` 与 Claude 的 seatbelt / bubblewrap
沙箱思路对应（`1379_unnamed.js` 提到 seatbelt、bubblewrap、bwrap）。

Claude Code 自己在 Windows 上也做不到真沙箱 —— `1379_unnamed.js` 里有
`eval kept-sandbox seal unavailable on windows`。所以 MyClaude 用命令分级
替代沙箱是合理的跨平台选择。

## 已知的行为差异

### Hooks 不受权限模式管辖

`PreToolUse` 返回 `block` 时，即使 `fullAccess` 也会跳过工具；
`UserPromptSubmit` 甚至可以否决整轮对话（`agent.js` 的 `run()`）。

这与 Claude 一致（hook 是用户自己写的策略），且默认无 hook 时不生效。
但配了 hook 之后切 `fullAccess` 依然会被拦 —— 这一点要清楚。

### 模型故障切换不静默

`src/providers/router.js` 的 `ProviderRouter` 在候选之间切换时必定通知用户：

```
qoder-cn/gfmodel failed (HTTP 429) — switching to qoder-cn/backup
now answering with qoder-cn/backup
```

### GUI 的路径限制只作用于文件面板

`src/ui/gui-server.js` 的 `safePath()` 防的是 `../` 目录穿越，
只影响 GUI 的文件浏览与编辑，**不影响 agent 的 Write/Edit 工具**。

## "软件绝不干涉"的配置

```json
{
  "permissionMode": "fullAccess",
  "permissions": { "allow": [], "deny": [], "ask": [] },
  "hooks": {}
}
```

清空 `hooks` 可确保没有任何隐藏拦截。
