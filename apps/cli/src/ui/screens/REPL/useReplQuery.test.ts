import { describe, expect, test } from 'bun:test'
import {
  createAssistantMessage,
  createProgressMessage,
  createUserMessage,
} from '#core/utils/messages'
import type { Message } from '#core/query'
import {
  __updateRequestStatusFromAssistantStreamForTests,
  appendMessagesForReplState,
  appendKodingSaveFailureMessage,
  appendReplQueryFailureMessage,
  CODEX_APP_SERVER_TIMEOUT_MESSAGE,
  REPL_QUERY_FAILURE_MESSAGE,
  shouldAppendReplQueryFailure,
} from './useReplQuery'
import { getRequestStatus, setRequestStatus } from '#core/utils/requestStatus'

function makeProgress(toolUseID: string, text: string): Message {
  return createProgressMessage(
    toolUseID,
    new Set([toolUseID]),
    createAssistantMessage(`<tool-progress>${text}</tool-progress>`),
    [],
    [],
  )
}

describe('appendMessagesForReplState', () => {
  test('replaces prior progress for the same tool use', () => {
    const user = createUserMessage('hello')
    const first = makeProgress('tool-1', 'Waiting...')
    const next = makeProgress('tool-1', 'Running...')

    const result = appendMessagesForReplState([user, first], [next])

    expect(result).toHaveLength(2)
    expect(result[0]).toBe(user)
    expect(result[1]).toBe(next)
  })

  test('keeps progress for different tool uses', () => {
    const first = makeProgress('tool-1', 'Running 1')
    const second = makeProgress('tool-2', 'Running 2')

    const result = appendMessagesForReplState([first], [second])

    expect(result).toEqual([first, second])
  })

  test('replaces the earliest matching progress message when legacy duplicates exist', () => {
    const first = makeProgress('tool-1', 'Waiting...')
    const duplicate = makeProgress('tool-1', 'Stale duplicate')
    const next = makeProgress('tool-1', 'Running...')

    const result = appendMessagesForReplState([first, duplicate], [next])

    expect(result).toEqual([next, duplicate])
  })

  test('appends ordinary messages without cloning an empty update', () => {
    const user = createUserMessage('hello')
    const assistant = createAssistantMessage('done')
    const original = [user]

    expect(appendMessagesForReplState(original, [])).toBe(original)
    expect(appendMessagesForReplState(original, [assistant])).toEqual([
      user,
      assistant,
    ])
  })
})

describe('REPL stream request status', () => {
  test('shows Thinking and Writing response from the main assistant stream', () => {
    setRequestStatus({ kind: 'idle' })
    try {
      __updateRequestStatusFromAssistantStreamForTests({
        type: 'thinking_delta',
        delta: 'Assessing the repository',
        agentId: 'main',
      })
      expect(getRequestStatus()).toMatchObject({
        kind: 'thinking',
        detail: 'Thinking',
      })

      __updateRequestStatusFromAssistantStreamForTests({
        type: 'text_delta',
        delta: 'I found the issue.',
        agentId: 'main',
      })
      expect(getRequestStatus()).toMatchObject({ kind: 'streaming' })
      expect(getRequestStatus().detail).toBeUndefined()
    } finally {
      setRequestStatus({ kind: 'idle' })
    }
  })

  test('does not let a subagent overwrite the main request status', () => {
    setRequestStatus({ kind: 'thinking', detail: 'Thinking' })
    try {
      __updateRequestStatusFromAssistantStreamForTests({
        type: 'text_delta',
        delta: 'hidden subagent output',
        agentId: 'worker-1',
      })
      expect(getRequestStatus()).toMatchObject({
        kind: 'thinking',
        detail: 'Thinking',
      })
    } finally {
      setRequestStatus({ kind: 'idle' })
    }
  })
})

describe('REPL query failures', () => {
  test('adds a safe, retryable API error to the transcript', () => {
    const user = createUserMessage('hello')
    const result = appendReplQueryFailureMessage([user])
    const failure = result.at(-1)

    expect(failure?.type).toBe('assistant')
    if (!failure || failure.type !== 'assistant') {
      throw new Error('Expected an assistant API error message')
    }

    expect(failure.isApiErrorMessage).toBe(true)
    expect(failure.message.content).toEqual([
      {
        type: 'text',
        text: REPL_QUERY_FAILURE_MESSAGE,
        citations: [],
      },
    ])
    expect(REPL_QUERY_FAILURE_MESSAGE).not.toContain('provider token')
  })

  test('does not append a second failure for timeout or cancellation', () => {
    expect(
      shouldAppendReplQueryFailure({
        timedOut: true,
        aborted: true,
        error: new Error('timed out'),
      }),
    ).toBe(false)
    expect(
      shouldAppendReplQueryFailure({
        timedOut: false,
        aborted: true,
        error: new Error('cancelled'),
      }),
    ).toBe(false)
    expect(
      shouldAppendReplQueryFailure({
        timedOut: false,
        aborted: false,
        error: new DOMException('cancelled', 'AbortError'),
      }),
    ).toBe(false)
  })

  test('explains a Codex app-server timeout without exposing its raw error', () => {
    const error = new Error('provider token: secret')
    error.name = 'CodexAppServerTimeoutError'

    const result = appendReplQueryFailureMessage(
      [createUserMessage('review code')],
      error,
    )
    const failure = result.at(-1)
    if (!failure || failure.type !== 'assistant') {
      throw new Error('Expected an assistant API error message')
    }

    expect(failure.message.content).toEqual([
      {
        type: 'text',
        text: CODEX_APP_SERVER_TIMEOUT_MESSAGE,
        citations: [],
      },
    ])
    expect(CODEX_APP_SERVER_TIMEOUT_MESSAGE).not.toContain('secret')
  })

  test('preserves the safe reason from a failed Codex turn', () => {
    const error = new Error('Codex app-server turn failed: Provider limit.')
    error.name = 'CodexAppServerTurnError'

    const result = appendReplQueryFailureMessage(
      [createUserMessage('review code')],
      error,
    )
    const failure = result.at(-1)
    if (!failure || failure.type !== 'assistant') {
      throw new Error('Expected an assistant API error message')
    }

    expect(failure.message.content).toEqual([
      {
        type: 'text',
        text: 'API Error: Codex app-server turn failed: Provider limit. Your prompt is saved; no project inspection or action was performed.',
        citations: [],
      },
    ])
  })

  test('does not expose redacted runtime diagnostics in the transcript', () => {
    const error = new Error('provider token: [REDACTED]')
    error.name = 'CodexAppServerRuntimeError'

    const result = appendReplQueryFailureMessage(
      [createUserMessage('review code')],
      error,
    )
    const failure = result.at(-1)
    if (!failure || failure.type !== 'assistant') {
      throw new Error('Expected an assistant API error message')
    }

    expect(failure.message.content).toEqual([
      {
        type: 'text',
        text: 'Codex / ChatGPT OAuth runtime stopped before the model completed. Your prompt is saved; no project inspection or action was performed. Check the local error log for redacted runtime diagnostics, then retry.',
        citations: [],
      },
    ])
  })

  test('keeps unclassified errors visible without exposing their details', () => {
    expect(
      shouldAppendReplQueryFailure({
        timedOut: false,
        aborted: false,
        error: new Error('provider token: secret'),
      }),
    ).toBe(true)
    expect(REPL_QUERY_FAILURE_MESSAGE).not.toContain('secret')
  })
})

describe('Koding note persistence failures', () => {
  test('adds a safe recovery message when generated notes cannot be saved', () => {
    const result = appendKodingSaveFailureMessage([createUserMessage('note')])
    const failure = result.at(-1)

    expect(failure?.type).toBe('assistant')
    if (!failure || failure.type !== 'assistant') {
      throw new Error('Expected a note persistence failure message')
    }

    expect(failure.message.content).toEqual([
      {
        type: 'text',
        text: '<local-command-stderr>Unable to save the note to AGENTS.md. Check the file path and permissions, then retry.</local-command-stderr>',
        citations: [],
      },
    ])
  })
})
