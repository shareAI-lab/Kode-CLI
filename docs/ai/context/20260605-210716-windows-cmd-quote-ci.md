# Windows cmd 引用问题复盘

## 现象

PR #184 新一轮 Windows CI 仍失败在 `readBackgroundOutput returns only new output`。新增等待逻辑暴露了 stderr：

- `'"C:\\Users\\runneradmin\\.bun\\bin\\bun.exe"' is not recognized as an internal or external command`

## 根因

测试为了避开 Windows `printf` 差异，改成通过 `process.execPath -e <script>` 写 stdout。但 `BunShell.execInBackground` 在 Windows 下通过 `cmd /c <command>` 执行命令，测试里的 `quoteForShell(process.execPath)` 会让 `cmd` 把带引号的可执行文件路径作为命令名的一部分解析，导致命令本身无法启动。

## 决策

该测试只需要稳定地产生两段 stdout，不需要验证 JS runtime 调用。改用 `echo a&&echo b`，该命令在 POSIX shell 与 Windows `cmd` 中都能输出 `a` 和 `b`，同时保留 `getBackgroundOutput` 轮询以避免固定延迟带来的 runner 时序波动。
