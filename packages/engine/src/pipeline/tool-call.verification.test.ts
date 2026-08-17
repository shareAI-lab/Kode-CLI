import { describe, expect, test } from 'bun:test'
import { z } from 'zod'
import { drainHookSystemPromptAdditions } from '@kode/hooks'
import type { Tool, ToolUseContext } from '@kode/tool-interface/Tool'
import { BashTool } from '#tools/tools/system/BashTool/BashTool'
import { createAssistantMessage } from '../messages/create'
import { checkPermissionsAndCallTool } from './tool-call'

type BashResult = {
  stdout: string
  stderr: string
  interrupted: boolean
  backgroundTaskId?: string
}

function createBashLikeTool(args: {
  trusted?: boolean
  output: BashResult
}): Tool {
  return {
    name: 'Bash',
    isTrustedExecutionTool: args.trusted ?? true,
    cachedDescription: 'Run shell command',
    inputSchema: z.object({ command: z.string() }),
    async description() {
      return 'Run shell command'
    },
    async prompt() {
      return 'Run shell command'
    },
    async isEnabled() {
      return true
    },
    isReadOnly() {
      return true
    },
    isConcurrencySafe() {
      return true
    },
    needsPermissions() {
      return false
    },
    renderToolUseMessage() {
      return null
    },
    renderResultForAssistant() {
      return 'tests passed'
    },
    async *call() {
      yield {
        type: 'result' as const,
        data: args.output,
        resultForAssistant: 'tests passed',
      }
    },
  }
}

function createContext(): ToolUseContext {
  return {
    agentId: 'main',
    abortController: new AbortController(),
    messageId: 'message-1',
    readFileTimestamps: {},
    options: {
      safeMode: false,
      tools: [],
      commands: [],
      verbose: false,
      forkNumber: 0,
      messageLogName: 'verification-receipt-test',
      maxThinkingTokens: 0,
    },
  }
}

async function runTool(tool: Tool, command = 'bun test ./packages/engine') {
  const context = createContext()
  const messages = []
  for await (const message of checkPermissionsAndCallTool(
    tool,
    'verify-1',
    new Set(),
    { command },
    context,
    (async () => ({ result: true })) as never,
    createAssistantMessage('Run a verification command'),
  )) {
    messages.push(message)
  }
  return { context, messages }
}

function resultData(messages: Awaited<ReturnType<typeof runTool>>['messages']) {
  const message = messages.find(item => item.type === 'user')
  if (!message?.toolUseResult) throw new Error('Expected a tool result')
  return message.toolUseResult.data as Record<string, unknown>
}

function resultMetadata(
  messages: Awaited<ReturnType<typeof runTool>>['messages'],
) {
  const message = messages.find(item => item.type === 'user')
  if (!message?.toolUseResult) throw new Error('Expected a tool result')
  return message.toolUseResult.metadata
}

describe('verification receipt pipeline', () => {
  test('records a real built-in Bash verification command', async () => {
    const { context, messages } = await runTool(
      BashTool,
      'bun test ./packages/engine/src/verification/receipt.test.ts',
    )

    expect(resultData(messages).verification).toMatchObject({
      kind: 'test',
      status: 'passed',
      toolUseId: 'verify-1',
    })
    expect(resultMetadata(messages)?.workspaceMutation).toMatchObject({
      toolUseId: 'verify-1',
      scope: 'none',
      basis: 'declared',
    })
    expect(drainHookSystemPromptAdditions(context).join('\n')).toContain(
      'exact test command completed with status passed',
    )
  })

  test('persists a passed receipt and queues trusted scope guidance', async () => {
    const { context, messages } = await runTool(
      createBashLikeTool({
        output: { stdout: '1 pass', stderr: '', interrupted: false },
      }),
    )

    expect(resultData(messages).verification).toMatchObject({
      version: 1,
      kind: 'test',
      status: 'passed',
      toolUseId: 'verify-1',
    })

    const rawToolResult = messages.find(message => message.type === 'user')
    expect(rawToolResult?.message.content).toEqual([
      {
        type: 'tool_result',
        content: 'tests passed',
        tool_use_id: 'verify-1',
      },
    ])

    const additions = drainHookSystemPromptAdditions(context).join('\n')
    expect(additions).toContain('Verification receipt (engine generated)')
    expect(additions).toContain(
      'exact test command completed with status passed',
    )
  })

  test('records a failed foreground command without calling it passed', async () => {
    const { context, messages } = await runTool(
      createBashLikeTool({
        output: {
          stdout: '',
          stderr: 'Exit code 1',
          interrupted: false,
        },
      }),
    )

    expect(resultData(messages).verification).toMatchObject({
      kind: 'test',
      status: 'failed',
    })
    expect(drainHookSystemPromptAdditions(context).join('\n')).toContain(
      'Do not report this verification as passed',
    )
  })

  test('does not create trusted evidence for untrusted or composite commands', async () => {
    const output = { stdout: '1 pass', stderr: '', interrupted: false }
    const untrusted = await runTool(
      createBashLikeTool({ trusted: false, output }),
    )
    const composite = await runTool(
      createBashLikeTool({ output }),
      'bun test && echo done',
    )

    expect(resultData(untrusted.messages).verification).toBeUndefined()
    expect(resultData(composite.messages).verification).toBeUndefined()
    expect(drainHookSystemPromptAdditions(untrusted.context)).toEqual([])
    expect(drainHookSystemPromptAdditions(composite.context)).toEqual([])
  })

  test('records an observed no-op instead of trusting a write-capable label', async () => {
    const writeCapableNoOp = {
      ...createBashLikeTool({
        output: { stdout: 'inspected', stderr: '', interrupted: false },
      }),
      name: 'CustomWorkspaceTool',
      isTrustedExecutionTool: false,
      isReadOnly() {
        return false
      },
    } satisfies Tool

    const { messages } = await runTool(writeCapableNoOp, 'inspect')

    expect(resultMetadata(messages)?.workspaceMutation).toMatchObject({
      toolUseId: 'verify-1',
      scope: 'none',
      basis: 'observed',
    })
  })

  test('hands failed delegated work back to the parent verification gate', async () => {
    const failedTask = {
      ...createBashLikeTool({
        output: { stdout: '', stderr: '', interrupted: false },
      }),
      name: 'Task',
      workspaceMutationScope(_input?: unknown, output?: { status?: string }) {
        return output?.status === 'failed'
          ? ('direct' as const)
          : ('delegated' as const)
      },
      async *call() {
        yield {
          type: 'result' as const,
          data: { status: 'failed' },
          resultForAssistant: 'Subagent failed',
        }
      },
    } satisfies Tool

    const { messages } = await runTool(failedTask, 'inspect')

    expect(resultMetadata(messages)?.workspaceMutation).toMatchObject({
      toolUseId: 'verify-1',
      scope: 'direct',
      basis: 'declared',
    })
  })
})
