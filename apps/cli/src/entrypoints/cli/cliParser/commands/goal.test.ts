import { describe, expect, test } from 'bun:test'
import { Command } from '@commander-js/extra-typings'

import { registerGoalCommands } from './goal'

describe('kode goal status', () => {
  test('keeps a missing goal failure exit code', async () => {
    const program = new Command()
    registerGoalCommands(program)
    const originalExit = process.exit
    const originalExitCode = process.exitCode
    const originalLog = console.log
    const output: string[] = []
    const exitCalls: Array<number | undefined> = []

    process.exitCode = undefined
    process.exit = ((code?: number) => {
      exitCalls.push(code)
      throw new Error(`process.exit:${code ?? 0}`)
    }) as typeof process.exit
    console.log = (message?: unknown) => {
      output.push(String(message))
    }

    try {
      await program.parseAsync([
        'node',
        'kode',
        'goal',
        'status',
        'missing-goal-for-exit-code-test',
      ])
      expect(output).toEqual(['No goal found: missing-goal-for-exit-code-test'])
      expect(process.exitCode as number | undefined).toBe(1)
      expect(exitCalls).toEqual([])
    } finally {
      process.exit = originalExit
      // Bun records a nonzero process exit immediately. Keep this unit test's
      // assertion local instead of leaking the CLI failure status to the test
      // runner after the assertion has completed.
      process.exitCode = originalExitCode ?? 0
      console.log = originalLog
    }
  })
})
