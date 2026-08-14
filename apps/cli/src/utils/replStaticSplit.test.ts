import { describe, expect, test } from 'bun:test'
import type { NormalizedMessage } from '#core/utils/messages'
import {
  RECENT_MESSAGES_KEPT_IN_FRAME,
  getReplStaticPrefixLength,
} from './replStaticSplit'

function makeMessage(
  id: string,
  type: 'user' | 'assistant' = 'user',
): NormalizedMessage {
  return {
    uuid: id,
    type,
    role: type === 'user' ? 'user' : 'assistant',
    message: {
      id,
      role: type === 'user' ? 'user' : 'assistant',
      type: 'message',
      content: `msg-${id}`,
      usage: {} as never,
    },
  } as unknown as NormalizedMessage
}

function makeToolUseMessage(id: string): NormalizedMessage {
  return {
    uuid: id,
    type: 'assistant',
    role: 'assistant',
    message: {
      id,
      role: 'assistant',
      type: 'message',
      content: [{ type: 'tool_use', id: `tu-${id}`, name: 'Bash', input: {} }],
      usage: {} as never,
    },
  } as unknown as NormalizedMessage
}

describe('repl static prefix (bottom-anchored frame)', () => {
  test('keeps recent completed messages in the transient frame', () => {
    const messages = Array.from({ length: 10 }, (_, i) => makeMessage(`m${i}`))

    expect(getReplStaticPrefixLength(messages, messages, new Set())).toBe(
      Math.max(0, 10 - RECENT_MESSAGES_KEPT_IN_FRAME),
    )
  })

  test('keeps short conversations entirely in the transient frame', () => {
    const messages = Array.from({ length: 3 }, (_, i) => makeMessage(`m${i}`))

    expect(getReplStaticPrefixLength(messages, messages, new Set())).toBe(0)
  })

  test('keeps recent messages in frame while a later message is in flight', () => {
    const done = Array.from({ length: 8 }, (_, i) => makeMessage(`m${i}`))
    const inFlight = makeToolUseMessage('running')
    const all = [...done, inFlight]
    const unresolved = new Set(['tu-running'])

    // The in-flight message stops the scan; the tail of the completed prefix
    // is still held back for the bottom-anchored frame.
    expect(getReplStaticPrefixLength(all, all, unresolved)).toBe(
      Math.max(0, 8 - RECENT_MESSAGES_KEPT_IN_FRAME),
    )
  })

  test('keepRecentInFrame=false freezes everything into static (tiny viewports)', () => {
    const messages = Array.from({ length: 10 }, (_, i) => makeMessage(`m${i}`))

    expect(
      getReplStaticPrefixLength(messages, messages, new Set(), false),
    ).toBe(10)
  })
})
