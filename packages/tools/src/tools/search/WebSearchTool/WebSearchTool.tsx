import { Box, Text } from 'ink'
import React from 'react'
import { z } from 'zod'
import { Tool, ToolUseContext } from '@kode/tool-interface/Tool'
import { getModelManager } from '#core/utils/model'
import { getAnthropicProviderRuntime } from '#core/utils/anthropicProviderRuntime'
import { getAnthropicClient } from '#core/ai/llm/anthropic/client'
import { createAssistantMessage } from '#core/utils/messages'
import {
  buildRequestStrategyFallbackPlan,
  classifyRequestFailure,
} from '#core/ai/llm/restrictedClientCompat'
import { PROMPT, TOOL_NAME_FOR_PROMPT } from './prompt'
import { searchWithFallback } from './searchProviders'

const inputSchema = z.object({
  query: z.string().describe('The search query to use'),
  allowed_domains: z
    .array(z.string())
    .optional()
    .describe('Only include search results from these domains'),
  blocked_domains: z
    .array(z.string())
    .optional()
    .describe('Never include search results from these domains'),
})

type Input = z.infer<typeof inputSchema>

type WebSearchHit = {
  title: string
  url: string
}

type WebSearchResultBlock = {
  tool_use_id: string
  content: WebSearchHit[]
}

type Output = {
  query: string
  results: Array<WebSearchResultBlock | string>
  durationSeconds: number
}

type AnthropicWebSearchToolConfig = {
  type: 'web_search_20250305'
  name: 'web_search'
  allowed_domains?: string[]
  blocked_domains?: string[]
  max_uses: number
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object') return null
  if (Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function parseAnthropicWebSearchContentBlocks(
  blocks: unknown[],
  query: string,
  durationSeconds: number,
): Output {
  // Compatibility note: this tool mirrors an upstream WebSearch behavior.
  const results: Output['results'] = []
  let textBuffer = ''
  let beforeFirstServerToolUse = true

  for (const raw of blocks) {
    const block = asRecord(raw)
    const type = typeof block?.type === 'string' ? block.type : ''

    if (type === 'server_tool_use') {
      if (beforeFirstServerToolUse) {
        beforeFirstServerToolUse = false
        if (textBuffer.trim().length > 0) results.push(textBuffer.trim())
        textBuffer = ''
      }
      continue
    }

    if (type === 'web_search_tool_result') {
      const toolUseId =
        typeof block?.tool_use_id === 'string'
          ? block.tool_use_id
          : 'web_search'

      const content = block?.content
      if (!Array.isArray(content)) {
        const errorCode =
          asRecord(content)?.error_code !== undefined
            ? String(asRecord(content)?.error_code)
            : 'unknown_error'
        results.push(`Web search error: ${errorCode}`)
        continue
      }

      const hits: WebSearchHit[] = content
        .map(item => {
          const r = asRecord(item)
          const title = typeof r?.title === 'string' ? r.title : null
          const url = typeof r?.url === 'string' ? r.url : null
          return title && url ? { title, url } : null
        })
        .filter((hit): hit is WebSearchHit => hit !== null)

      results.push({ tool_use_id: toolUseId, content: hits })
      continue
    }

    if (type === 'text') {
      const text = typeof block?.text === 'string' ? block.text : ''
      if (beforeFirstServerToolUse) {
        textBuffer += text
      } else {
        beforeFirstServerToolUse = true
        textBuffer = text
      }
    }
  }

  if (textBuffer.length) results.push(textBuffer.trim())

  return { query, results, durationSeconds }
}

type WebSearchProgressEvent =
  | { type: 'query_update'; query: string }
  | {
      type: 'search_results_received'
      query: string
      resultCount: number
      providers: string[]
    }

function hostnameMatchesDomain(hostname: string, domain: string): boolean {
  const normalizedHost = hostname.trim().toLowerCase()
  const normalizedDomain = domain.trim().toLowerCase()
  if (!normalizedHost || !normalizedDomain) return false
  if (normalizedHost === normalizedDomain) return true
  return normalizedHost.endsWith(`.${normalizedDomain}`)
}

function shouldIncludeResult(options: {
  url: string
  allowed_domains?: string[]
  blocked_domains?: string[]
}): boolean {
  let hostname = ''
  try {
    hostname = new URL(options.url).hostname
  } catch {
    return false
  }

  if (options.allowed_domains?.length) {
    const allowed = options.allowed_domains.some(domain =>
      hostnameMatchesDomain(hostname, domain),
    )
    if (!allowed) return false
  }

  if (options.blocked_domains?.length) {
    const blocked = options.blocked_domains.some(domain =>
      hostnameMatchesDomain(hostname, domain),
    )
    if (blocked) return false
  }

  return true
}

async function* streamDuckDuckGoWebSearch(args: {
  query: string
  allowed_domains?: string[]
  blocked_domains?: string[]
}): AsyncGenerator<
  | { type: 'progress'; event: WebSearchProgressEvent }
  | {
      type: 'output'
      output: Output
    }
> {
  const startedAt = Date.now()
  yield { type: 'progress', event: { type: 'query_update', query: args.query } }

  const { results, providers } = await searchWithFallback(args.query)
  const hits: WebSearchHit[] = results
    .filter(result =>
      shouldIncludeResult({
        url: result.link,
        allowed_domains: args.allowed_domains,
        blocked_domains: args.blocked_domains,
      }),
    )
    .map(result => ({ title: result.title, url: result.link }))

  yield {
    type: 'progress',
    event: {
      type: 'search_results_received',
      query: args.query,
      resultCount: hits.length,
      providers,
    },
  }

  const durationSeconds = (Date.now() - startedAt) / 1000
  yield {
    type: 'output',
    output: {
      query: args.query,
      results: [{ tool_use_id: 'duckduckgo', content: hits }],
      durationSeconds,
    },
  }
}

function canUseAnthropicServerToolWebSearch(modelName: string): boolean {
  const runtime = getAnthropicProviderRuntime()
  const isClaude = modelName.toLowerCase().includes('claude')
  if (!isClaude) return false
  if (runtime === 'firstParty' || runtime === 'foundry') return true
  return runtime === 'vertex'
}

async function* streamAnthropicServerToolWebSearch(args: {
  query: string
  allowed_domains?: string[]
  blocked_domains?: string[]
  context: ToolUseContext
}): AsyncGenerator<
  | { type: 'progress'; event: WebSearchProgressEvent }
  | {
      type: 'output'
      output: Output
    }
> {
  const modelManager = getModelManager()
  const modelProfile = modelManager.getModel('main')
  if (!modelProfile) {
    throw new Error('No configured model profile for WebSearch')
  }

  const provider = modelProfile.provider || 'anthropic'
  if (provider !== 'anthropic') {
    throw new Error(
      `WebSearch server tool is not supported for provider: ${provider}`,
    )
  }

  if (!modelProfile.apiKey) {
    throw new Error('Missing API key for Anthropic WebSearch')
  }

  const toolSchema: AnthropicWebSearchToolConfig = {
    type: 'web_search_20250305',
    name: 'web_search',
    ...(args.allowed_domains ? { allowed_domains: args.allowed_domains } : {}),
    ...(args.blocked_domains ? { blocked_domains: args.blocked_domains } : {}),
    max_uses: 8,
  }

  const payload = {
    model: modelProfile.modelName,
    system: 'You are an assistant for performing a web search tool use',
    messages: [
      {
        role: 'user',
        content: `Perform a web search for the query: ${args.query}`,
      },
    ],
    tools: [toolSchema],
    max_tokens: Math.max(modelProfile.maxTokens ?? 1024, 256),
    temperature: 0,
  }

  const timeoutMs = 45_000
  const fallbackPlan = buildRequestStrategyFallbackPlan(
    modelProfile.requestStrategy,
    modelProfile.modelName,
  )

  let lastError: unknown = null

  for (const step of fallbackPlan) {
    const startedAt = Date.now()
    const combinedAbort = new AbortController()
    const abort = () => combinedAbort.abort()
    const timer = setTimeout(() => combinedAbort.abort(), timeoutMs)

    args.context.abortController.signal.addEventListener('abort', abort, {
      once: true,
    })

    try {
      const anthropic = getAnthropicClient(modelProfile.modelName, {
        requestHeadersProfile: step.headers,
      })

      const stream = await anthropic.beta.messages.create(
        { ...(payload as any), stream: true } as any,
        {
          signal: combinedAbort.signal,
        },
      )

      const contentBlocks: any[] = []
      const inputJSONBuffers = new Map<number, string>()
      const lastQueryByToolUseId = new Map<string, string>()

      for await (const event of stream as any) {
        if (combinedAbort.signal.aborted) {
          throw new Error('Request was cancelled')
        }

        if (event?.type === 'content_block_start') {
          contentBlocks[event.index] = { ...event.content_block }

          const block = asRecord(event.content_block)
          const blockType = typeof block?.type === 'string' ? block.type : ''

          if (blockType === 'server_tool_use') {
            inputJSONBuffers.set(event.index, '')
          }

          if (blockType === 'web_search_tool_result') {
            const toolUseId =
              typeof block?.tool_use_id === 'string' ? block.tool_use_id : ''
            const queryForResult =
              (toolUseId && lastQueryByToolUseId.get(toolUseId)) || args.query
            const resultCount = Array.isArray(block?.content)
              ? block.content.length
              : 0
            yield {
              type: 'progress',
              event: {
                type: 'search_results_received',
                query: queryForResult,
                resultCount,
                providers: ['anthropic'],
              },
            }
          }
        }

        if (event?.type === 'content_block_delta') {
          const idx = event.index
          const block = contentBlocks[idx] ?? null
          const blockType =
            block && typeof block.type === 'string' ? block.type : ''

          if (event.delta?.type === 'text_delta') {
            if (blockType !== 'text') {
              contentBlocks[idx] = { type: 'text', text: '' }
            }
            contentBlocks[idx].text += String(event.delta.text ?? '')
          }

          if (event.delta?.type === 'input_json_delta') {
            const current = inputJSONBuffers.get(idx) ?? ''
            const next = current + String(event.delta.partial_json ?? '')
            inputJSONBuffers.set(idx, next)

            if (blockType === 'server_tool_use') {
              const toolUseId =
                typeof block?.id === 'string' ? (block.id as string) : null
              const match = next.match(/"query"\s*:\s*"((?:[^"\\]|\\.)*)"/)
              if (toolUseId && match && match[1]) {
                try {
                  const decoded = JSON.parse(`"${match[1]}"`) as string
                  const previous = lastQueryByToolUseId.get(toolUseId)
                  if (decoded && decoded !== previous) {
                    lastQueryByToolUseId.set(toolUseId, decoded)
                    yield {
                      type: 'progress',
                      event: { type: 'query_update', query: decoded },
                    }
                  }
                } catch {
                  // Ignore partial JSON decoding failures (compatibility behavior).
                }
              }
            }
          }
        }

        if (event?.type === 'content_block_stop') {
          inputJSONBuffers.delete(event.index)
        }

        if (event?.type === 'message_stop') {
          break
        }
      }

      const blocks = contentBlocks.filter(Boolean)
      const durationSeconds = (Date.now() - startedAt) / 1000
      const output = parseAnthropicWebSearchContentBlocks(
        blocks,
        args.query,
        durationSeconds,
      )

      yield { type: 'output', output }
      return
    } catch (error) {
      lastError = error
      if (classifyRequestFailure(error).kind === 'restricted_client_only') {
        continue
      }
      throw error
    } finally {
      clearTimeout(timer)
      args.context.abortController.signal.removeEventListener('abort', abort)
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error(lastError ? String(lastError) : 'WebSearch failed')
}

function summarizeResults(results: Output['results']): {
  searchCount: number
  totalResultCount: number
} {
  let searchCount = 0
  let totalResultCount = 0
  for (const item of results) {
    if (typeof item === 'string') continue
    searchCount += 1
    totalResultCount += item.content.length
  }
  return { searchCount, totalResultCount }
}

type WebSearchToolCallEvent =
  | {
      type: 'progress'
      content: ReturnType<typeof createAssistantMessage>
    }
  | {
      type: 'result'
      data: Output
      resultForAssistant: string
    }

export const WebSearchTool = {
  name: TOOL_NAME_FOR_PROMPT,
  async description(input?: Input) {
    const query = input?.query ?? ''
    return `The assistant wants to search the web for: ${query}`
  },
  userFacingName: () => 'Web Search',
  inputSchema,
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  async isEnabled() {
    return true
  },
  needsPermissions() {
    return true
  },
  async prompt() {
    return PROMPT
  },
  renderToolUseMessage(
    { query, allowed_domains, blocked_domains }: Input,
    { verbose }: { verbose: boolean },
  ) {
    let summary = `"${query}"`
    if (verbose) {
      if (allowed_domains && allowed_domains.length > 0) {
        summary += `, only allowing domains: ${allowed_domains.join(', ')}`
      }
      if (blocked_domains && blocked_domains.length > 0) {
        summary += `, blocking domains: ${blocked_domains.join(', ')}`
      }
    }
    return summary
  },
  renderToolResultMessage(output: Output) {
    const { searchCount } = summarizeResults(output.results)
    const duration =
      output.durationSeconds >= 1
        ? `${Math.round(output.durationSeconds)}s`
        : `${Math.round(output.durationSeconds * 1000)}ms`
    return (
      <Box flexDirection="row">
        <Text>&nbsp;&nbsp;⎿ &nbsp;Did </Text>
        <Text bold>{searchCount} </Text>
        <Text>
          search{searchCount === 1 ? '' : 'es'} in {duration}
        </Text>
      </Box>
    )
  },
  renderResultForAssistant(output: Output) {
    let result = `Web search results for query: "${output.query}"\n\n`
    for (const item of output.results) {
      if (typeof item === 'string') {
        result += `${item}\n\n`
        continue
      }
      if (item.content.length > 0) {
        result += `Links: ${JSON.stringify(item.content)}\n\n`
      } else {
        result += `No links found.\n\n`
      }
    }
    result +=
      '\nREMINDER: You MUST include the sources above in your response to the user using markdown hyperlinks.'
    return result.trim()
  },
  async validateInput(input: Input) {
    if (!input.query || !input.query.length) {
      return {
        result: false,
        message: 'Error: Missing query',
        errorCode: 1,
      }
    }

    if (input.allowed_domains?.length && input.blocked_domains?.length) {
      return {
        result: false,
        message:
          'Error: Cannot specify both allowed_domains and blocked_domains in the same request',
        errorCode: 2,
      }
    }
    return { result: true }
  },
  async *call(
    { query, allowed_domains, blocked_domains }: Input,
    context: ToolUseContext,
  ): AsyncGenerator<WebSearchToolCallEvent, void, unknown> {
    const modelProfile = getModelManager().getModel('main')
    const provider = modelProfile?.provider || 'anthropic'
    const modelName = modelProfile?.modelName ?? ''

    const shouldUseAnthropicServerTool =
      Boolean(modelProfile) &&
      provider === 'anthropic' &&
      canUseAnthropicServerToolWebSearch(modelName)

    async function* emitToolEvents(
      tool:
        | ReturnType<typeof streamAnthropicServerToolWebSearch>
        | ReturnType<typeof streamDuckDuckGoWebSearch>,
    ): AsyncGenerator<WebSearchToolCallEvent, void, unknown> {
      for await (const item of tool) {
        if (item.type === 'progress') {
          const message =
            item.event.type === 'query_update'
              ? `Searching: ${item.event.query}`
              : item.event.resultCount > 0
                ? `Found ${item.event.resultCount} results for "${item.event.query}" (${item.event.providers.join(', ')})`
                : `Found 0 results for "${item.event.query}"`
          yield {
            type: 'progress' as const,
            content: createAssistantMessage(
              `<tool-progress>${message}</tool-progress>`,
            ),
          }
          continue
        }

        const output = item.output
        yield {
          type: 'result' as const,
          resultForAssistant: WebSearchTool.renderResultForAssistant(output),
          data: output,
        }
        return
      }
    }

    if (shouldUseAnthropicServerTool) {
      try {
        yield* emitToolEvents(
          streamAnthropicServerToolWebSearch({
            query,
            allowed_domains,
            blocked_domains,
            context,
          }),
        )
        return
      } catch (error) {
        if (context.abortController.signal.aborted) throw error
        yield {
          type: 'progress' as const,
          content: createAssistantMessage(
            `<tool-progress>WebSearch server tool unavailable; falling back…</tool-progress>`,
          ),
        }
      }
    }

    yield* emitToolEvents(
      streamDuckDuckGoWebSearch({ query, allowed_domains, blocked_domains }),
    )
  },
} satisfies Tool<typeof inputSchema, Output>
