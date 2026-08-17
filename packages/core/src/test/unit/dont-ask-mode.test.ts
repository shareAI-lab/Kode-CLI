import { describe, expect, test, beforeEach } from 'bun:test'
import { hasPermissionsToUseTool } from '#core/permissions'
import {
  getCurrentProjectConfig,
  saveCurrentProjectConfig,
} from '#core/utils/config'
import type { PermissionMode } from '#core/types/PermissionMode'
import type { ToolUseContext } from '#core/tooling/Tool'
import { createAssistantMessage } from '#core/utils/messages'
import { BashTool } from '#tools/tools/system/BashTool/BashTool'

const makeContext = (permissionMode: PermissionMode): ToolUseContext => ({
  abortController: new AbortController(),
  messageId: 'test',
  options: {
    commands: [],
    tools: [],
    verbose: false,
    safeMode: false,
    forkNumber: 0,
    messageLogName: 'test',
    maxThinkingTokens: 0,
    permissionMode,
  },
  readFileTimestamps: {},
})

describe('Ask permission mode', () => {
  beforeEach(() => {
    const current = getCurrentProjectConfig()
    saveCurrentProjectConfig({
      ...current,
      allowedTools: [],
      deniedTools: [],
      askedTools: [],
    })
  })

  test('requests approval for promptable tool uses', async () => {
    const ctx = makeContext('cautious')
    const result = await hasPermissionsToUseTool(
      BashTool,
      { command: 'echo hi' },
      ctx,
      createAssistantMessage(''),
    )

    expect(result.result).toBe(false)
    if (result.result !== false) throw new Error('Expected permission request')
    expect(result.shouldPromptUser).not.toBe(false)
  })
})
