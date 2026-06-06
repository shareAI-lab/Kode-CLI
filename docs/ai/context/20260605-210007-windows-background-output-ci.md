# Windows 背景输出 CI 失败复盘

## 现象

PR #184 的 Ubuntu 与 macOS 通过，Windows job 失败在 `tests/unit/tools/tools-basic.test.ts`：

- 用例：`Bash background execution > readBackgroundOutput returns only new output`
- 失败断言：第一次 `readBackgroundOutput` 的 `stdout` 为空，未包含 `a`
- CI 日志显示命令启动后约 `200ms` 就读取输出

## 根因

该用例验证的是 `readBackgroundOutput` 只返回新增输出，但测试用固定 `200ms` 等待背景命令产出。之前为了兼容 Windows `cmd /c`，测试命令改为通过当前 JS runtime 写 stdout；在 Windows runner 上进程启动和 stream reader 回调可能超过 `200ms`，导致第一次读取太早并推进 cursor，后续断言失败。

## 决策

不改生产逻辑，不跳过 Windows。测试改为轮询 `getBackgroundOutput` 等待 stdout 达到预期内容后，再调用 `readBackgroundOutput`。`getBackgroundOutput` 不推进增量读取游标，因此仍能验证第一次增量读取包含完整输出、第二次读取为空。
