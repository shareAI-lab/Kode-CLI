import type {
  Base64ImageSource,
  ContentBlock,
  ContentBlockParam,
  TextBlock,
  TextBlockParam,
  ToolUseBlockParam,
  Usage,
} from '@anthropic-ai/sdk/resources/index.mjs'

export type AnthropicImageMediaType = Base64ImageSource['media_type']

export type AnthropicUsage = Usage & {
  prompt_tokens?: number
  completion_tokens?: number
  promptTokens?: number
  completionTokens?: number
  totalTokens?: number
  reasoningTokens?: number
}

export type ToolUseLikeBlockParam = Omit<ToolUseBlockParam, 'type'> & {
  type: 'tool_use' | 'server_tool_use' | 'mcp_tool_use'
}

export function createAnthropicUsage(
  overrides: Partial<AnthropicUsage> = {},
): AnthropicUsage {
  return {
    cache_creation: null,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    inference_geo: null,
    input_tokens: 0,
    output_tokens: 0,
    output_tokens_details: null,
    server_tool_use: null,
    service_tier: null,
    ...overrides,
  }
}

export function normalizeAnthropicUsage(usage?: unknown): AnthropicUsage {
  if (!usage || typeof usage !== 'object') {
    return createAnthropicUsage()
  }

  const source = usage as Record<string, unknown>
  const deepseekCacheHitTokens = numberValue(
    source.prompt_cache_hit_tokens,
    source.promptCacheHitTokens,
  )
  const deepseekCacheMissTokens = numberValue(
    source.prompt_cache_miss_tokens,
    source.promptCacheMissTokens,
  )
  const hasDeepseekCacheUsage = hasNumberValue(
    source.prompt_cache_hit_tokens,
    source.promptCacheHitTokens,
    source.prompt_cache_miss_tokens,
    source.promptCacheMissTokens,
  )
  const outputTokens = numberValue(
    source.output_tokens,
    source.completion_tokens,
    source.outputTokens,
  )
  const cacheReadInputTokens = numberValue(
    source.cache_read_input_tokens,
    // DeepSeek disk cache
    hasDeepseekCacheUsage ? deepseekCacheHitTokens : undefined,
    objectValue(source.prompt_token_details)?.cached_tokens,
    objectValue(source.prompt_tokens_details)?.cached_tokens,
    source.cacheReadInputTokens,
  )
  const hasOpenAICacheUsage = hasNumberValue(
    objectValue(source.prompt_token_details)?.cached_tokens,
    objectValue(source.prompt_tokens_details)?.cached_tokens,
  )
  const cacheCreationInputTokens = numberValue(
    source.cache_creation_input_tokens,
    source.cacheCreatedInputTokens,
  )
  const promptTokens = numberValue(
    source.input_tokens,
    source.prompt_tokens,
    source.inputTokens,
    hasDeepseekCacheUsage
      ? deepseekCacheHitTokens + deepseekCacheMissTokens
      : undefined,
  )
  const inputTokens = hasDeepseekCacheUsage
    ? deepseekCacheMissTokens
    : hasOpenAICacheUsage
      ? Math.max(0, promptTokens - cacheReadInputTokens)
      : promptTokens

  return createAnthropicUsage({
    ...(source as Partial<AnthropicUsage>),
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    cache_read_input_tokens: cacheReadInputTokens,
    cache_creation_input_tokens: cacheCreationInputTokens,
  })
}

export function isTextBlock(
  block: unknown,
): block is TextBlock | TextBlockParam {
  return (
    !!block &&
    typeof block === 'object' &&
    (block as { type?: unknown }).type === 'text' &&
    typeof (block as { text?: unknown }).text === 'string'
  )
}

export function extractTextFromContent(content: unknown): string | null {
  if (typeof content === 'string') {
    return content
  }
  if (!Array.isArray(content)) {
    return null
  }
  const textBlock = content.find(isTextBlock)
  return textBlock?.text ?? null
}

export function isToolUseLikeBlockParam(
  block: unknown,
): block is ToolUseLikeBlockParam {
  return (
    !!block &&
    typeof block === 'object' &&
    ((block as { type?: unknown }).type === 'tool_use' ||
      (block as { type?: unknown }).type === 'server_tool_use' ||
      (block as { type?: unknown }).type === 'mcp_tool_use')
  )
}

export function normalizeImageMediaType(
  mimeType: unknown,
): AnthropicImageMediaType {
  switch (mimeType) {
    case 'image/jpeg':
    case 'image/png':
    case 'image/gif':
    case 'image/webp':
      return mimeType
    default:
      return 'image/png'
  }
}

export type AnthropicContentBlockLike =
  ContentBlock | ContentBlockParam | ToolUseLikeBlockParam

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : null
}

function numberValue(...values: unknown[]): number {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value
    }
  }
  return 0
}

function hasNumberValue(...values: unknown[]): boolean {
  return values.some(
    value => typeof value === 'number' && Number.isFinite(value),
  )
}
