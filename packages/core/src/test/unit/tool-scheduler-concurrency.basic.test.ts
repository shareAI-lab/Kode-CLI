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

async function waitFor(
  predicate: () => boolean,
  label: string,
  timeoutMs = 1_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for ${label}`)
    }
    await new Promise(resolve => setTimeout(resolve, 1))
  }
}

function makeTool(options: {
  name: string
  inputSchema?: z.ZodType<any, any>
  isConcurrencySafe: boolean
  callImpl: Tool['call']
}): Tool {
  return {
    name: options.name,
    inputSchema: options.inputSchema ?? z.object({}),
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
  } satisfies Tool
}

function makeToolUse(id: string, name: string, input: any = {}) {
  const toolUse: ToolUseLikeBlockParam = { id, name, input, type: 'tool_use' }
  return toolUse
}

describe('Tool scheduler (ToolUseQueue) parity', () => {
  test('concurrency-safe tool uses can start concurrently', async () => {
    const started: string[] = []
    const gateA = deferred()
    const gateB = deferred()

    const ToolA = makeTool({
      name: 'ToolA',
      isConcurrencySafe: true,
      callImpl: async function* (_input: any, ctx: any) {
        started.push(ctx.toolUseId)
        await gateA.promise
        yield { type: 'result', data: { ok: true }, resultForAssistant: 'ok' }
      },
    })
    const ToolB = makeTool({
      name: 'ToolB',
      isConcurrencySafe: true,
      callImpl: async function* (_input: any, ctx: any) {
        started.push(ctx.toolUseId)
        await gateB.promise
        yield { type: 'result', data: { ok: true }, resultForAssistant: 'ok' }
      },
    })

    const toolUseContext: any = {
      abortController: new AbortController(),
      readFileTimestamps: {},
      setToolJSX: () => {},
      options: {
        tools: [ToolA, ToolB],
        commands: [],
        forkNumber: 0,
        messageLogName: 'tool-scheduler-test',
        verbose: false,
        safeMode: false,
        maxThinkingTokens: 0,
      },
    }

    const queue: any = new __ToolUseQueueForTests({
      toolDefinitions: [ToolA, ToolB],
      canUseTool: async () => ({ result: true }),
      toolUseContext,
      siblingToolUseIDs: new Set(['a', 'b']),
    })

    const assistantMessage = createAssistantMessage('tools')

    let consumePromise: Promise<any[]> | null = null
    try {
      queue.addTool(makeToolUse('a', 'ToolA'), assistantMessage)
      queue.addTool(makeToolUse('b', 'ToolB'), assistantMessage)

      consumePromise = (async () => {
        const out: any[] = []
        for await (const msg of queue.getRemainingResults()) out.push(msg)
        return out
      })()

      await waitFor(
        () => started.length === 2,
        'both concurrent tools to start',
      )
      expect(new Set(started)).toEqual(new Set(['a', 'b']))

      gateA.resolve()
      gateB.resolve()

      const out = await consumePromise
      const toolResultIds = out
        .filter(m => m.type === 'user')
        .flatMap(m =>
          Array.isArray(m.message.content)
            ? m.message.content.filter((b: any) => b.type === 'tool_result')
            : [],
        )
        .map((b: any) => b.tool_use_id)

      expect(toolResultIds).toContain('a')
      expect(toolResultIds).toContain('b')
    } finally {
      gateA.resolve()
      gateB.resolve()
      if (consumePromise) {
        await consumePromise
      }
    }
  })

  test('non-concurrency-safe tool use acts as a barrier', async () => {
    const started: string[] = []
    const barrierGate = deferred()
    const afterGate = deferred()

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

    let consumePromise: Promise<any[]> | null = null
    try {
      queue.addTool(makeToolUse('barrier', 'BarrierTool'), assistantMessage)
      queue.addTool(makeToolUse('after', 'AfterTool'), assistantMessage)

      consumePromise = (async () => {
        const out: any[] = []
        for await (const msg of queue.getRemainingResults()) out.push(msg)
        return out
      })()

      await waitFor(() => started.includes('barrier'), 'barrier tool to start')
      expect(started).toEqual(['barrier'])

      barrierGate.resolve()
      await waitFor(
        () => started.includes('after'),
        'tool after barrier to start',
      )
      expect(new Set(started)).toEqual(new Set(['barrier', 'after']))

      afterGate.resolve()
      await consumePromise
    } finally {
      barrierGate.resolve()
      afterGate.resolve()
      if (consumePromise) {
        await consumePromise
      }
    }
  })

  test('tool error causes sibling_error synthetic tool_result for other tool uses', async () => {
    const started: string[] = []
    const slowGate = deferred()

    const FailTool = makeTool({
      name: 'FailTool',
      isConcurrencySafe: true,
      callImpl: async function* (_input: any, ctx: any) {
        started.push(ctx.toolUseId)
        throw new Error('boom')
      },
    })

    const SlowTool = makeTool({
      name: 'SlowTool',
      isConcurrencySafe: true,
      callImpl: async function* (_input: any, ctx: any) {
        started.push(ctx.toolUseId)
        await slowGate.promise
        yield { type: 'result', data: { ok: true }, resultForAssistant: 'ok' }
      },
    })

    const toolUseContext: any = {
      abortController: new AbortController(),
      readFileTimestamps: {},
      setToolJSX: () => {},
      options: {
        tools: [FailTool, SlowTool],
        commands: [],
        forkNumber: 0,
        messageLogName: 'tool-scheduler-test',
        verbose: false,
        safeMode: false,
        maxThinkingTokens: 0,
      },
    }

    const queue: any = new __ToolUseQueueForTests({
      toolDefinitions: [FailTool, SlowTool],
      canUseTool: async () => ({ result: true }),
      toolUseContext,
      siblingToolUseIDs: new Set(['fail', 'slow']),
    })

    const assistantMessage = createAssistantMessage('tools')

    let consumePromise: Promise<any[]> | null = null
    try {
      queue.addTool(makeToolUse('fail', 'FailTool'), assistantMessage)
      queue.addTool(makeToolUse('slow', 'SlowTool'), assistantMessage)

      consumePromise = (async () => {
        const out: any[] = []
        for await (const msg of queue.getRemainingResults()) out.push(msg)
        return out
      })()

      await waitFor(() => started.length === 2, 'both tools to start')
      expect(new Set(started)).toEqual(new Set(['fail', 'slow']))

      slowGate.resolve()

      const out = await consumePromise
      const toolResults = out
        .filter(m => m.type === 'user')
        .flatMap(m =>
          Array.isArray(m.message.content)
            ? m.message.content.filter((b: any) => b.type === 'tool_result')
            : [],
        )

      const failResult = toolResults.find((b: any) => b.tool_use_id === 'fail')
      const slowResult = toolResults.find((b: any) => b.tool_use_id === 'slow')

      expect(failResult?.is_error).toBe(true)
      expect(String(failResult?.content)).toContain('boom')

      expect(slowResult?.is_error).toBe(true)
      expect(slowResult?.content).toBe(
        '<tool_use_error>Sibling tool call errored</tool_use_error>',
      )
    } finally {
      slowGate.resolve()
      if (consumePromise) {
        await consumePromise
      }
    }
  })
})
