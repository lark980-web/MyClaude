# 上游权限引擎的可达性（结论）

> 关联：`docs/upstream-tool-descriptions.md`（描述词提取）、`docs/authentic-claude-code-run.md`（引导运行）。

## 结论（一句话）

上游的**完整权限引擎**（`checkPermissions`）与上游实时应用状态深度耦合，
**进程内无法可靠调用**；它只能通过 **B 路线**（运行上游自己的引擎）触达 —— 而这条路线已经实现。
可进程内调用的，是上游**只读分类器**（`isReadOnly` / `notReadOnlyReason`），已接入。

## 为什么进程内调不通（实测）

上游 Bash 工具的 `checkPermissions(input, {toolUseId})` 内部链路：

```
checkPermissions  (chunk-e0x0xb6d.js:3614)
  -> Dhr            (chunk-e0x0xb6d.js:366)
    -> gje          (chunk-e0x0xb6d.js:366)
      -> le        (chunk-cb3emrq3.js:11)   ← le(e) = e.getAppState().toolPermissionContext
        -> e.getAppState()                   ← 抛 TypeError
```

缺失的是 **toolPermissionContext**：

- `e.getAppState()` → 返回含 `toolPermissionContext` 的应用状态
- `e.permissionLayers` → 权限层数组（层序会改变判定结果）
- `e.permissions()` → 权限配置
- `pollEventDeliveryGuard` → 会改写权限规则集（`strippedDangerousRules`）

用假上下文把这几个补上**能跑通**，但补出来的判定不等于上游在真实会话里的判定 ——
因为`permissionLayers`的层序与 `toolPermissionContext`的状态语义都会影响结论。
**拿一个不可信的判定去替换已有逻辑，比不改更糟。**

## 可达路径：B 路线（已实现并实测）

运行上游引擎本身（`bun B:/~BUN/root/cli --print --permission-mode default`）时，
上游的权限层带着**真实的 app state** 正常工作。实测输出：

> The command was blocked by the permission layer before it ran — PowerShell's static validator
> rejected `rm -rf` (the abbreviated `-rf` can't be statically verified, so it requires
> manual approval). Nothing was deleted.

同一次会话里，无害命令 `echo mc-probe-harmless` 正常执行。

⇒ **MyClaude 的 `/engine` 路线继承上游的完整权限语义**，不需要在进程内重建引擎。

## 分层结论

| 层 | 可达性 | 状态 |
|---|---|---|
| 上游只读分类器 `isReadOnly` / `notReadOnlyReason` | 进程内可调（无状态依赖） | **已接入**（`src/agent/upstream-safety.js`） |
| 上游完整权限引擎 `checkPermissions` | 需实时 app state | **经 B 路线触达**（`/engine`） |
| 上游危险模式规则（PowerShell 静态校验，`Invoke-Expression`、编码参数、动态命令名） | 在 `chunk-vxz20cqc.js`，内部函数未导出 | 经 B 路线执行 |

## 顺带确认的一件事

上游 Windows 上用的是 **PowerShell AST 静态校验**，而 MyClaude 自研的是正则启发式 ——
上游那段输出里的 `the abbreviated -rf can't be statically verified` 正是
「无法静态证明安全就问」的同一类判断。这印证了上一轮的结论：
上游 `isReadOnly` 回答的是「有无副作用」，与 MyClaude acceptEdits 的
「模式语义下能否免询问执行」不是同一个问题。