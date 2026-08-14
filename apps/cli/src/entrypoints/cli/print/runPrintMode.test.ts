import { afterEach, describe, expect, test } from 'bun:test'

import { runPrintMode } from './runPrintMode'

const originalExit = process.exit
let exitCalls: number[] = []

/**
 * In production, process.exit() never returns, so runPrintMode's own
 * try/catch never observes it. The stub simulates that by throwing; the
 * first recorded call is therefore the exit code production would use.
 */
function stubExit(): void {
  process.exit = ((code?: string | number | null | undefined) => {
    exitCalls.push(typeof code === 'number' ? code : Number(code ?? 0))
    throw new Error(`process.exit:${code ?? 0}`)
  }) as typeof process.exit
}

afterEach(() => {
  process.exit = originalExit
  exitCalls = []
  delete process.env.KODE_SKIP_PROMPT_HISTORY
})

function baseArgs(
  overrides: Record<string, unknown> = {},
): Parameters<typeof runPrintMode>[0] {
  return {
    prompt: undefined,
    stdinContent: '',
    inputPrompt: 'hello',
    cwd: process.cwd(),
    outputFormat: 'text',
    inputFormat: 'text',
    tools: [],
    commands: [],
    ask: async () => ({
      resultText: 'completed response',
      totalCost: 10,
      messageHistoryFile: 'unused',
    }),
    maxBudgetUsd: 50,
    sessionPersistence: false,
    mcpClients: [],
    ...overrides,
  } as Parameters<typeof runPrintMode>[0]
}

describe('runPrintMode text-mode exit codes', () => {
  test('exits non-zero when the USD budget is exceeded after ask returns', async () => {
    process.env.KODE_SKIP_PROMPT_HISTORY = '1'
    stubExit()

    await expect(
      runPrintMode(
        baseArgs({
          maxBudgetUsd: 5,
          ask: async () => ({
            resultText: 'partial response',
            totalCost: 100,
            messageHistoryFile: 'unused',
          }),
        }),
      ),
    ).rejects.toThrow(/process\.exit:\d+/)
    expect(exitCalls[0]).toBe(1)
  })

  test('exits non-zero when a thrown MaxBudgetUsdExceededError stops the run', async () => {
    process.env.KODE_SKIP_PROMPT_HISTORY = '1'
    stubExit()

    const { MaxBudgetUsdExceededError } =
      await import('#core/errors/maxBudgetUsd')
    await expect(
      runPrintMode(
        baseArgs({
          maxBudgetUsd: 5,
          ask: async () => {
            throw new MaxBudgetUsdExceededError({
              maxBudgetUsd: 5,
              totalCostUsd: 100,
            })
          },
        }),
      ),
    ).rejects.toThrow(/process\.exit:\d+/)
    expect(exitCalls[0]).toBe(1)
  })

  test('still exits zero when the run completes within budget', async () => {
    process.env.KODE_SKIP_PROMPT_HISTORY = '1'
    stubExit()

    await expect(runPrintMode(baseArgs())).rejects.toThrow(/process\.exit:\d+/)
    expect(exitCalls[0]).toBe(0)
  })
})
