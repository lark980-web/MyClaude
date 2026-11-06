# 上游工具描述词提取（Claude Code 2.1.302）

> 配套：`docs/tool-schemas-2.1.302.json` 的 `_meta.descriptions` 段；
> 提取脚本：`claude-re-2.1.302/tools/spec3/15-extract-descriptions.mjs`（需 Bun）。

## 一句话

上游内置工具的**工具级描述词**（区别于已接入的属性级）是程序化构造的，静态还原要复刻整套条件分支；
**直接在 Bun 里调用上游自己的 `async description()`**，拿到的是上游运行时的真实取值。

## 上游的构造形态

| 形态 | 例 | 处理 |
|---|---|---|
| `async description(){return <fn>(...)}` | Glob：`return cAo(void 0)` | 运行时调用 |
| `async description(){return <ident>}` | TodoWrite：`return _o` | 静态兜底取常量 |
| `async description({description:e}){return e||...}` | Bash | 运行时调用（传 `{}`） |
| 条件分支 | `cAo`：`cB()==="default"?ol:er` | 运行时自然取到默认分支 |

## 还原率

| 项 | 数量 |
|---|---|
| 请求的工具 | 96 |
| 拿到描述词 | **50** |
| 未拿到 | 46 |
| **本地编码 agent 用到的核心工具** | **9/9 全拿到** |

核心工具清单：Read(38)、Write(37)、Edit(24)、Glob(386)、Grep(881)、Bash(17)、
TodoWrite(269)、NotebookEdit(63)、WebFetch(43) —— 字符数为上游描述词长度。

## 未拿到的 46 个是什么

多为**本机没有对应服务**的工具，以及**参数化模板**（不是具体工具）：

- 云侧/插件/MCP（14）：`self_hosted_runner_*`、连接器、插件、marketplace、MCP 系列
- Anthropic 账号与云功能（9）：`ListAgents`、`ReadNotifications`、
  `ShareOnboardingGuide`、`ShowOnboardingRolePicker`、`OfferChromeSetup` 等
- 参数化模板（4）：`(template: se)`、`(template: ae)`、`(template: d -> ENABLE_STUB_TOOLS)`、
  `(template: m -> ARTIFACT_ADDON_TOOLS)` —— 它们展开成多个实例，不是一个具体工具
- 浏览器/计算机使用桩（4）：`(stub: Claude in Chrome)` 等
- 任务与工作区类（8）：`TaskStop`、`ScheduleWakeup`、`ReportFindings`、`TestingPermission`、
  `memory_list`、`LSP`、`EnterWorktree`、`ExitWorktree`
- 其余：`WebSearch`、`Workflow`、`ArtifactComments`、`ArtifactData` 等

## 踩到的坑

**上游的工具对象带 getter 陷阱。** 读取 `.description` 会走上游的权限探针并抛
`TelemetrySafeError: readPermissionDecisionForPath probe consulted unsupported tool property: description`
—— 上游在防工具对象被当普通对象窥探。提取器必须**逐个属性访问加 try/catch**，
否则整个脚本直接崩。

**常量可能是逗号分隔声明里的一项。** TodoWrite 的描述词常量长这样：
`,_o="Update the todo list for the current session..."` —— 只匹配 `var X =` 会漏掉。

**工具对象常在某个 chunk 里，却由桶文件再导出。** TodoWrite 的对象在 `chunk-gwd0s2d1.js`，
但该 chunk 的导出表里没有它 —— 要**反查「谁 import 了它」**才能找到。

## 复算

```bash
cd E:\WorkSpaces\Test09\claude-re-2.1.302
bun tools/spec3/15-extract-descriptions.mjs 'E:/WorkSpaces/Test09/MyClaude/docs/tool-schemas-2.1.302.json'
# 产出 tools/spec3/out-descriptions.json
```

需要 `subst B: E:\WorkSpaces\Test09\_bunroot`（虚拟根映射，见 docs/HANDOFF.md §9）。

## 用到这些描述词之后的变化

描述词直接决定模型怎么选工具、传什么参数。上游文案里带着自研概括给不出的可执行指引：

- Grep：「ALWAYS use Grep for search tasks. NEVER invoke `grep` or `rg` as a Bash command.」
- Grep：「跨行匹配请用 `multiline: true`」
- Glob：「open ended search 请改用 Agent 工具（若可用）」
- TodoWrite：「Make sure that at least one task is in_progress at all times.」

> 注：Glob 那句提到「Agent tool」，而 MyClaude 对应的工具叫 `Task`（上游 2.1.302 把它命名为 `Agent`，
> 并另有 `TaskCreate`/`TaskUpdate`/`TaskList` 三件套 —— 详见 `docs/iteration-backlog.md` 的对齐记录）。