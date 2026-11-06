# Claude Code 2.1.302 运行时工具 schema 普查（阶段 1-B / task-6）

> 执行者：`runtime-census`　状态：完成　日期：2026-11-06
> 交付物：本文、`docs/tool-schemas-2.1.302.json` 的 `_meta.runtimeCensus` 段、
> `claude-re-2.1.302/tools/spec3/17-extract-all-runtime.mjs`、`claude-re-2.1.302/tools/spec3/out-all-runtime.json`。
> 硬约束遵守情况：未改 `src/`、`scripts/`、`test/` 及任何其他 docs 文件；未改 `tools[]` 数据本身；未 git commit；未跑 bundle-gui / build-exe / verify-features；未重建 B: 映射。

## 0. 结论速览

| 指标 | 数值 |
| --- | --- |
| 静态普查条目（universe） | 96 |
| 静态已有 `parameters` 对象 | 87（90.63%） |
| 静态 `parameters: null` | 9 |
| `Qt({` 分布 | 49 模块 / 102 次调用 |
| 运行时发现的工具对象 | 91 |
| 运行时成功转出 JSON Schema | **91 / 91（100%）** |
| 运行时对 96 条普查的覆盖 | 85 / 96（77 条复证 + 8 条新增） |
| **新增拿到的 schema** | **8** |
| 合并静态+运行时后覆盖率 | **95 / 96 = 98.96%** |
| 仍拿不到 | 1（模板占位条目，非真实工具） |

## 1. 基线（全部为【观察】）

- 【观察】静态普查共 96 条工具，87 条 `parameters` 为对象、9 条为 `null`；依据 `docs/tool-schemas-2.1.302.json@2669`（`"tools": [`）、`@855`（`"counts"`）、`@2443`（`"runtimeSchemas"`，当时仅 2 条），9 处 `"parameters": null` 分别位于 `@42562 / @99122 / @99841 / @102486 / @141824 / @156099 / @181130 / @181850 / @182573`。静态还原率 87/96 = 90.63%。
- 【观察】`Qt({...})` 工具对象字面量分布在 49 个模块、共 102 次调用；依据 `17-extract-all-runtime.mjs@3209` 对 `E:/WorkSpaces/Test09/claude-re-2.1.302/02-modules/files/`（2432 个 JS chunk）的逐文件 `matchAll(/Qt\(\{/g)` 统计，见 `out-all-runtime.json` 的 `_meta.anchors.qtScan`。与任务描述给出的 49 / 102 一致。
- 【观察】部分工具的 `inputSchema` 是运行时 getter 而不是可静态收敛的单值：AskUserQuestion 为 `get inputSchema(){if(GTe())return be();return m2o()?ge():ye()}`（`chunk-4kgb9k1d.js@13445`）；Artifact 家族为 `get inputSchema(){return e.inputSchema()}`（`chunk-qf3jpdhk.js@14457`）。这两处是静态抽取器判为 not-statically-reducible 的直接原因。
- 【观察】上游存在 getter 陷阱：`chunk-zvergrz0.js@239212`（L74，`readPermissionDecisionForPath` 探针）用 `new Proxy(...)` 包裹工具对象，读取未在白名单内的属性时抛 `TelemetrySafeError`（`chunk-pm0j6a3a.js` 中 `class x extends Error{...this.name="TelemetrySafeError"}`），消息形如 `readPermissionDecisionForPath probe consulted unsupported tool property: <prop>`。15 号脚本注释即指此。
- 【推断】正因为上述探针代理会对「窥探属性」抛错，任何对上游工具对象的逐属性访问都必须单独 `try/catch`；17 号脚本对 `.name` / `.inputSchema` / `.description` / `.shape` / 构造器名全部逐项包了保护（`17-extract-all-runtime.mjs@5257` 起的 `safeName/safeHasIS/safeDescFn/safeInputSchema/safeDescription/safeKind/safeShapeKeys`）。

## 2. 方法

### 2.1 三条发现通道（【观察】，脚本实现见 `17-extract-all-runtime.mjs`）

- **通道 A — Qt 模块导出扫描**（`@6079`）：对上述 49 个含 `Qt({` 的 chunk 逐个 `import("B:/~BUN/root/" + file)`，枚举 `Object.entries(mod)`，对导出对象按 `.name` 匹配工具对象（`16` 号脚本的 `findTool` 也按 96 个名字直取一遍，命中 47 次）；数组类导出（如 `ARTIFACT_ADDON_TOOLS`）递归下钻。例：`chunk-e0x0xb6d.js@1281890`（`xk=Qt({` / Write）、`chunk-8q9jcy18.js@47172`（`SendMessageTool`）、`chunk-mrxqyavf.js@54315`（`ProjectsTool`）。
- **通道 B — 运行时工具注册表**（`@6602`）：`chunk-gwd0s2d1.js@157878` 导出 `var bY={getAllBaseTools:X_,getTools:NF,assembleToolPool:MVt};`；调用 `bY.getAllBaseTools()` 返回 **78** 个真实工具对象（`@157886`）。静态普查中 `parameters: null` 的 WebSearch / TaskStop / SendUserMessage / SendMessage / Projects 都在此注册表中。
- **通道 C — 配置单例播种**（`@8225`）：仅对 A/B 首轮失败者启用，详见 §2.4。

### 2.2 直接复用 15 / 16 号脚本（【观察】）

不修改原文件，17 号脚本在运行时读取其源码、截取函数区并用 `new Function` / `AsyncFunction` 求值返回（`@2035` 的 `sliceBetween`、`@2256` 的 `src16`、`@2572` 的 `src15`）：

- `16-extract-runtime-schemas.mjs@723`（`function kind`）、`@1788`（`function z2j`，zod v4 → JSON Schema）、`@4384`（`function findTool`）——按构造器名分发，未识别节点标 `x-unknown`，不猜。
- `15-extract-descriptions.mjs@2281`（`function toolsByName`）、`@2784`（`async function callDescription`）——工具级 `description()` 运行时调用，含 getter 陷阱防护。

### 2.3 转换与校验（【观察】）

`17-extract-all-runtime.mjs@9245` 的 `extractOne`：`safeInputSchema` 取 getter → `z2j` 转换 → 要求结果为带 `type` 的对象才算成功；失败记入 `errors`。实测 91 个工具对象的 `inputSchema` 全部为 `ZodObject`（`out-all-runtime.json` 每条的 `schemaKind`）。

### 2.4 配置单例播种（通道 C，【观察】+【推断】）

- 【观察】Artifact 家族 4 个对象（`Artifact` / `ArtifactComments` / `ArtifactData` / `ArtifactCheck`）首轮读 `.inputSchema` 抛 `Config accessed before allowed.`；报错见 `out-all-runtime.json` 的 `errors` 4 条。
- 【观察】根因链：`chunk-qf3jpdhk.js@16302` 起的模板实例把 `inputSchema` 设为 `UQo/BQo/jQo`（`chunk-1x4wg0p7.js@21481`：`var UQo=f(()=>Z(Boe(),YA())),BQo=f(()=>Q(YA())),jQo=f(()=>ee(Boe()))`），而 `Boe()/YA()` 经 `st()` 调用 `ue()` 读全局配置；`chunk-5g1sk7ex.js@101838`（`function ue`）在 `!e.enableSettled` 时抛错（`@101964`：`throw Error("Config accessed before allowed.")`）；`Pu.enableSettled` 初值 `!1` 在 `@72192`（`class Pu` 起于 `@72056`）；`un()` 恒为 `false`（`@89965`），因此裸 Bun 进程走不到默认分支。
- 【观察】配置单例可通过 `chunk-w65fvf8h.js@80878` 的 `function ms(e){return e.of(k.host)}` 与 `chunk-5g1sk7ex.js` 导出的 `t7s` 取到（与 `ce()` 同一个 `Pu` 实例）。17 号脚本执行 `ms(t7s).enableSettled=true; readingAllowed=true; installDiskRead(Mx=$e())`，即把**上游自己的默认配置对象**灌入缓存，令 `ue()` 走 `readCache()` 返回默认配置。该操作只作用于本次 Bun 进程内存，不写任何配置文件。
- 【推断】播种后 getter 走的是上游默认配置分支，因此得到的 schema 是「默认 feature-gate 组合」下的真实运行时取值；若目标环境开启了额外 gate，字段可能更多。此点列为【未知】：本次普查未枚举所有 gate 组合。
- 【观察】播种仅重试 4 个失败者（`_meta.configSeeding.retried`），其余 87 个成功者的 schema 未受播种影响。

## 3. 还原率（【观察】，依据 `out-all-runtime.json@6850` 的 `reconciliation`）

| 口径 | 计算 | 结果 |
| --- | --- | --- |
| 静态还原率 | 87 / 96 | 90.63% |
| 运行时对象 → schema | 91 / 91 | 100% |
| 运行时对普查条目的覆盖 | 85 / 96（77 复证 + 8 新增） | 88.54% |
| 合并后覆盖率 | (87 + 8) / 96 = 95 / 96 | **98.96%** |
| 剩余缺口 | 1 / 96 | 1.04% |

## 4. 新增清单（8 个，静态 `parameters: null` → 运行时拿到 schema）

| 工具 | 静态普查位置 | 运行时证据（chunk / 导出符号 / 通道） | 拿到的字段数 |
| --- | --- | --- | --- |
| SendMessage | `docs/tool-schemas-2.1.302.json@42419`（null @42562） | `chunk-8q9jcy18.js@47172` / `SendMessageTool` / 通道 A | 4 |
| TaskStop | `@98982`（null @99122） | `chunk-gwd0s2d1.js@157886` / `bY.getAllBaseTools()[15]` / 通道 B | 2 |
| SendUserMessage | `@99694`（null @99841） | `chunk-gwd0s2d1.js@157886` / `bY.getAllBaseTools()[63]` / 通道 B | 1 |
| WebSearch | `@102345`（null @102486） | `chunk-gwd0s2d1.js@157886` / `bY.getAllBaseTools()[14]` / 通道 B | 3 |
| Projects | `@141683`（null @141824） | `chunk-mrxqyavf.js@54315` / `ProjectsTool` / 通道 A | 7 |
| ArtifactComments | `@180914`（null @181130） | `chunk-qf3jpdhk.js@17056` / `ARTIFACT_ADDON_TOOLS[0]` / 通道 A+C | 7 |
| ArtifactData | `@181646`（null @181850） | `chunk-qf3jpdhk.js@17056` / `ARTIFACT_ADDON_TOOLS[1]` / 通道 A+C | 11 |
| ArtifactCheck | `@182366`（null @182573） | `chunk-qf3jpdhk.js@17056` / `ARTIFACT_ADDON_TOOLS[2]` / 通道 A+C | 1 |

- 【观察】8 条均为 `ZodObject` → JSON Schema，含 `properties` / `required` / `additionalProperties`，字段与 `description` 可在 `out-all-runtime.json` 的 `tools` 段逐条复核。
- 【观察】另 77 条静态已有 schema 的工具被运行时**复证**（`reconciliation.confirmedByRuntime=77`），即静态结果与运行时 getter 取值并存，可供 Lead 生成器选用。

## 5. 仍拿不到的清单及原因

| 条目 | 静态位置 | 原因（【观察】+【推断】） |
| --- | --- | --- |
| `(template: m -> ARTIFACT_ADDON_TOOLS)` | `docs/tool-schemas-2.1.302.json@156099` 附近（null @156099） | 【观察】运行时注册表（78 个）与 49 个 Qt 模块导出中均无 `.name` 等于该字符串的**工具对象**；它是静态普查为 `chunk-qf3jpdhk.js@16302` 的参数化模板 `m(e)` 记的一条占位条目，不是一件可调用的工具。【推断】其三个实例（`ArtifactComments` / `ArtifactData` / `ArtifactCheck`）已在 §4 全部单独拿到 schema，占位条目本身无 inputSchema 可抽，故保持 `null` 即为正确状态，不需要补数。 |

- 【观察】除该模板占位外，原 9 条 `null` 中的 8 条已全部补齐；`_meta.reconciliation.stillMissingSchema` 长度为 1。
- 【观察】没有为凑数继续深挖 barrel；按 Lead 收敛要求停止扩展。

## 6. 静态有 schema 但运行时未见对象的 10 条（【观察】）

`out-all-runtime.json` 的 `reconciliation.staticOnlyNotSeenAtRuntime`：
`(template: se)`、`(template: ae)`、`(template: d -> ENABLE_STUB_TOOLS)`、`TestingPermission`、`RefreshMcpTools`、`ObserverReport`、`(stub: Claude in Chrome)`、`(stub: Browser)`、`(stub: Computer use)`、`(stub: Your computer)`。

- 【推断】前 3 条是参数化模板占位、中间 3 条是按 `isEnabled` 分支/云侧条件注册的工具、后 4 条是 `ENABLE_STUB_TOOLS` 开关下的桩条目；它们都不在 `getAllBaseTools()` 的默认 78 个里。静态 schema 已存在，运行时未覆盖不影响合并覆盖率。
- 【未知】`ENABLE_STUB_TOOLS` 打开后这 4 个桩是否会变成可访问对象，本次未验证（不属本任务范围）。

## 7. 运行时发现但静态普查无条目的 6 个（【观察】）

`reconciliation.runtimeOnlyNotInStaticCensus`：`Monitor`、`enable__mcp__claude-in-chrome`、`enable__mcp__remote-devices__Claude_Browser`、`enable__mcp__remote-devices__computer`、`request_computer`、`Artifact`（后者是 `ARTIFACT_ADDON_TOOLS` 的父工具，对应静态 `(template: m -> ARTIFACT_ADDON_TOOLS)` 占位）。

- 【推断】这些是运行时注册表中的真实工具对象，静态普查按 `Qt({` 字面量记账时未给它们单独条目（或用模板/桩名代替）。
- 【观察】它们的运行时 schema 同样完整保存在 `out-all-runtime.json`，可供 Lead 生成器决定是否补入 `tools[]`；本任务**未改** `tools[]`。

## 8. 已知限制（【观察】/【未知】）

- 【观察】`z2j` 对无法按构造器名识别的 zod 节点标 `x-unknown-node`（如 `ZodTransform` / `ZodTuple` / `ZodUnknown`），91 条中有 24 条含此类标记；例：`SendMessage.properties.notify_when_idle`（`ZodTransform`）、`ArtifactData.properties.query.properties.where.items`（`ZodTuple`）、`Agent.properties.mode`（`ZodTransform`）。这是 16 号脚本的既有行为，17 号原样复用，未擅自猜测其 JSON Schema 语义。
- 【观察】`description()` 以 `{}` 调用（与 15/16 一致），个别工具的描述随入参变化，例如 `WebSearch` 得到 `"Claude wants to search the web for: undefined"`，Artifact 家族得到父工具描述。取的是上游默认入参下的运行时输出，不是静态文案。
- 【观察】`z2j` 有 `depth > 8` 的深度上限（`16-extract-runtime-schemas.mjs@1788` 起），深层嵌套可能被截为 `{}`；本次 91 条均成功产出带 `type` 的顶层对象。
- 【未知】配置播种后 Artifact 家族 schema 的 feature-gate 组合是否为所有部署环境的唯一取值（§2.4）；未枚举 gate 组合。
- 【未知】`chunk-4kgb9k1d.js@13445` 的三分支 `be()/ge()/ye()` 在非默认 gate 下的另外两份 schema；16 号与 17 号取的都是当前运行时的默认分支。

## 9. 复算命令

```powershell
# 前置：bun 1.4.2 可用（C:\Users\Admin\.bun\bin\bun.exe）；B: 虚拟根已配好，不要重建映射
cd E:\WorkSpaces\Test09\claude-re-2.1.302\tools\spec3
bun 17-extract-all-runtime.mjs
# 可选：显式指定对账基线
bun 17-extract-all-runtime.mjs E:\WorkSpaces\Test09\MyClaude\docs\tool-schemas-2.1.302.json
```

- 【观察】产出 `out-all-runtime.json`；17 号脚本不写 `docs/`，`_meta.runtimeCensus` 与本文由本任务单独落盘。
- 【观察】脚本运行时会 `import` 49 个 chunk 并调用 `getAllBaseTools()`，但仅在本进程内执行；配置播种同样只在内存生效，未写任何配置文件。

## 10. 交付与对账索引

| 文件 | 作用 |
| --- | --- |
| `claude-re-2.1.302/tools/spec3/17-extract-all-runtime.mjs` | 全量运行时普查脚本（复用 15/16） |
| `claude-re-2.1.302/tools/spec3/out-all-runtime.json`（`@6850` 起） | 91 条运行时 schema + reconciliation + 证据锚点 |
| `docs/runtime-tool-census.md` | 本文：方法、还原率、新增清单、复算命令 |
| `docs/tool-schemas-2.1.302.json` 的 `_meta.runtimeCensus` | 机器可读摘要（`tools[]` 未改，留给 Lead 生成器接） |
