import { describe, expect, test } from 'bun:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { AgentEvent } from '@kode/protocol'

import { ChatPage, __chatPageForTests } from './Chat'

function mcpProgressEvent(args: {
  uuid: string
  toolUseId: string
  progress: number
  server?: string
  tool?: string
}): AgentEvent {
  return {
    type: 'stream_event',
    uuid: args.uuid,
    session_id: 'session',
    parent_tool_use_id: args.toolUseId,
    event: {
      type: 'mcp_progress',
      server: args.server ?? 'srv',
      tool: args.tool ?? 'slow',
      toolUseId: args.toolUseId,
      progress: {
        progress: args.progress,
        total: 3,
        message: `step ${args.progress}`,
      },
    },
  }
}

describe('ChatPage event normalization', () => {
  test('coalesces repeated MCP progress events by tool use', () => {
    const events: AgentEvent[] = [
      {
        type: 'user',
        session_id: 'session',
        uuid: 'user-1',
        parent_tool_use_id: null,
        message: { role: 'user', content: 'run tool' },
      },
      mcpProgressEvent({
        uuid: 'progress-1',
        toolUseId: 'tool-a',
        progress: 1,
      }),
      mcpProgressEvent({
        uuid: 'progress-2',
        toolUseId: 'tool-a',
        progress: 2,
      }),
      mcpProgressEvent({
        uuid: 'progress-3',
        toolUseId: 'tool-b',
        progress: 1,
      }),
    ]

    const normalized = __chatPageForTests.getChatEventsForRender(events)

    expect(normalized.map(event => event.type)).toEqual([
      'user',
      'stream_event',
      'stream_event',
    ])
    expect((normalized[1] as any).uuid).toBe('progress-2')
    expect((normalized[2] as any).uuid).toBe('progress-3')
    expect(__chatPageForTests.getEventKey(normalized[1]!, 1)).toBe(
      'stream_event-mcp_progress-tool-a',
    )
  })

  test('includes system and permission events in terminal render order', () => {
    const events: AgentEvent[] = [
      {
        type: 'system',
        subtype: 'init',
        session_id: 'session',
        cwd: 'C:\\repo',
      },
    ]
    const permission = {
      type: 'permission_request' as const,
      request_id: 'perm-1',
      tool_name: 'Shell',
      tool_description: 'Run command',
      input: {},
    }

    const normalized = __chatPageForTests.getChatEventsForRender(events)
    const visible = __chatPageForTests.appendPermissionRequestEvent(
      normalized,
      permission,
    )

    expect(visible.map(event => event.type)).toEqual([
      'system',
      'permission_request',
    ])
    expect(__chatPageForTests.getEventKey(visible[1]!, 1)).toBe(
      'permission_request-perm-1',
    )
    expect(
      __chatPageForTests.appendPermissionRequestEvent(visible, permission),
    ).toHaveLength(2)
  })

  test('detects sticky bottom scroll state with a small threshold', () => {
    expect(
      __chatPageForTests.isNearScrollBottom({
        scrollTop: 928,
        clientHeight: 400,
        scrollHeight: 1400,
      }),
    ).toBe(true)

    expect(
      __chatPageForTests.isNearScrollBottom({
        scrollTop: 800,
        clientHeight: 400,
        scrollHeight: 1400,
      }),
    ).toBe(false)
  })

  test('preserves manual scroll position while new output streams', () => {
    expect(__chatPageForTests.getOutputFollowAction(true)).toBe('follow')
    expect(__chatPageForTests.getOutputFollowAction(false)).toBe(
      'mark-new-output',
    )
  })

  test('extracts prompt history from user events without duplicating repeats', () => {
    const events: AgentEvent[] = [
      {
        type: 'user',
        uuid: 'user-1',
        message: { role: 'user', content: 'first prompt' },
      },
      {
        type: 'assistant',
        uuid: 'assistant-1',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'reply' }],
        },
      },
      {
        type: 'user',
        uuid: 'user-2',
        message: { role: 'user', content: 'first prompt' },
      },
      {
        type: 'user',
        uuid: 'user-3',
        message: {
          role: 'user',
          content: [
            { type: 'text', text: 'second' },
            { type: 'image', source: {} },
          ],
        },
      },
    ]

    expect(__chatPageForTests.extractUserPromptHistory(events)).toEqual([
      'first prompt',
      'second',
    ])
  })

  test('navigates prompt history and restores draft text', () => {
    const history = ['first', 'second']

    const previous = __chatPageForTests.resolvePromptHistoryNavigation({
      history,
      currentValue: 'draft',
      cursor: null,
      draftValue: '',
      direction: 'previous',
    })
    expect(previous).toEqual({
      cursor: 1,
      value: 'second',
      draftValue: 'draft',
    })

    const older = __chatPageForTests.resolvePromptHistoryNavigation({
      history,
      currentValue: 'second',
      cursor: previous!.cursor,
      draftValue: previous!.draftValue,
      direction: 'previous',
    })
    expect(older).toEqual({
      cursor: 0,
      value: 'first',
      draftValue: 'draft',
    })

    const newer = __chatPageForTests.resolvePromptHistoryNavigation({
      history,
      currentValue: 'first',
      cursor: older!.cursor,
      draftValue: older!.draftValue,
      direction: 'next',
    })
    expect(newer).toEqual({
      cursor: 1,
      value: 'second',
      draftValue: 'draft',
    })

    expect(
      __chatPageForTests.resolvePromptHistoryNavigation({
        history,
        currentValue: 'second',
        cursor: newer!.cursor,
        draftValue: newer!.draftValue,
        direction: 'next',
      }),
    ).toEqual({
      cursor: null,
      value: 'draft',
      draftValue: '',
    })
  })

  test('renders a terminal transcript controlled by the prompt input', () => {
    const html = renderToStaticMarkup(
      React.createElement(ChatPage, {
        events: [],
        input: '',
        onInputChange: () => {},
        onSend: () => {},
        failedPrompt: 'retry this request',
        onRestoreFailedPrompt: () => {},
        runtimeAttached: true,
        permissionRequest: {
          type: 'permission_request',
          request_id: 'perm-1',
          tool_name: 'Shell',
          tool_description: 'Run command',
          input: {},
        },
        sessionTitle: 'New session',
        workspacePath: 'C:\\repo',
        runtimeStatus: {
          ok: true,
          transport: 'daemon',
          pid: 123,
          version: '2.2.1',
          activeSessions: 1,
        },
      }),
    )
    const controlsMatch = html.match(/<textarea[^>]+aria-controls="([^"]+)"/)

    expect(controlsMatch?.[1]).toBeTruthy()
    expect(html).toContain(`id="${controlsMatch?.[1]}"`)
    expect(html).toContain('role="log"')
    expect(html).toContain('Permission pending')
    expect(html).toContain('daemon online')
    expect(html).toContain(
      'Request stopped. Restore the prompt to retry safely.',
    )
    expect(html).toContain('Restore prompt')
    expect(html).toContain('Enter')
    expect(html).toContain('/help')
    expect(__chatPageForTests.chatTerminalHints.map(hint => hint.key)).toEqual([
      'Enter',
      'Shift+Enter',
      '/help',
    ])
  })
})
