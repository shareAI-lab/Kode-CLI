import { describe, expect, test } from 'bun:test'
import type { ContentBlockParam } from '@anthropic-ai/sdk/resources/index.mjs'
import type { ToolUseLikeBlockParam } from '#core/utils/anthropic'
import {
  createAssistantAPIErrorMessage,
  createAssistantMessage,
  createProgressMessage,
  createUserMessage,
  getInProgressToolUseIDs,
  getUnresolvedToolUseIDs,
  normalizeMessages,
  normalizeMessagesForAPI,
  reorderMessages,
} from '#core/utils/messages'

function makeToolUseAssistant(toolUseID: string) {
  const base = createAssistantMessage('ignored')
  const toolUseBlock: ToolUseLikeBlockParam = {
    type: 'tool_use',
    id: toolUseID,
    name: 'Echo',
    input: {},
  }
  return {
    ...base,
    message: {
      ...base.message,
      content: [toolUseBlock],
    },
  }
}

function makeToolResult(toolUseID: string, content = 'ok') {
  const blocks = [
    { type: 'tool_result', tool_use_id: toolUseID, content },
  ] satisfies ContentBlockParam[]
  return createUserMessage(blocks)
}

describe('messages normalization + reordering parity', () => {
  test('normalizeMessagesForAPI merges consecutive user messages and keeps tool_result blocks first', () => {
    const merged = normalizeMessagesForAPI([
      makeToolResult('t1'),
      makeToolResult('t2'),
      createUserMessage('meta'),
      createAssistantMessage('ok'),
    ])

    expect(merged).toHaveLength(2)
    expect(merged[0]!.type).toBe('user')
    expect(merged[1]!.type).toBe('assistant')

    const first = merged[0]!
    if (first.type !== 'user')
      throw new Error('Expected first message to be user')
    const content = first.message.content
    expect(Array.isArray(content)).toBe(true)
    if (!Array.isArray(content)) throw new Error('Expected user content blocks')
    expect(content[0]).toMatchObject({ type: 'tool_result', tool_use_id: 't1' })
    expect(content[1]).toMatchObject({ type: 'tool_result', tool_use_id: 't2' })
    expect(content[2]).toMatchObject({ type: 'text', text: 'meta' })
  })

  test('normalizeMessagesForAPI filters api error assistant messages', () => {
    const degraded = createAssistantMessage('partial response')
    degraded.isApiErrorMessage = true
    degraded.message.model = 'gpt-4'

    const out = normalizeMessagesForAPI([
      createUserMessage('hi'),
      createAssistantAPIErrorMessage('oops'),
      degraded,
      createAssistantMessage('ok'),
    ])
    expect(out.map(m => m.type)).toEqual(['user', 'assistant'])
    const assistant = out[1]!
    if (assistant.type !== 'assistant')
      throw new Error('Expected assistant message')
    const firstBlock = assistant.message.content[0]
    if (!firstBlock || firstBlock.type !== 'text') {
      throw new Error('Expected assistant to contain a text block')
    }
    expect(firstBlock.text).toBe('ok')
  })

  test('normalizeMessagesForAPI merges assistant messages by id (ignoring intervening tool results)', () => {
    const a1 = createAssistantMessage('part 1')
    const base2 = createAssistantMessage('part 2')
    const a2 = { ...base2, message: { ...base2.message, id: a1.message.id } }

    const out = normalizeMessagesForAPI([a1, makeToolResult('t1'), a2])
    expect(out).toHaveLength(2)
    expect(out[0]!.type).toBe('assistant')
    const merged = out[0]!
    if (merged.type !== 'assistant')
      throw new Error('Expected assistant message')
    expect(merged.message.content.map(b => b.type)).toEqual(['text', 'text'])
  })

  test('reorderMessages inserts progress after tool_use and tool_result after progress', () => {
    const toolUse = makeToolUseAssistant('t1')
    const toolResult = makeToolResult('t1', 'done')
    const progress = createProgressMessage(
      't1',
      new Set(['t1']),
      createAssistantMessage('working'),
      [],
      [],
    )

    const normalized = normalizeMessages([toolUse, toolResult, progress])
    const reordered = reorderMessages(normalized)

    expect(reordered.map(m => m.type)).toEqual([
      'assistant',
      'progress',
      'user',
    ])
    expect(getUnresolvedToolUseIDs(reordered)).toEqual(new Set())
  })

  test('getInProgressToolUseIDs includes first unresolved and any unresolved with progress', () => {
    const t1 = makeToolUseAssistant('t1')
    const t2 = makeToolUseAssistant('t2')
    const progressT2 = createProgressMessage(
      't2',
      new Set(['t1', 't2']),
      createAssistantMessage('working'),
      [],
      [],
    )

    const normalized = normalizeMessages([t1, t2, progressT2])
    expect(getUnresolvedToolUseIDs(normalized)).toEqual(new Set(['t1', 't2']))
    expect(getInProgressToolUseIDs(normalized)).toEqual(new Set(['t1', 't2']))
  })
})
