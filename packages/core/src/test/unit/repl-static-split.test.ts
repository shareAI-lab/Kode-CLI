import { describe, expect, test } from 'bun:test'
import type { ContentBlockParam } from '@anthropic-ai/sdk/resources/index.mjs'
import {
  createAssistantMessage,
  createProgressMessage,
  createUserMessage,
  getToolUseID,
  getUnresolvedToolUseIDs,
  normalizeMessages,
  reorderMessages,
  type NormalizedMessage,
} from '#core/utils/messages'
import { getReplStaticPrefixLength } from '#cli-utils/replStaticSplit'

function makeToolUseAssistant(toolUseID: string) {
  const base = createAssistantMessage('ignored')
  const content = [
    { type: 'tool_use', id: toolUseID, name: 'Echo', input: {} },
  ] satisfies any[]
  return {
    ...base,
    message: {
      ...base.message,
      content,
    },
  }
}

function makeToolResult(toolUseID: string, content = 'ok') {
  const blocks = [
    { type: 'tool_result', tool_use_id: toolUseID, content },
  ] satisfies ContentBlockParam[]
  return createUserMessage(blocks)
}

describe('REPL Static prefix split', () => {
  test('static portion is always a prefix of the ordered messages', () => {
    const pre = createAssistantMessage('pre')
    const tool = makeToolUseAssistant('t1')
    const post = createAssistantMessage('post')

    const normalized = normalizeMessages([pre, tool, post])
    const ordered = reorderMessages(normalized)
    const unresolved = getUnresolvedToolUseIDs(normalized)

    expect(unresolved).toEqual(new Set(['t1']))

    const prefixLen = getReplStaticPrefixLength(
      ordered,
      normalized,
      unresolved,
      false,
    )
    const prefixedLenWithRecent = getReplStaticPrefixLength(
      ordered,
      normalized,
      unresolved,
    )

    // Even though `post` is individually static-eligible (no tool_use),
    // once we hit a transient tool_use, everything after must stay transient.
    expect(prefixLen).toBe(1)
    // The bottom-anchored frame keeps the last few completed messages transient.
    expect(prefixedLenWithRecent).toBe(0)
  })

  test('static prefix length is monotonic as tools resolve', () => {
    const pre = createAssistantMessage('pre')
    const post = createAssistantMessage('post')

    const tool1 = makeToolUseAssistant('t1')
    const tool2 = makeToolUseAssistant('t2')

    const step1 = [pre, tool1, post]
    const n1 = normalizeMessages(step1)
    const o1 = reorderMessages(n1)
    const u1 = getUnresolvedToolUseIDs(n1)
    const p1 = getReplStaticPrefixLength(o1, n1, u1)

    const step2 = [pre, tool1, makeToolResult('t1', 'done'), post]
    const n2 = normalizeMessages(step2)
    const o2 = reorderMessages(n2)
    const u2 = getUnresolvedToolUseIDs(n2)
    const p2 = getReplStaticPrefixLength(o2, n2, u2)

    const step3 = [pre, tool1, makeToolResult('t1', 'done'), post, tool2]
    const n3 = normalizeMessages(step3)
    const o3 = reorderMessages(n3)
    const u3 = getUnresolvedToolUseIDs(n3)
    const p3 = getReplStaticPrefixLength(o3, n3, u3)

    const step4 = [
      pre,
      tool1,
      makeToolResult('t1', 'done'),
      post,
      tool2,
      makeToolResult('t2', 'done'),
    ]
    const n4 = normalizeMessages(step4)
    const o4 = reorderMessages(n4)
    const u4 = getUnresolvedToolUseIDs(n4)
    const p4 = getReplStaticPrefixLength(o4, n4, u4)

    const prefixLengths = [p1, p2, p3, p4]
    const sorted = prefixLengths.slice().sort((a, b) => a - b)
    expect(prefixLengths).toEqual(sorted)
    expect(u2.size).toBe(0)
    expect(u4.size).toBe(0)
  })

  test('preserves the first progress match when a sibling tool use is missing', () => {
    const toolUseID = 'resolved'
    const firstProgress = createProgressMessage(
      toolUseID,
      new Set(['missing-sibling']),
      createAssistantMessage('first'),
      [],
      [],
    )
    const laterProgress = createProgressMessage(
      toolUseID,
      new Set(),
      createAssistantMessage('later'),
      [],
      [],
    )
    const normalized = normalizeMessages([
      makeToolUseAssistant(toolUseID),
      firstProgress,
      laterProgress,
      makeToolResult(toolUseID),
    ])

    expect(
      getReplStaticPrefixLength(
        normalized,
        normalized,
        new Set(['missing-sibling']),
      ),
    ).toBe(0)
  })

  test('keeps an orphaned tool result static when its tool use is missing', () => {
    const normalized = normalizeMessages([makeToolResult('missing-tool-use')])

    expect(
      getReplStaticPrefixLength(normalized, normalized, new Set(), false),
    ).toBe(1)
  })

  test('indexes a long tool transcript once while preserving order and boundary', () => {
    const toolPairCount = 1000
    const transcript = Array.from({ length: toolPairCount }).flatMap(
      (_, index) => {
        const toolUseID = `tool-${index}`
        return [
          makeToolUseAssistant(toolUseID),
          createProgressMessage(
            toolUseID,
            new Set([toolUseID]),
            createAssistantMessage(`progress-${index}`),
            [],
            [],
          ),
          makeToolResult(toolUseID),
        ]
      },
    )
    const pendingToolUseID = 'pending'
    const normalized = normalizeMessages([
      ...transcript,
      makeToolUseAssistant(pendingToolUseID),
      createAssistantMessage('after pending'),
    ])
    const ordered = reorderMessages(normalized)
    const unresolved = getUnresolvedToolUseIDs(normalized)
    let observedTypeReads = 0
    const observedAllMessages: NormalizedMessage[] = normalized.map(
      message =>
        new Proxy(message, {
          get(target, property, receiver) {
            if (property === 'type') observedTypeReads++
            return Reflect.get(target, property, receiver)
          },
        }),
    )

    const prefixLen = getReplStaticPrefixLength(
      ordered,
      observedAllMessages,
      unresolved,
    )
    const expectedOrder = Array.from({ length: toolPairCount }).flatMap(
      (_, index) => {
        const toolUseID = `tool-${index}`
        return [
          `assistant:${toolUseID}`,
          `progress:${toolUseID}`,
          `user:${toolUseID}`,
        ]
      },
    )

    expect(
      ordered
        .slice(0, prefixLen)
        .map(message => `${message.type}:${getToolUseID(message)}`),
    ).toEqual(expectedOrder.slice(0, prefixLen))
    // The bottom-anchored frame keeps the six most recent messages transient.
    expect(prefixLen).toBe(toolPairCount * 3 - 6)
    expect(getToolUseID(ordered[prefixLen]!)).toBe('tool-998')
    expect(getToolUseID(ordered[toolPairCount * 3]!)).toBe(pendingToolUseID)
    expect(getToolUseID(ordered[toolPairCount * 3 + 1]!)).toBeNull()
    expect(observedTypeReads).toBe(normalized.length)
  })
})
