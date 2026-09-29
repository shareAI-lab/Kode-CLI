# Developer documentation

Start with the repository-level [architecture](../architecture.md) and
[project structure](../PROJECT_STRUCTURE.md). Maintained developer guides are:

- [Configuration](configuration.md)
- [Releasing](releasing.md)
- [System sandbox](../system-sandbox.md)
- [TUI architecture](../tui/README.md)

The silent-failure classes the test suite guards against (a test that ends the
process, `mock.module` leaking between files, tests writing through
`node_modules`) are listed under "Test quality rules" in
[AGENTS.md](../../AGENTS.md).

Development uses Bun 1.3.6 and the committed `bun.lock`:

```bash
bun install --frozen-lockfile
bun run format:check
bun run architecture:check
bun run security:audit
bun run typecheck
bun test
bun run build
```
