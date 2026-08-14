import { describe, expect, test } from 'bun:test'

import { hasPermissionsToUseTool } from '#core/permissions/engine'
import { createAssistantMessage } from '#core/utils/messages'

function makePlanContext() {
  return {
    abortController: new AbortController(),
    messageId: 'plan-permission-test',
    readFileTimestamps: {},
    options: {
      permissionMode: 'plan',
      messageLogName: 'plan-permission-test',
      forkNumber: 0,
      toolPermissionContext: {
        mode: 'plan',
        additionalWorkingDirectories: new Map(),
        // The hard Plan-mode gate must win even if a permissive rule has
        // reached this context through configuration or a provider.
        alwaysAllowRules: { session: ['*'] },
        alwaysDenyRules: {},
        alwaysAskRules: {},
        isBypassPermissionsModeAvailable: false,
      },
    },
  } as any
}

describe('Plan permission mode', () => {
  test('hard-denies a non-read-only tool before regular permission handling', async () => {
    const result = await hasPermissionsToUseTool(
      {
        name: 'Edit',
        isReadOnly: () => false,
        needsPermissions: () => false,
      } as any,
      { file_path: 'src/example.ts' },
      makePlanContext(),
      createAssistantMessage(''),
    )

    expect(result.result).toBe(false)
    if (result.result) throw new Error('Expected Plan mode to block Edit')
    expect(result.shouldPromptUser).toBe(false)
    expect(result.message).toContain('read-only Plan mode')
  })

  test('allows a read-only tool without relying on a static tool-name list', async () => {
    const result = await hasPermissionsToUseTool(
      {
        name: 'ThirdPartyReadTool',
        isReadOnly: () => true,
        needsPermissions: () => false,
      } as any,
      {},
      makePlanContext(),
      createAssistantMessage(''),
    )

    expect(result).toMatchObject({ result: true })
  })

  test('allows only the read-only branch of an input-dependent tool', async () => {
    const tool = {
      name: 'Bash',
      isReadOnly: (input: { command?: string }) => input.command === 'git diff',
      needsPermissions: () => false,
    } as any

    await expect(
      hasPermissionsToUseTool(
        tool,
        { command: 'git diff' },
        makePlanContext(),
        createAssistantMessage(''),
      ),
    ).resolves.toMatchObject({ result: true })

    await expect(
      hasPermissionsToUseTool(
        tool,
        { command: 'touch generated.txt' },
        makePlanContext(),
        createAssistantMessage(''),
      ),
    ).resolves.toMatchObject({ result: false, shouldPromptUser: false })
  })
})
