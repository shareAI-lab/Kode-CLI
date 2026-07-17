# Phase 2 Package Boundaries

This document records the current Phase 2 package split contract. It is a
working boundary map for contributors, not a claim that every legacy import has
already been removed.

## Current Layering

```text
apps/*
  -> packages/host
  -> packages/engine
  -> packages/{agent,ai,context,hooks,permissions,tools}
  -> packages/{config,protocol,runtime,tool-interface}
```

`packages/core` remains a temporary compatibility and shared-service package.
New code should not treat it as the owner of every capability. Move new
interfaces to the narrow package that owns the concept.

## Package Ownership

| Package          | Owns                                                                     | Boundary rule                                                                                   |
| ---------------- | ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| `tool-interface` | Tool contracts, tool result contracts, command-source types              | No dependency on tool implementations, engine, UI, or core service code.                        |
| `host`           | Host-facing render, input, permission request, and capability interfaces | No direct tool execution or model-provider logic.                                               |
| `engine`         | Turn loop, message pipeline, tool scheduling, orchestration              | May call domain services, but should not re-export through core.                                |
| `ai`             | AI-provider adapters and OpenAI package API                              | Temporary `#core` imports still exist; do not add new ones unless they replace larger coupling. |
| `permissions`    | Permission decisions, bash/file permission helpers                       | No engine or UI imports.                                                                        |
| `agent`          | Agent event and command metadata helpers                                 | No engine or UI imports.                                                                        |
| `context`        | Context gathering and prompt context helpers                             | No engine or UI imports.                                                                        |
| `hooks`          | Hook registry, matcher, and executor logic                               | No core runtime re-export dependency.                                                           |
| `tools`          | Built-in tool implementations and registry                               | Prefer `tool-interface`; avoid engine imports except existing agent-tool compatibility paths.   |
| `core`           | Legacy compatibility entrypoints and shared services still being drained | Must not import `@kode/engine` or `@kode/ai` from production code.                              |

## Import Migration Rules

Use these rules when touching files in the split packages:

1. Tool types should come from `@kode/tool-interface/*`.
2. Engine execution should come from `@kode/engine/*`.
3. Hook APIs should come from `@kode/hooks/*`.
4. Context APIs should come from `@kode/context/*`.
5. Permission APIs should come from `@kode/permissions/*`.
6. Agent event and command-source APIs should come from `@kode/agent/*` or
   `@kode/tool-interface/commandSource` depending on ownership.
7. Do not add new production imports from `packages/core` to `@kode/engine` or
   `@kode/ai`.
8. Do not add new production imports from extracted packages back to `#core`
   unless the change reduces an existing dependency count and has a follow-up
   removal path.

The current compatibility path for `#core/ai/llm` intentionally keeps OpenAI
provider code local to core. This avoids a production `core -> ai -> core`
cycle while `packages/ai` still has legacy `#core` dependencies.

## Verification

Run these checks after boundary changes:

```bash
bun run typecheck
bun run baseline:refactor
bun run baseline:phase2
```

`baseline:refactor` writes `.tmp/refactor-baseline/report.json`.
The required Phase 2 production condition is:

```text
dependencyGraph.productionFiles.cycleCount === 0
```

The report also includes an all-files cycle count. Test-only cycles are still
tracked separately because many legacy core tests import real engine/tools
implementations. Do not treat a test-only cycle as permission to add production
cycles.

## Rollback

Phase 2 commits should stay independently revertible:

1. Revert the smallest package-boundary commit that introduced the regression.
2. Keep old public import paths working until callers have been migrated.
3. Re-run `bun run typecheck` and `bun run baseline:refactor` after the revert.
4. If a provider-path change fails, restore the previous compatibility entry
   point first, then reattempt the package extraction in a smaller step.

## Remaining Debt

- `packages/ai` still imports `#core` for config, model helpers, message
  types, and the heavy `queryOpenAI` orchestration path. Provider transport
  logging/providers/constants are now ai-owned with host `bindAiDebug`.
- `packages/tools` still has compatibility imports from `#core` and two
  production imports from `@kode/engine/orchestrator` for agent tools.
- `packages/engine` still depends on shared services in `#core`.
- Some tests remain located under `packages/core/src/test` while exercising
  extracted packages.

These are explicit follow-up items. They should be reduced by moving the owner
of each shared contract to a narrower package, not by hiding imports behind
dynamic import strings.
