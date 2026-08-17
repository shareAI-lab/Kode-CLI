# Documentation

This directory is reserved for essential project documentation.

Refer to the source code and inline comments for architecture and implementation details.

## SDK positioning: `kode-agent-sdk` vs workspace SDK exports

The repository contains two SDK surfaces with similar concepts (agents, tools, hooks, permissions). They are intentionally separate deliverables:

|                 | `kode-agent-sdk/` (`@shareai-lab/kode-sdk`)                                              | workspace `packages/*` + root `exports` (`./client`, `./core`, `./tools`, `./runtime`, …)      |
| --------------- | ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Purpose         | Standalone event-driven, long-running AI agent framework (persistence, rooms, scheduler) | Kode CLI's own runtime, protocol, and client SDK used by `apps/cli`, `apps/server`, `apps/web` |
| Package manager | npm (`package-lock.json`, not in workspace)                                              | bun workspaces (`bun.lock`)                                                                    |
| Versioning      | independent version (`kode-agent-sdk/package.json`)                                      | follows root package version                                                                   |
| Audience        | Third-party developers building agent services                                           | Developers embedding/customizing Kode itself                                                   |

Guidelines:

- Do not import `kode-agent-sdk` from `packages/*` or `apps/*`, and vice versa — keep the two surfaces decoupled.
- `kode-agent-sdk` is excluded from the root lint config (`.oxlintrc.json`) and has its own CI job (`.github/workflows/ci.yml`).
- If the two surfaces converge, do it deliberately in one refactor; incremental cross-imports will cause drift.
