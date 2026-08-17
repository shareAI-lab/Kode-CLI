import { describe, expect, test } from 'bun:test'
import { hasPermissionsToUseTool } from '#core/permissions'
import { FileWriteTool } from '#tools/tools/filesystem/FileWriteTool/FileWriteTool'
import { homedir } from 'os'
import { resolve } from 'path'
import type { ToolUseContext } from '#core/tooling/Tool'
import { createAssistantMessage } from '#core/utils/messages'

describe('Edit mode safety floor', () => {
  test('denies sensitive writes in Edit mode', async () => {
    const filePath = resolve(homedir(), '.ssh', 'config')
    const ctx: ToolUseContext = {
      abortController: new AbortController(),
      messageId: undefined,
      readFileTimestamps: {},
      options: { permissionMode: 'acceptEdits', safeMode: false },
    }
    const result = await hasPermissionsToUseTool(
      FileWriteTool,
      { file_path: filePath, content: 'x' },
      ctx,
      createAssistantMessage(''),
    )
    expect(result.result).toBe(false)
    if (result.result !== false) throw new Error('Expected write to be denied')
    expect(result.shouldPromptUser).toBe(false)
    expect(result.requiresExplicitApproval).toBe(true)
    expect(result.message).toContain('sensitive')
  })

  test('keeps sensitive paths protected regardless of legacy escape-hatch env', async () => {
    const prev = process.env.KODE_BYPASS_SAFETY_FLOOR
    process.env.KODE_BYPASS_SAFETY_FLOOR = '1'
    try {
      const filePath = resolve(homedir(), '.ssh', 'config')
      const ctx: ToolUseContext = {
        abortController: new AbortController(),
        messageId: undefined,
        readFileTimestamps: {},
        options: { permissionMode: 'acceptEdits', safeMode: false },
      }
      const result = await hasPermissionsToUseTool(
        FileWriteTool,
        { file_path: filePath, content: 'x' },
        ctx,
        createAssistantMessage(''),
      )
      // The env escape hatch was removed for security: sensitive system
      // paths must stay protected regardless of environment configuration.
      expect(result.result).toBe(false)
    } finally {
      if (prev === undefined) delete process.env.KODE_BYPASS_SAFETY_FLOOR
      else process.env.KODE_BYPASS_SAFETY_FLOOR = prev
    }
  })
})
