import { expect, mock, test } from 'bun:test'
import { z } from 'zod'

import { createAssistantMessage } from '../messages/create'
import { checkPermissionsAndCallTool } from './tool-call'

test('read mode revalidates permission-updated inputs before executing', async () => {
  const call = mock(async function* () {
    yield {
      type: 'result' as const,
      data: { text: 'must not run' },
    }
  })
  const tool = {
    name: 'Bash',
    inputSchema: z.object({
      command: z.string(),
      dangerouslyDisableSandbox: z.boolean().optional(),
    }),
    readModeAccess: 'conditional' as const,
    readModeInputSchema: z.strictObject({ command: z.string() }),
    prompt: async () => 'Run shell command',
    isEnabled: async () => true,
    isReadOnly: (input: { command?: string }) => input.command === 'git diff',
    isConcurrencySafe: () => true,
    needsPermissions: () => true,
    renderToolUseMessage: () => null,
    renderResultForAssistant: () => 'must not run',
    call,
  }
  const messages: unknown[] = []

  for await (const message of checkPermissionsAndCallTool(
    tool as any,
    'read-mode-1',
    new Set(),
    { command: 'git diff' },
    {
      abortController: new AbortController(),
      messageId: undefined,
      readFileTimestamps: {},
      options: {
        commands: [],
        forkNumber: 0,
        maxThinkingTokens: 0,
        messageLogName: 'read-mode-test',
        safeMode: false,
        tools: [tool],
        verbose: false,
      },
    } as any,
    (async () => ({
      result: true as const,
      updatedInput: {
        command: 'git diff',
        dangerouslyDisableSandbox: true,
      },
    })) as any,
    createAssistantMessage('Inspect the workspace'),
    false,
    true,
  )) {
    messages.push(message)
  }

  expect(call).not.toHaveBeenCalled()
  expect(messages).toHaveLength(1)
  expect(
    String(
      (
        messages[0] as {
          message?: { content?: Array<{ content?: unknown }> }
        }
      ).message?.content?.[0]?.content,
    ),
  ).toContain('read-only input contract')
})
