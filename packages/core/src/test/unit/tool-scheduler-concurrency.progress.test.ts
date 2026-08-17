import { describe, expect, test } from 'bun:test'
import { __ToolUseQueueForTests } from '@kode/engine/pipeline/tool-use-queue'
import { z } from 'zod'
import type { Tool } from '#core/tooling/Tool'
import { createAssistantMessage } from '#core/utils/messages'
import type { ToolUseLikeBlockParam } from '#core/utils/anthropic'

function deferred<T = void>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function makeTool(options: {
  name: string
  inputSchema?: z.ZodType<any, any>
  isConcurrencySafe: boolean
  callImpl: Tool['call']
}): Tool {
  const inputSchema = options.inputSchema ?? z.object({})
  return {
    name: options.name,
    inputSchema,
    async prompt() {
      return ''
    },
    async isEnabled() {
      return true
    },
    isReadOnly() {
      return true
    },
    isConcurrencySafe() {
      return options.isConcurrencySafe
    },
    needsPermissions() {
      return false
    },
    renderResultForAssistant() {
      return ''
    },
    renderToolUseMessage() {
      return ''
    },
    call: options.callImpl,
  } satisfies Tool<typeof inputSchema>
}

function makeToolUse(
  id: string,
  name: string,
  input: any = {},
): ToolUseLikeBlockParam {
  return { id, name, input, type: 'tool_use' }
}

describe('Tool scheduler (ToolUseQueue) parity (progress + validation)', () => {
  test('schema.safeParse failure downgrades isConcurrencySafe to false', async () => {
    let isConcurrencySafeCalled = false

    const StrictTool = makeTool({
      name: 'StrictTool',
      inputSchema: z.object({ required: z.string() }),
      isConcurrencySafe: true,
      callImpl: async function* () {
        yield { type: 'result', data: { ok: true }, resultForAssistant: 'ok' }
      },
    })

    const spyTool = {
      ...StrictTool,
      isConcurrencySafe(_input?: any) {
        isConcurrencySafeCalled = true
        return true
      },
    }

    const toolUseContext: any = {
      abortController: new AbortController(),
      readFileTimestamps: {},
      setToolJSX: () => {},
      options: {
        tools: [spyTool],
        commands: [],
        forkNumber: 0,
        messageLogName: 'tool-scheduler-test',
        verbose: false,
        safeMode: false,
        maxThinkingTokens: 0,
      },
    }

    const queue: any = new __ToolUseQueueForTests({
      toolDefinitions: [spyTool],
      canUseTool: async () => ({ result: true }),
      toolUseContext,
      siblingToolUseIDs: new Set(['strict']),
    })

    const assistantMessage = createAssistantMessage('tools')

    queue.addTool(
      makeToolUse('strict', 'StrictTool', { invalid: true }),
      assistantMessage,
    )

    expect(isConcurrencySafeCalled).toBe(false)
    expect(queue['tools']?.[0]?.isConcurrencySafe).toBe(false)
  })

  test('queued tool use yields a queued Waiting… progress while blocked', async () => {
    const started: string[] = []
    const barrierGate = deferred()
    const afterGate = deferred()
    const sawWaiting = deferred()
    const sawRunning = deferred()

    const BarrierTool = makeTool({
      name: 'BarrierTool',
      isConcurrencySafe: false,
      callImpl: async function* (_input: any, ctx: any) {
        started.push(ctx.toolUseId)
        await barrierGate.promise
        yield { type: 'result', data: { ok: true }, resultForAssistant: 'ok' }
      },
    })

    const AfterTool = makeTool({
      name: 'AfterTool',
      isConcurrencySafe: true,
      callImpl: async function* (_input: any, ctx: any) {
        started.push(ctx.toolUseId)
        yield {
          type: 'progress',
          content: createAssistantMessage(
            '<tool-progress>Running…</tool-progress>',
          ),
        }
        await afterGate.promise
        yield { type: 'result', data: { ok: true }, resultForAssistant: 'ok' }
      },
    })

    const toolUseContext: any = {
      abortController: new AbortController(),
      readFileTimestamps: {},
      setToolJSX: () => {},
      options: {
        tools: [BarrierTool, AfterTool],
        commands: [],
        forkNumber: 0,
        messageLogName: 'tool-scheduler-test',
        verbose: false,
        safeMode: false,
        maxThinkingTokens: 0,
      },
    }

    const queue: any = new __ToolUseQueueForTests({
      toolDefinitions: [BarrierTool, AfterTool],
      canUseTool: async () => ({ result: true }),
      toolUseContext,
      siblingToolUseIDs: new Set(['barrier', 'after']),
    })

    const assistantMessage = createAssistantMessage('tools')

    let consumePromise: Promise<void> | null = null
    try {
      queue.addTool(makeToolUse('barrier', 'BarrierTool'), assistantMessage)
      queue.addTool(makeToolUse('after', 'AfterTool'), assistantMessage)

      consumePromise = (async () => {
        for await (const msg of queue.getRemainingResults()) {
          if (msg.type === 'progress') {
            const text =
              msg.content.message.content[0]?.type === 'text'
                ? msg.content.message.content[0].text
                : ''
            if (
              msg.toolUseID === 'after' &&
              String(text).includes('Waiting…')
            ) {
              sawWaiting.resolve()
            }
            if (
              msg.toolUseID === 'after' &&
              String(text).includes('Running…')
            ) {
              sawRunning.resolve()
            }
          }
        }
      })()

      await sawWaiting.promise
      expect(started).toEqual(['barrier'])

      barrierGate.resolve()
      await sawRunning.promise

      afterGate.resolve()
      await consumePromise
    } finally {
      barrierGate.resolve()
      afterGate.resolve()
      sawWaiting.resolve()
      sawRunning.resolve()
      if (consumePromise) await consumePromise
    }
  })
})
