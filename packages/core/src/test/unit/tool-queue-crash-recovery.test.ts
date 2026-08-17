import { describe, expect, test } from 'bun:test'
import { __ToolUseQueueForTests } from '@kode/engine/pipeline/tool-use-queue'
import { z } from 'zod'
import type { Tool } from '#core/tooling/Tool'
import { createAssistantMessage } from '#core/utils/messages'
import type { ToolUseLikeBlockParam } from '#core/utils/anthropic'

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

function makeToolUseContext(tools: Tool[]): any {
  return {
    abortController: new AbortController(),
    readFileTimestamps: {},
    setToolJSX: () => {},
    options: {
      tools,
      commands: [],
      forkNumber: 0,
      messageLogName: 'tool-queue-crash-recovery-test',
      verbose: false,
      safeMode: false,
      maxThinkingTokens: 0,
    },
  }
}

function collectToolResults(out: any[]) {
  return out
    .filter(m => m.type === 'user')
    .flatMap(m =>
      Array.isArray(m.message.content)
        ? m.message.content.filter((b: any) => b.type === 'tool_result')
        : [],
    )
}

describe('Tool queue crash recovery', () => {
  test('drains with an error result when the tool generator breaks before yielding', async () => {
    // A circular input makes `runToolUse`'s pre-yield debug serialization
    // throw (JSON.stringify), which breaks the generator outside its normal
    // error-to-tool_result conversion path.
    const circularInput: any = { marker: 'self-referential' }
    circularInput.self = circularInput

    const Tool = makeTool({
      name: 'CircularTool',
      isConcurrencySafe: true,
      callImpl: async function* () {
        yield { type: 'result', data: { ok: true }, resultForAssistant: 'ok' }
      },
    })

    const toolUseContext = makeToolUseContext([Tool])
    const queue: any = new __ToolUseQueueForTests({
      toolDefinitions: [Tool],
      canUseTool: async () => ({ result: true }),
      toolUseContext,
      siblingToolUseIDs: new Set(['circular']),
    })

    queue.addTool(
      makeToolUse('circular', 'CircularTool', circularInput),
      createAssistantMessage('tools'),
    )

    const out: any[] = []
    for await (const message of queue.getRemainingResults()) {
      out.push(message)
    }

    const toolResults = collectToolResults(out)
    expect(toolResults).toHaveLength(1)
    expect(toolResults[0]?.tool_use_id).toBe('circular')
    expect(toolResults[0]?.is_error).toBe(true)
    expect(String(toolResults[0]?.content)).toContain('Tool execution failed')

    const entry = queue['tools']?.[0]
    expect(entry?.status).toBe('yielded')
  })

  test('a normal tool still drains normally after the crash guard is added', async () => {
    const Tool = makeTool({
      name: 'HealthyTool',
      isConcurrencySafe: true,
      callImpl: async function* () {
        yield { type: 'result', data: { ok: true }, resultForAssistant: 'ok' }
      },
    })

    const toolUseContext = makeToolUseContext([Tool])
    const queue: any = new __ToolUseQueueForTests({
      toolDefinitions: [Tool],
      canUseTool: async () => ({ result: true }),
      toolUseContext,
      siblingToolUseIDs: new Set(['healthy']),
    })

    queue.addTool(
      makeToolUse('healthy', 'HealthyTool', {}),
      createAssistantMessage('tools'),
    )

    const out: any[] = []
    for await (const message of queue.getRemainingResults()) {
      out.push(message)
    }

    const toolResults = collectToolResults(out)
    expect(toolResults).toHaveLength(1)
    expect(toolResults[0]?.tool_use_id).toBe('healthy')
    expect(toolResults[0]?.is_error).toBeUndefined()
    expect(String(toolResults[0]?.content)).toBe('ok')
  })

  test('sibling tools still receive synthetic errors after a generator crash', async () => {
    const circularInput: any = { marker: 'x' }
    circularInput.self = circularInput

    const BreakingTool = makeTool({
      name: 'BreakingTool',
      isConcurrencySafe: true,
      callImpl: async function* () {
        yield { type: 'result', data: { ok: true }, resultForAssistant: 'ok' }
      },
    })
    const HealthyTool = makeTool({
      name: 'HealthyTool',
      isConcurrencySafe: true,
      callImpl: async function* () {
        yield { type: 'result', data: { ok: true }, resultForAssistant: 'ok' }
      },
    })

    const toolUseContext = makeToolUseContext([BreakingTool, HealthyTool])
    const queue: any = new __ToolUseQueueForTests({
      toolDefinitions: [BreakingTool, HealthyTool],
      canUseTool: async () => ({ result: true }),
      toolUseContext,
      siblingToolUseIDs: new Set(['breaking', 'healthy']),
    })

    queue.addTool(
      makeToolUse('breaking', 'BreakingTool', circularInput),
      createAssistantMessage('tools'),
    )
    queue.addTool(
      makeToolUse('healthy', 'HealthyTool', {}),
      createAssistantMessage('tools'),
    )

    const out: any[] = []
    for await (const message of queue.getRemainingResults()) {
      out.push(message)
    }

    const toolResults = collectToolResults(out)
    expect(toolResults).toHaveLength(2)

    const breaking = toolResults.find((b: any) => b.tool_use_id === 'breaking')
    expect(breaking?.is_error).toBe(true)
    expect(String(breaking?.content)).toContain('Tool execution failed')

    const healthy = toolResults.find((b: any) => b.tool_use_id === 'healthy')
    expect(healthy?.is_error).toBe(true)
    expect(String(healthy?.content)).toBe(
      '<tool_use_error>Sibling tool call errored</tool_use_error>',
    )
  })
})
