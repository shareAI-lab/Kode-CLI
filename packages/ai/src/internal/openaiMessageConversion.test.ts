import { describe, expect, test } from 'bun:test'
import { convertAnthropicMessagesToOpenAIMessages } from './openaiMessageConversion'

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object') return null
  return value as Record<string, unknown>
}

describe('openaiMessageConversion', () => {
  test('converts user image+text blocks and preserves active tool call/result ordering', () => {
    const messages: Parameters<
      typeof convertAnthropicMessagesToOpenAIMessages
    >[0] = [
      {
        message: {
          role: 'user',
          content: [
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: 'image/png',
                data: 'Zm9v', // "foo" base64
              },
            },
            { type: 'text', text: 'What is in this image?' },
          ],
        },
      },
      {
        message: {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'tool_1',
              name: 'Read',
              input: { path: 'README.md' },
            },
          ],
        },
      },
      {
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tool_1',
              content: 'file contents',
            },
          ],
        },
      },
    ]

    const converted = convertAnthropicMessagesToOpenAIMessages(messages)

    const user0 = asRecord(converted[0])
    expect(user0?.role).toBe('user')
    expect(Array.isArray(user0?.content)).toBe(true)
    const user0Content = user0?.content as unknown[]
    expect(user0Content[0]).toMatchObject({
      type: 'image_url',
      image_url: { url: 'data:image/png;base64,Zm9v' },
    })
    expect(user0Content[1]).toMatchObject({
      type: 'text',
      text: 'What is in this image?',
    })

    const assistant1 = asRecord(converted[1])
    expect(assistant1?.role).toBe('assistant')
    const toolCalls = assistant1?.tool_calls
    expect(Array.isArray(toolCalls)).toBe(true)
    expect((toolCalls as unknown[])[0]).toMatchObject({
      id: 'tool_1',
      type: 'function',
      function: { name: 'Read' },
    })

    const tool2 = asRecord(converted[2])
    expect(tool2?.role).toBe('tool')
    expect(tool2?.tool_call_id).toBe('tool_1')
    expect(tool2?.content).toBe('file contents')
  })

  test('preserves tool-result images as adjacent user vision messages', () => {
    const messages: any[] = [
      {
        message: {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'tool_1',
              name: 'Read',
              input: { path: 'screenshot.png' },
            },
          ],
        },
      },
      {
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tool_1',
              content: [
                { type: 'text', text: 'Read image' },
                {
                  type: 'image',
                  source: {
                    type: 'base64',
                    media_type: 'image/jpeg',
                    data: 'Zm9v',
                  },
                },
              ],
            },
          ],
        },
      },
    ]

    const converted = convertAnthropicMessagesToOpenAIMessages(messages)

    expect((converted[1] as any)?.role).toBe('tool')
    expect((converted[1] as any)?.content).toBe('Read image')
    expect((converted[2] as any)?.role).toBe('user')
    expect((converted[2] as any)?.content).toContainEqual({
      type: 'image_url',
      image_url: { url: 'data:image/jpeg;base64,Zm9v' },
    })
  })

  test('collapses historical tool results while keeping only the active result native', () => {
    const messages: any[] = [
      {
        message: {
          role: 'user',
          content: 'Inspect the repo',
        },
      },
      {
        message: {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'repeat_loop_initial',
              name: 'Bash',
              input: { command: 'printf initial' },
            },
          ],
        },
      },
      {
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'repeat_loop_initial',
              content: 'initial output',
            },
          ],
        },
      },
      {
        message: {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'repeat_loop_followup',
              name: 'Bash',
              input: { command: 'printf followup' },
            },
          ],
        },
      },
      {
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'repeat_loop_followup',
              content: 'followup output',
            },
          ],
        },
      },
    ]

    const converted = convertAnthropicMessagesToOpenAIMessages(messages)
    const toolMessages = converted.filter((message: any) => {
      return message.role === 'tool'
    }) as any[]

    expect(toolMessages).toHaveLength(1)
    expect(toolMessages[0]?.tool_call_id).toBe('repeat_loop_followup')

    const nativeToolCallIds = converted.flatMap((message: any) => {
      return Array.isArray(message.tool_calls)
        ? message.tool_calls.map((toolCall: any) => toolCall.id)
        : []
    })

    expect(nativeToolCallIds).toEqual(['repeat_loop_followup'])
    expect(JSON.stringify(converted)).toContain('initial output')
    expect(JSON.stringify(converted)).toContain('repeat_loop_initial')
  })

  test('emits at most one native tool result for a repeated active tool-call id', () => {
    const messages: any[] = [
      {
        message: {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'duplicate_id',
              name: 'Bash',
              input: { command: 'printf one' },
            },
            {
              type: 'tool_use',
              id: 'duplicate_id',
              name: 'Bash',
              input: { command: 'printf two' },
            },
          ],
        },
      },
      {
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'duplicate_id',
              content: 'ok',
            },
          ],
        },
      },
    ]

    const converted = convertAnthropicMessagesToOpenAIMessages(messages)
    const toolMessages = converted.filter((message: any) => {
      return message.role === 'tool'
    })
    const nativeToolCallIds = converted.flatMap((message: any) => {
      return Array.isArray(message.tool_calls)
        ? message.tool_calls.map((toolCall: any) => toolCall.id)
        : []
    })

    expect(toolMessages).toHaveLength(1)
    expect(nativeToolCallIds).toEqual(['duplicate_id'])
  })
})
