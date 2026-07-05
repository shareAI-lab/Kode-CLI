import { describe, expect, test } from 'bun:test'
import type { Message } from '#core/query'
import {
  createAssistantAPIErrorMessage,
  createUserMessage,
} from '#core/utils/messages'
import {
  kodeMessageToSdkMessage,
  makeSdkResultMessage,
} from '#protocol/utils/kodeAgentStreamJson'
import { runSingleTurnPrint } from '#host-cli/entrypoints/cli/print/runSingleTurn'

describe('print mode API error results', () => {
  test('API error assistant messages emit failed results and exit non-zero', async () => {
    const written: unknown[] = []
    let exitCode: number | undefined
    const originalExit = process.exit

    process.exit = ((code?: string | number | null | undefined) => {
      exitCode = typeof code === 'number' ? code : Number(code ?? 0)
      throw new Error(`process.exit:${exitCode}`)
    }) as typeof process.exit

    try {
      await expect(
        runSingleTurnPrint({
          runTurn: async function* (): AsyncGenerator<Message, void> {
            yield createAssistantAPIErrorMessage(
              'API Error: provider unavailable',
            )
          },
          kodeMessageToSdkMessage,
          makeSdkResultMessage,
          messages: [createUserMessage('hi')],
          systemPrompt: [],
          context: {},
          canUseTool: (async () => ({ result: true })) as any,
          toolUseContext: {
            abortController: new AbortController(),
            turnCount: 1,
          } as any,
          sessionId: 'sess_test',
          outputFormat: 'stream-json',
          writeSdkLine: obj => {
            written.push(obj)
          },
          sdkMessages: [],
          startedAt: Date.now(),
          getTotalCostUsd: () => 0,
          getTotalApiDurationMs: () => 0,
          jsonSchema: null,
          verbose: false,
        }),
      ).rejects.toThrow('process.exit:1')
    } finally {
      process.exit = originalExit
    }

    const result = written.find(
      (line): line is Record<string, unknown> =>
        Boolean(line) &&
        typeof line === 'object' &&
        (line as Record<string, unknown>).type === 'result',
    )

    expect(exitCode).toBe(1)
    expect(result?.subtype).toBe('error_during_execution')
    expect(result?.is_error).toBe(true)
    expect(result?.result).toBe('API Error: provider unavailable')
  })
})
