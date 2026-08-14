import { describe, expect, mock, test } from 'bun:test'
import { z } from 'zod'

import { createExternalToolCallBridge } from './external-tool-bridge'

function createToolContext(tool: any) {
  return {
    abortController: new AbortController(),
    messageId: undefined,
    readFileTimestamps: {},
    setToolJSX: () => {},
    options: {
      commands: [],
      forkNumber: 0,
      messageLogName: 'external-tool-bridge-test',
      tools: [tool],
      verbose: false,
      safeMode: false,
      maxThinkingTokens: 0,
    },
  } as any
}

function createReadOnlyTool(call: ReturnType<typeof mock>) {
  return {
    name: 'Read',
    description: 'Read a file',
    inputSchema: z.object({ file_path: z.string() }),
    prompt: async () => 'Read a file',
    isEnabled: async () => true,
    readModeAccess: 'always' as const,
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    needsPermissions: () => true,
    renderToolUseMessage: () => null,
    renderResultForAssistant: (output: { text: string }) => output.text,
    call,
  }
}

describe('external runtime tool bridge', () => {
  test('uses the normal Kode permission path before returning a tool result', async () => {
    const call = mock(async function* () {
      yield { type: 'result' as const, data: { text: 'source contents' } }
    })
    const tool = createReadOnlyTool(call)
    const context = createToolContext(tool)
    const canUseTool = mock(async () => ({ result: true as const }))

    const result = await createExternalToolCallBridge({
      canUseTool,
      toolUseContext: context,
    })({
      toolUseId: 'codex-call-1',
      toolName: 'Read',
      input: { file_path: '/tmp/example.ts' },
    })

    expect(canUseTool).toHaveBeenCalledTimes(1)
    expect(call).toHaveBeenCalledTimes(1)
    expect(result).toEqual({ success: true, content: 'source contents' })
    expect(context.options.externalToolCallCount).toBe(1)
  })

  test('returns a rejected result without running the tool', async () => {
    const call = mock(async function* () {
      yield { type: 'result' as const, data: { text: 'must not run' } }
    })
    const tool = createReadOnlyTool(call)
    const context = createToolContext(tool)
    const canUseTool = mock(async () => ({
      result: false as const,
      message: 'Permission denied by Kode.',
    }))

    const result = await createExternalToolCallBridge({
      canUseTool,
      toolUseContext: context,
    })({
      toolUseId: 'codex-call-2',
      toolName: 'Read',
      input: { file_path: '/tmp/example.ts' },
    })

    expect(call).not.toHaveBeenCalled()
    expect(result).toEqual({
      success: false,
      content: 'Permission denied by Kode.',
    })
  })

  test('blocks a write-capable dynamic call before permission or execution', async () => {
    const call = mock(async function* () {
      yield { type: 'result' as const, data: { text: 'must not run' } }
    })
    const tool = {
      ...createReadOnlyTool(call),
      isReadOnly: () => false,
    }
    const context = createToolContext(tool)
    const canUseTool = mock(async () => ({ result: true as const }))

    const result = await createExternalToolCallBridge({
      canUseTool,
      toolUseContext: context,
    })({
      toolUseId: 'codex-call-3',
      toolName: 'Read',
      input: { file_path: '/tmp/example.ts' },
    })

    expect(canUseTool).not.toHaveBeenCalled()
    expect(call).not.toHaveBeenCalled()
    expect(result).toEqual({
      success: false,
      content:
        'The Codex OAuth dynamic tool bridge supports read-only Kode tool calls only.',
    })
  })

  test('blocks tools that were not explicitly exposed to read-only runtimes', async () => {
    const call = mock(async function* () {
      yield { type: 'result' as const, data: { text: 'must not run' } }
    })
    const tool = {
      ...createReadOnlyTool(call),
      name: 'Task',
      readModeAccess: undefined,
    }
    const context = createToolContext(tool)
    const canUseTool = mock(async () => ({ result: true as const }))

    const result = await createExternalToolCallBridge({
      canUseTool,
      toolUseContext: context,
    })({
      toolUseId: 'codex-call-profile-1',
      toolName: 'Task',
      input: { file_path: '/tmp/example.ts' },
    })

    expect(canUseTool).not.toHaveBeenCalled()
    expect(call).not.toHaveBeenCalled()
    expect(result).toEqual({
      success: false,
      content:
        'The Codex OAuth dynamic tool bridge does not expose this Kode tool in read-only mode.',
    })
  })

  test('rejects Bash parameters excluded by its read-only input schema', async () => {
    const call = mock(async function* () {
      yield { type: 'result' as const, data: { text: 'must not run' } }
    })
    const tool = {
      ...createReadOnlyTool(call),
      name: 'Bash',
      inputSchema: z.object({
        command: z.string(),
        dangerouslyDisableSandbox: z.boolean().optional(),
      }),
      readModeAccess: 'conditional' as const,
      readModeInputSchema: z.strictObject({ command: z.string() }),
      isReadOnly: (input: { command?: string }) => input.command === 'git diff',
    }
    const context = createToolContext(tool)
    const canUseTool = mock(async () => ({ result: true as const }))

    const result = await createExternalToolCallBridge({
      canUseTool,
      toolUseContext: context,
    })({
      toolUseId: 'codex-call-bash-1',
      toolName: 'Bash',
      input: { command: 'git diff', dangerouslyDisableSandbox: true },
    })

    expect(canUseTool).not.toHaveBeenCalled()
    expect(call).not.toHaveBeenCalled()
    expect(result).toEqual({
      success: false,
      content:
        'This dynamic tool call does not satisfy the Kode read-only input contract.',
    })
  })

  test('rejects interactive tools before asking for permission', async () => {
    const call = mock(async function* () {
      yield { type: 'result' as const, data: { text: 'must not run' } }
    })
    const tool = {
      ...createReadOnlyTool(call),
      requiresUserInteraction: () => true,
    }
    const context = createToolContext(tool)
    const canUseTool = mock(async () => ({ result: true as const }))

    const result = await createExternalToolCallBridge({
      canUseTool,
      toolUseContext: context,
    })({
      toolUseId: 'codex-call-4',
      toolName: 'Read',
      input: { file_path: '/tmp/example.ts' },
    })

    expect(canUseTool).not.toHaveBeenCalled()
    expect(call).not.toHaveBeenCalled()
    expect(result).toEqual({
      success: false,
      content:
        'The Codex OAuth dynamic tool bridge cannot run interactive Kode tools.',
    })
  })

  test('serializes external tool calls before entering the Kode tool path', async () => {
    let releaseFirst: (() => void) | undefined
    let markFirstStarted: (() => void) | undefined
    const firstStarted = new Promise<void>(resolve => {
      markFirstStarted = resolve
    })
    const started: string[] = []
    const call = mock(async function* (input: { file_path: string }) {
      started.push(input.file_path)
      if (input.file_path === '/tmp/first.ts') {
        markFirstStarted?.()
        await new Promise<void>(resolve => {
          releaseFirst = resolve
        })
      }
      yield { type: 'result' as const, data: { text: input.file_path } }
    })
    const tool = createReadOnlyTool(call)
    const context = createToolContext(tool)
    const bridge = createExternalToolCallBridge({
      canUseTool: mock(async () => ({ result: true as const })),
      toolUseContext: context,
    })

    const first = bridge({
      toolUseId: 'codex-call-5',
      toolName: 'Read',
      input: { file_path: '/tmp/first.ts' },
    })
    const second = bridge({
      toolUseId: 'codex-call-6',
      toolName: 'Read',
      input: { file_path: '/tmp/second.ts' },
    })

    await firstStarted
    expect(started).toEqual(['/tmp/first.ts'])
    releaseFirst?.()

    await expect(first).resolves.toEqual({
      success: true,
      content: '/tmp/first.ts',
    })
    await expect(second).resolves.toEqual({
      success: true,
      content: '/tmp/second.ts',
    })
    expect(started).toEqual(['/tmp/first.ts', '/tmp/second.ts'])
  })
})
