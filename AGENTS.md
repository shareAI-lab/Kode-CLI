# AGENTS.md

This file provides concise guidance to automation agents working in this repository.

## Hard Constraints

- Do not change any external CLI behavior/flags/output/protocols.
- Keep gates green: `bun run typecheck`, `bun run lint`, `bun test`, `bun run build:npm`.
- When a reference repo is available, keep parity green: `KODE_REFERENCE_REPO=/path/to/legacy-kode-cli bun run parity:reference`.

## Development Commands

### Workflow
```bash
# Install dependencies
bun install

# Run in development mode (hot reload with verbose output)
bun run dev

# Build npm runtime dist (Node.js runnable)
bun run build:npm
# (alias)
bun run build

# Clean build artifacts
bun run clean

# Run tests
bun test

# Check types
bun run typecheck

# Format code
bun run format
bun run format:check
```

### Build System Details
- **Primary Build Tool**: Bun (required for development)
- **Distribution**: npm bin shims (`cli.js`, `cli-acp.js`) prefer cached standalone binaries, otherwise run `node dist/index.js` (no Bun runtime required)
- **Entry Point**: `src/entrypoints/cli.tsx`
- **Build Output**: `dist/index.js` (+ chunks), `dist/package.json`, `dist/yoga.wasm`, root `cli.js`, root `cli-acp.js`

### Publishing
```bash
# Publish to npm (requires build first)
bun run build:npm
npm publish
# Or with bundled dependency check skip:
SKIP_BUNDLED_CHECK=true npm publish
```

## Repo Map (Where Things Live)

- `src/entrypoints/`: CLI/MCP/ACP entrypoints and orchestration
- `src/core/`: core logic (must not depend on `src/ui/`)
- `src/services/`: integrations, grouped by domain (`ai/`, `mcp/`, `plugins/`, `system/`, `auth/`, `telemetry/`, `context/`, `ui/`)
- `src/tools/`: tool implementations (Bash/File/Grep/MCP/etc.)
- `src/ui/`: Ink UI (screens/components/hooks)
- `src/utils/`: reusable utilities (domain-grouped)
- `tests/`: `unit/`, `integration/`, `e2e/` (offline by default)

## References

- Release checklist: `docs/release_checklist.md`
- Architecture notes: `docs/upgrade_design.md`
- Task ledger: `todo_tasks.json`, `todo_tasks_detail.md`

## AI Context Notes

- 2026-06-05：修复 Windows CI 时，优先检查 Bun 默认 5 秒测试超时、跨文件 `mock.module` 污染、以及 `cmd /c` 与 Unix shell 命令差异；不要用跳过 Windows 测试代替根因修复。
- 2026-06-05：背景 shell 单测不要用固定短延迟假设 Windows runner 已经产出 stdout；先用不推进 cursor 的 `getBackgroundOutput` 等待目标输出，再断言 `readBackgroundOutput` 的增量语义。
- 2026-06-05：通过 `cmd /c` 执行测试命令时，不要手写 `process.execPath` 的 Windows 引用；若只需要 stdout，优先用 shell/cmd 都支持的简单命令。
