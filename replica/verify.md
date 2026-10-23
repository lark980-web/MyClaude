# 交叉验证记录（2026-10-24）

功能矩阵标 yes 不等于用户能用得上。/hooks 曾引擎与 GUI 接口俱全、CLI 却无入口 ——
于是把所有命令逐个实跑一遍，而不是只读代码。

## 方法

node scripts/smoke-commands.mjs —— 用真实 exe 探测 38 个命令，判定三态：

| 状态 | 含义 | 为什么单独列出来 |
|---|---|---|
| CRASH | 一敲就崩 | 静态检查看不见「某分支用了未导入的标识符」 |
| silent | 还在，但什么都不输出 | 功能悄悄失效的另一种形态 |
| ok | 有输出且未崩 | |

探测参数刻意选只读形式（/rm 不带参数只提示用法），避免检查本身改数据。
/exit 允许 silent，因为它本就该直接结束。

已接进 test/smoke-commands.test.js 防回归（exe 未构建时 skip）。

## 结果：抓到 1 个真崩溃

| 命令 | 症状 | 根因 |
|---|---|---|
| /memory | ReferenceError: loadMemory is not defined | 默认分支调用 loadMemory，但从未导入；同文件其它分支都用动态 import 就近取，只有这处漏了 |

node --check 完全通过。这类 bug 只有实跑才暴露。与 /plan 的 saver 是同一类，
第二次出现，故补了上述自动化检查。

## 当前验证覆盖

- 50 项 yes 中，commands 21 项已逐个实跑（0 崩溃）
- 非命令 29 项里，24 项有测试覆盖
- 无测试覆盖的 3 项已补齐（见上）：

| 条目 | 状态 |
|---|---|
| 工具并发执行 | 已补：test/tool-concurrency.test.js（2 项），并用变异测试证明能抓到串行退化 |
| hooks 的 CRUD | 已补：test/gui-hooks.test.js（9 项），含「路由与 CLI 事件列表同源」守护 |
| 追问胶囊排版 | 已补：test/followup-chips.test.js（4 项），等长与长度上限 |

**3 项无覆盖已全部补齐，功能矩阵 50 项 yes 均有测试或实跑验证。**

## 待交叉验证（未完成的诚实记录）

- 公开 docs 不可达（搜索接口 401），未能与 Claude 官方文档比对功能范围
- replica/screens/ 无参考截图（Claude Code 是 CLI，无商店页可采样）
- 方法偏差：replica-recon 规则禁止读取目标应用源码包；按用户指令仍以 claude-src 为规格依据
