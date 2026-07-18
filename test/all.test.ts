// Keep direct `bun test` scoped to workspace tests. Each file runs in its own
// process because Bun module mocks and mutable globals otherwise leak between
// dynamically imported test modules.

import { expect, test } from 'bun:test'

test(
  'workspace test files pass in separate processes',
  async () => {
    const child = Bun.spawn(
      [process.execPath, 'run', 'scripts/run-workspace-tests.mjs'],
      {
        cwd: process.cwd(),
        env: process.env,
        stdin: 'ignore',
        stdout: 'inherit',
        stderr: 'inherit',
      },
    )

    expect(await child.exited).toBe(0)
  },
  30 * 60 * 1000,
)
