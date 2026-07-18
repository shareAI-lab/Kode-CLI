import { describe, expect, test } from 'bun:test'
import type OpenAI from 'openai'

import { convertOpenAIResponseToAnthropic } from '#core/ai/llm/openai/conversion'

function completionWithToolCalls(
  toolCalls: OpenAI.ChatCompletionMessageToolCall[],
): OpenAI.ChatCompletion {
  return {
    id: 'chatcmpl_test',
    object: 'chat.completion',
    created: 1,
    model: 'test-model',
    choices: [
      {
        index: 0,
        finish_reason: 'tool_calls',
        message: {
          role: 'assistant',
          content: null,
          tool_calls: toolCalls,
          refusal: null,
        },
        logprobs: null,
      },
    ],
  } as OpenAI.ChatCompletion
}

describe('OpenAI tool-call conversion safety', () => {
  test('accepts function tool calls even when type is omitted', () => {
    const message = convertOpenAIResponseToAnthropic(
      completionWithToolCalls([
        {
          id: 'call_1',
          type: undefined,
          function: {
            name: 'Bash',
            arguments: '{"command":"echo hi"}',
          },
        } as OpenAI.ChatCompletionMessageToolCall,
      ]),
    )
    expect(message.content).toEqual([
      {
        type: 'tool_use',
        id: 'call_1',
        name: 'Bash',
        input: { command: 'echo hi' },
      },
    ])
  })

  test('drops incomplete JSON tool arguments instead of executing empty objects', () => {
    const message = convertOpenAIResponseToAnthropic(
      completionWithToolCalls([
        {
          id: 'call_bad',
          type: 'function',
          function: {
            name: 'Bash',
            arguments: '{"command":"echo',
          },
        },
      ]),
    )
    expect(message.content.some(block => block.type === 'tool_use')).toBe(false)
  })

  test('drops non-object tool arguments', () => {
    const message = convertOpenAIResponseToAnthropic(
      completionWithToolCalls([
        {
          id: 'call_array',
          type: 'function',
          function: {
            name: 'Bash',
            arguments: '["not","object"]',
          },
        },
      ]),
    )
    expect(message.content.some(block => block.type === 'tool_use')).toBe(false)
  })
})
