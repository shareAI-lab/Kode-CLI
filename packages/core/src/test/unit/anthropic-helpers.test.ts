import { describe, expect, test } from 'bun:test'
import {
  createAnthropicUsage,
  extractTextFromContent,
  isToolUseLikeBlockParam,
  normalizeAnthropicUsage,
  normalizeImageMediaType,
} from '#core/utils/anthropic'

describe('Anthropic SDK compatibility helpers', () => {
  test('createAnthropicUsage returns a complete zero usage shape', () => {
    expect(createAnthropicUsage()).toMatchObject({
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      input_tokens: 0,
      output_tokens: 0,
    })
  })

  test('normalizeAnthropicUsage accepts SDK and legacy token aliases', () => {
    expect(
      normalizeAnthropicUsage({
        prompt_tokens: 12,
        completion_tokens: 7,
        prompt_token_details: { cached_tokens: 3 },
        cacheCreatedInputTokens: 2,
      }),
    ).toMatchObject({
      input_tokens: 9,
      output_tokens: 7,
      cache_read_input_tokens: 3,
      cache_creation_input_tokens: 2,
    })
  })

  test('normalizes DeepSeek cache misses as non-cached input', () => {
    expect(
      normalizeAnthropicUsage({
        prompt_cache_hit_tokens: 900,
        prompt_cache_miss_tokens: 100,
        completion_tokens: 20,
      }),
    ).toMatchObject({
      input_tokens: 100,
      output_tokens: 20,
      cache_read_input_tokens: 900,
      cache_creation_input_tokens: 0,
    })
  })

  test('extractTextFromContent handles strings, text blocks, and missing text', () => {
    expect(extractTextFromContent('plain text')).toBe('plain text')
    expect(
      extractTextFromContent([
        { type: 'image', source: { type: 'base64', data: 'x' } },
        { type: 'text', text: 'block text' },
      ]),
    ).toBe('block text')
    expect(extractTextFromContent([{ type: 'image' }])).toBeNull()
  })

  test('recognizes tool-use-like Anthropic content block params', () => {
    expect(isToolUseLikeBlockParam({ type: 'tool_use' })).toBe(true)
    expect(isToolUseLikeBlockParam({ type: 'server_tool_use' })).toBe(true)
    expect(isToolUseLikeBlockParam({ type: 'mcp_tool_use' })).toBe(true)
    expect(isToolUseLikeBlockParam({ type: 'text', text: 'nope' })).toBe(false)
  })

  test('normalizeImageMediaType keeps supported types and falls back to png', () => {
    expect(normalizeImageMediaType('image/jpeg')).toBe('image/jpeg')
    expect(normalizeImageMediaType('image/webp')).toBe('image/webp')
    expect(normalizeImageMediaType(undefined)).toBe('image/png')
    expect(normalizeImageMediaType('application/octet-stream')).toBe(
      'image/png',
    )
  })
})
