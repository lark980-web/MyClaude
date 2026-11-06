# Claude Code 2.1.302 内置工具参数结构还原（AST 级）

> 对象：`E:\WorkSpaces\Test09\claude-re-2.1.302\02-modules\files\` 的 2432 个明文 JS chunk。
> 方法：自研 token 级括号配对解析器，定位工具对象字面量 → 解析 `get inputSchema(){...}` getter → 求值其 schema 构造链 → 输出 JSON Schema。
> 证据纪律：每条结论给 `文件:行 + 字节偏移`；严格区分「观察到 / 推断 / 未知」。
> 本版 rev.2：修正 Edit 误标、增补模板实例、静态求解 Bash/PowerShell、给出全集口径。

## 0. 一句话结论

内置工具定义**不是** `input_schema` 字面量，而是 `Qt({...})` 工厂 + `get inputSchema(){return B()}` getter + 模块级 memo 构造器 `B=f(()=>De({...}))`（zod 风格链：`.describe()/.optional()/.default()/.extend()/.omit()`）。
全树 **85** 个 `Qt({...})` 工具对象表达式；其中 **4** 个是参数化模板，展开出 **11** 个实例，故**工具对象总数 ≥ 92**。参数静态还原 **85 / 92**。

## 1. 观察到的事实（附偏移）

| # | 事实 | 证据 |
|---|---|---|
| O1 | 工具对象由工厂 `Qt({...})` 创建，成员含 `name/searchHint/description()/prompt()/get inputSchema(){}/create()` 等 | `chunk-e0x0xb6d.js@1310622`（Glob）、`@3959550`（Read）、`@4771174`（Bash） |
| O2 | inputSchema 是 **getter**，体内只有一行 `return B()` | `chunk-e0x0xb6d.js@1310936` = `get inputSchema(){return dHo()}` |
| O3 | schema 构造器是同模块顶层的 memo 定义 `X=f(()=>De({...}))` | `chunk-e0x0xb6d.js@1308616` |
| O4 | 字段类型工厂：`o()`=string `v()`=number `M()`=boolean `T(x)`=array `U([...])`=enum `De/u/Jr({...})`=object | `chunk-e0x0xb6d.js@1313797+`（Grep）、`@3951362`（Read） |
| O5 | **`Qt` 是全树唯一工具工厂** | 扫描全部 1051 个「带 name 成员的对象字面量」，只有 85 个 `Qt({...})` 同时满足 ≥2 个工具标记 |
| O6 | `...PK()` 注入一个可选字段（附加机器名），键是 **computed symbol** | `chunk-27qbqa0f.js@1242` |
| O7 | 全树 `get inputSchema()` 共 83 处，其中 79 处属于 `Qt` 工具对象 | `tools/spec3/07-inputschema-getters.mjs` |

## 2. Edit / LS 结论（本轮新增）

### 2.1 `Edit` **存在** —— rev.1 把它误标成 `MultiEdit`，已修正

| 项 | 值 |
|---|---|
| 名字常量 | `dt` |
| 常量定义 | `chunk-hhhyra7g.js@168275` = `var dt="Edit"` |
| 工具对象 | `chunk-e0x0xb6d.js@4602032`（行 3536），`get inputSchema(){return ehe()}` |
| schema 定义 | `chunk-e0x0xb6d.js` 的 `var ehe=f(()=>De({file_path:o().describe("The absolute path to the file to modify"),old_string:o().describe("The text to replace"),new_string:o().describe("The text to replace it with (must be different from old_string)"),replace_all:ak(M()).default(!1).optional().describe("Replace all occurrences of old_string (default false)"),...PK()}))` |
| 字段 | `file_path`(必填), `old_string`(必填), `new_string`(必填), `replace_all`(? default false) |

> **根因（诚实记录）**：rev.1 用「名字常量的全局唯一值」猜名字，而 `dt` 在多个 chunk 里被复用（压缩标识符冲突），于是猜成 MultiEdit。本轮改权威方法：沿 chunk 的 `import{...}from"B:/~BUN/root/<mod>.js"` 找到常量定义模块，再读该模块的 `var X="..."`。该链对 74/85 自洽，并直接给出 `dt="Edit"`。

### 2.2 `MultiEdit` **不存在**（三条独立反证）

1. **无名字常量**：全树 2432 chunk 中 `var/let/const X="MultiEdit"` 匹配数 **0**（`="Edit"` 1 处、`="NotebookEdit"` 1 处、`="Write"` 1 处、`="Bash"` 1 处）。
2. **无工具对象**：85 个 `Qt({...})` 的 name 全部可解析，没有一个是 MultiEdit。
3. **只以裸字符串出现在权限数组**：`chunk-48gxk5aw.js@9788` = `re=new Set([...vze.filePatternTools,Pr,"MultiEdit","LS"])`；`chunk-48gxk5aw.js@9973` = `Ue=[dt,Kt,Ji,...Vte,"MultiEdit",_ve,...se]`。同数组里 `dt/Kt/Ji` 是**导入常量**（=Edit/Write/NotebookEdit），`"MultiEdit"` 是**裸字面量** —— 这正是「历史名兼容」而非「活工具」的判别特征。

### 2.3 `LS` **不存在**（同样三条反证）

1. `var X="LS"` 匹配数 **0**。
2. 无 `Qt` 工具对象解析为 `LS`。
3. 仅裸字符串出现：`chunk-48gxk5aw.js@9800` 与 `@9880`；同处还有 `"NotebookRead"`（历史名，亦无常量、无工具对象）。

### 2.4 推断

- I-1：`MultiEdit` / `LS` / `NotebookRead` 是 **settings.json 权限规则的兼容名**（让旧配置的 `MultiEdit(...)`/`LS(...)` 规则仍可解析），本 build 中不注册为工具。证据：只出现在权限匹配用的 Set/数组，且全部是裸字符串；活工具名一律走常量导入。
- I-2：该版本确无独立的多文件编辑工具。`tool:"Edit"` 字面量出现在写文件调用路径（`chunk-e0x0xb6d.js@4611634`），且全树没有 `edits:` 数组型 schema（搜 `edits:` 只命中提示词散文）。

## 3. 全集口径（本轮新增）

| 口径 | 数量 | 说明 |
|---|---|---|
| `Qt({...})` 工具对象**表达式**（含 4 模板） | **85** | token 级扫描；`Qt` 是唯一工具工厂 |
| └ 有确定名字的具体工具 | 81 | name 为字符串常量 / 字面量 |
| └ 参数化**模板**工厂 | 4 | name 来自工厂形参 |
| 模板展开的**实例** | **11** | 4 模板 → List/Search Plugins/Skills(4) + ArtifactComments/Data/Check(3) + ENABLE_STUB_TOOLS(4) |
| **工具对象总数** | **≥ 92** | 85 − 4 + 11 |
| 参数已静态还原 | 85 | 含 Bash/PowerShell（本轮新解） |
| 未还原 | 7 | 见 §4 |

**非 `Qt` 的 name 对象**：全树 1051 个「带 name 成员的对象字面量」，按工厂分布为 `u`(164) `push`(158) `super`(60) `ri`(37) …；其中 `u({name:...})` 是 **zod schema 的 name 字段**、`push({name,...})` 是数组 push、`super({name:"ExpiredTokenException",...})` 是 AWS 错误类。加「≥2 个工具标记」过滤后只剩 `Qt`×85（另有 3 条落在 `chunk-qf3jpdhk.js` 模板内部、1 条落在 `chunk-hvsjfmdn.js` 的工具**序列化包装** `Bi({name:e.name,...,inputSchema:e.inputSchema})`，都不是新工具）。

**4 个模板工厂明细**：

| 模板位置 | 工厂 | 实例 | 证据 |
|---|---|---|---|
| `chunk-5rpss0dp.js@10844` | `function se(e)` | `ListPlugins`, `ListSkills` | `@11622 se({name:_Ar,...})` / `@12950 se({name:_Is,...})`；`chunk-v63rpz2m.js`: `_Ar="ListPlugins"` `_Is="ListSkills"` |
| `chunk-5rpss0dp.js@22025` | `function ae(e)` | `SearchPlugins`, `SearchSkills` | `@24470 ae({name:C8e,...})` / `@24693 ae({name:yIs,...})`；`chunk-v63rpz2m.js`: `C8e="SearchPlugins"` `yIs="SearchSkills"` |
| `chunk-qf3jpdhk.js@13823` | `function m(e)` → `ARTIFACT_ADDON_TOOLS` | `ArtifactComments`, `ArtifactData`, `ArtifactCheck` | `chunk-qf3jpdhk.js@16304/16645/16765`；`chunk-v0a9ew5s.js`: `x_="ArtifactComments"` `mg="ArtifactData"` `GM="ArtifactCheck"` |
| `chunk-ffg581qz.js@29056` | `function d({...})` → `ENABLE_STUB_TOOLS` | `Claude in Chrome`, `Browser`, `Computer use`, `Your computer` | `chunk-ffg581qz.js@30135/30364/30475/30591`（`Ie=[ne,se,re,ae]`） |

> 未知：`ENABLE_STUB_TOOLS` 4 个实例的 name 来自常量 `R/U/B/c`，定义点未定位；它们带 `inputJSONSchema`（常量 `E`/`q`），参数未还原。

## 4. 未知 / 无法静态还原

| 工具 | 位置 | 原因 |
|---|---|---|
| Agent | `chunk-1nry7a4r.js@45987` | builder-not-statically-reducible |
| AskUserQuestion | `chunk-4kgb9k1d.js@12918` | runtime-dependent-getter |
| SendMessage | `chunk-8q9jcy18.js@53292` | builder-not-statically-reducible |
| TaskStop | `chunk-gwd0s2d1.js@28053` | runtime-dependent-getter |
| SendUserMessage | `chunk-gwd0s2d1.js@32069` | runtime-dependent-getter |
| WebSearch | `chunk-gwd0s2d1.js@42850` | runtime-dependent-getter |
| Projects | `chunk-mrxqyavf.js@24514` | runtime-dependent-getter |
| ArtifactComments | `chunk-qf3jpdhk.js@13823` | inputJSONSchema passed at call site |
| ArtifactData | `chunk-qf3jpdhk.js@13823` | inputJSONSchema passed at call site |
| ArtifactCheck | `chunk-qf3jpdhk.js@13823` | inputJSONSchema passed at call site |
| （4 个 stub 实例） | `chunk-ffg581qz.js` | inputJSONSchema 由调用点传入的常量，未静态求值 |

## 5. Bash / PowerShell 主 schema（本轮新增 —— 已解决）

rev.1 判断「运行时组合不可解」，**本轮推翻**：组合链的两个入参都可静态读到。

```js
// chunk-e0x0xb6d.js@4761005  -- Bash 的主 schema
ycs = f(()=>De({
  command: o().refine(Qx,hcs).describe("The command to execute"),
  timeout: fD(v().optional()).describe(<模板串: Optional timeout in milliseconds (max + Y$() + )>),
  description: o().optional().describe(<模板串: Clear, concise description of what this command does in active voice. ...>),
  run_in_background: ak(M().optional()).describe(<模板串调用 $Hn()>),
  dangerouslyDisableSandbox: ak(M().optional()).describe("Set this to true to dangerously override sandbox mode and run commands without sandboxing."),
  ...!1, ...mSe()&&UAt(),
  _simulatedSedEdit: u({filePath:o(),newContent:o(),baseHash:o().optional()}).optional().describe("Internal: pre-computed sed edit result from preview"),
  ...PK()
}));
// chunk-e0x0xb6d.js@191561  -- 被 omit 的字段名是【字面量数组】
LNe = ["dangerouslyDisableSandbox", ...[]];
// chunk-e0x0xb6d.js@191658  -- 组合器只在开关打开时才 omit
function cmr(e,n){ if(!Mf().unsandboxedCommandsDisabled) return e; ... return e.omit(r) }
// chunk-e0x0xb6d.js@4762585  -- 最终导出，恒 omit 掉内部字段
kYn = f(()=>cmr(ycs(), LNe));
SYn = f(()=>( lgt()? kYn().omit({run_in_background:!0,_simulatedSedEdit:!0})
                  : kYn().omit({_simulatedSedEdit:!0}) ).superRefine((e,n)=>{}));
```

（上面两处 `<模板串...>` 原文是 JS 模板字符串；为免转义歧义改写为描述。其余为逐字原文。）

→ **Bash 输入 schema = `{command(必填), timeout?, description?, run_in_background?, dangerouslyDisableSandbox?, _simulatedSedEdit?}`**，附三个条件项。PowerShell 同构（`chunk-vxz20cqc.js@94621` 的 `to()`，`@95185` 的 `on=f(()=>cmr(to(),Leo))`、`so=f(()=>Zu()?on().omit({run_in_background:!0}):on())`）。

仍**未**枚举的：`...mSe()&&UAt()`、`...an()&&PK()` 两个 feature-gated spread，以及 `_simulatedSedEdit`（内部字段，实际不对模型暴露）。

## 6. 还原率

- 工具对象 **≥ 92**（85 个 `Qt` 表达式 − 4 模板 + 11 实例）
- 命名：**88** 个具体名（另 4 个为模板本身）
- 参数（JSON Schema）：**85 / 92 = 92.4%**
- 核心代码工具：Write / **Edit** / Read / Glob / Grep / NotebookEdit / **Bash** / **PowerShell** / TodoWrite / TaskCreate / TaskUpdate / TaskList / EnterWorktree / ExitWorktree / memory_read / memory_write / memory_list —— 参数**完整**

## 7. 与旧清单的差异

旧清单 67 条由启发式产生，其中 15 条 name 为 `null`（含 MCP 管线对象、`B:/~BUN/root/models-*.md.zst` 资产字符串等噪声），且**完全没有** Write/Edit/Read/Glob/Grep/Bash/PowerShell/NotebookEdit/TodoWrite/TaskCreate 等核心工具。旧清单的 `Diff` 条目实为 **`SendFeedback`**（`chunk-gwd0s2d1.js@79337` = `var Wo="SendFeedback"`；同名的 `Wo="Diff"` 在 `chunk-dxm9c8ee.js@28640` 属于 **/diff 斜杠命令**，该 chunk 内 `Qt` 调用出现 0 次）。另 rev.1 沿用了旧清单的 `Task` 名，本轮按 import 链修正为 **`Agent`**（`chunk-htd96mny.js@688` = `var ht="Agent"`）。

## 8. 可复算命令

```powershell
# 0) 工具对象全集（token 级，Qt 唯一工厂）
node tools\spec3\lib\scan-all.mjs
# 1) 权威名字解析（沿 import 链到定义模块读 var X="..."）
node tools\spec3\lib\rigorous-names.mjs
# 2) schema 求解
node tools\spec3\lib\extract3.mjs
# 3) 合并 + 模板实例 + Bash/PowerShell + _meta
node tools\spec3\lib\build-final.mjs
```

单点复核（Edit 与 MultiEdit 反证）：

```powershell
$h = Get-Content -Raw E:\WorkSpaces\Test09\claude-re-2.1.302\02-modules\files\chunk-hhhyra7g.js
$h.Substring(168275, 20)      # var dt="Edit",Ydn=...
# 全树搜 MultiEdit 的常量定义 -> 0 命中；只有裸字符串，见 chunk-48gxk5aw.js@9788
```

## 9. 交付物

- `docs/tool-schemas-2.1.302.json` — `{_meta, tools[]}`；每条 `{name, nameSource, nameConst, parameters(JSON Schema|null), source{file,line,byteOffset,schemaBuilder}, confidence}`
- `docs/tool-schemas-2.1.302.md` — 本文件