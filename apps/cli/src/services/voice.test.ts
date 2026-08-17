import { describe, expect, test } from 'bun:test'

import {
  getVoiceInputSystemPromptAdditions,
  makeVoiceNarration,
  splitVoiceNarration,
} from './voice'

describe('voice interaction helpers', () => {
  test('removes code and tool-shaped content before speech', () => {
    expect(
      makeVoiceNarration(
        '结论如下。\n```ts\nsecret()\n```\n<tool_result>hidden</tool_result>\n- 可以继续。',
        120,
      ),
    ).toBe('结论如下。 可以继续。')
  })

  test('truncates at a word boundary and scopes clarification guidance to voice', () => {
    expect(makeVoiceNarration('one two three four', 10)).toBe('one two')
    expect(getVoiceInputSystemPromptAdditions().join(' ')).toContain(
      'never invent omitted targets',
    )
    expect(getVoiceInputSystemPromptAdditions().join(' ')).toContain(
      'never call Task directly',
    )
    expect(getVoiceInputSystemPromptAdditions().join(' ')).toContain(
      'unresolved_questions',
    )
    expect(getVoiceInputSystemPromptAdditions().join(' ')).toContain(
      'continuation of a conversation',
    )
    expect(getVoiceInputSystemPromptAdditions().join(' ')).toContain(
      'Freeze a voice_intent only when moving from conversation to delegated execution',
    )
  })

  test('splits long speech into bounded natural chunks without dropping text', () => {
    expect(splitVoiceNarration('第一句。第二句！第三句？', 7)).toEqual([
      '第一句。',
      '第二句！',
      '第三句？',
    ])
    expect(splitVoiceNarration('abcdefgh', 3)).toEqual(['abc', 'def', 'gh'])
  })
})
