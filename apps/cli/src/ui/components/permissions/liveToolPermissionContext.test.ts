import { describe, expect, test } from 'bun:test'

import type { ToolUseContext } from '#core/tooling/Tool'
import {
  createDefaultToolPermissionContext,
  type ToolPermissionContextUpdate,
} from '#core/types/toolPermissionContext'

import { applyToolPermissionUpdatesToLiveToolUseContext } from './liveToolPermissionContext'

describe('applyToolPermissionUpdatesToLiveToolUseContext', () => {
  test('applies updates to the in-flight ToolUseContext snapshot', () => {
    const toolPermissionContext = createDefaultToolPermissionContext({
      isBypassPermissionsModeAvailable: true,
    })

    const ctx: ToolUseContext = {
      abortController: new AbortController(),
      messageId: 'test',
      readFileTimestamps: {},
      options: { safeMode: false, toolPermissionContext },
    }

    const updates: ToolPermissionContextUpdate[] = [
      { type: 'setMode', mode: 'acceptEdits', destination: 'session' },
      {
        type: 'addDirectories',
        destination: 'session',
        directories: ['/tmp/example'],
      },
    ]

    applyToolPermissionUpdatesToLiveToolUseContext({
      toolUseContext: ctx,
      updates,
    })

    expect(ctx.options?.toolPermissionContext?.mode).toBe('acceptEdits')
    expect(
      ctx.options?.toolPermissionContext?.additionalWorkingDirectories.get(
        '/tmp/example',
      ),
    ).toEqual({ path: '/tmp/example', source: 'session' })
  })

  test('creates a default toolPermissionContext when missing', () => {
    const ctx: ToolUseContext = {
      abortController: new AbortController(),
      messageId: 'test',
      readFileTimestamps: {},
      options: { safeMode: true },
    }

    const updates: ToolPermissionContextUpdate[] = [
      { type: 'setMode', mode: 'plan', destination: 'session' },
    ]

    const out = applyToolPermissionUpdatesToLiveToolUseContext({
      toolUseContext: ctx,
      updates,
    })

    expect(out?.mode).toBe('plan')
  })
})
