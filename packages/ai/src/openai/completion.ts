import { OpenAI } from 'openai'
import type { ProxyAgent } from 'undici'
import { ProxyAgent as ProxyAgentCtor, fetch } from 'undici'
import type { Response } from 'undici'

import { getGlobalConfig } from '#core/utils/config'
import {
  buildCompatHeaders,
  type RequestHeadersProfile,
} from '#core/ai/llm/restrictedClientCompat'
import { debug as debugLogger, logAPIError } from '../internal/debug'
import { providers } from '../internal/providers'

import { tryWithEndpointFallback } from './endpointFallback'
import { maybeFixModelError, applyModelErrorFixes } from './modelErrors'
import { applyModelSpecificTransformations } from './modelFeatures'
import { abortableDelay, getRetryDelay } from './retry'
import { createStreamProcessor } from './stream'

type OpenAICompatibleProvider =
  | 'minimax'
  | 'kimi'
  | 'deepseek'
  | 'siliconflow'
  | 'qwen'
  | 'glm'
  | 'glm-coding'
  | 'baidu-qianfan'
  | 'openai'
  | 'mistral'
  | 'xai'
  | 'groq'
  | 'custom-openai'

const STREAM_OPENAI_COMPATIBLE: readonly OpenAICompatibleProvider[] = [
  'minimax',
  'kimi',
  'deepseek',
  'siliconflow',
  'qwen',
  'glm',
  'glm-coding',
  'baidu-qianfan',
  'openai',
  'mistral',
  'xai',
  'groq',
  'custom-openai',
]

const NON_STREAM_OPENAI_COMPATIBLE: readonly Exclude<
  OpenAICompatibleProvider,
  'glm-coding'
>[] = [
  'minimax',
  'kimi',
  'deepseek',
  'siliconflow',
  'qwen',
  'glm',
  'baidu-qianfan',
  'openai',
  'mistral',
  'xai',
  'groq',
  'custom-openai',
]

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error('Request cancelled by user')
}

function normalizeToolMessages(opts: OpenAI.ChatCompletionCreateParams): void {
  opts.messages = opts.messages.map(msg => {
    if (msg.role !== 'tool') return msg

    if (Array.isArray(msg.content)) {
      return {
        ...msg,
        content:
          msg.content
            .map(c => c.text || '')
            .filter(Boolean)
            .join('\\n\\n') || '(empty content)',
      }
    }

    if (typeof msg.content !== 'string') {
      return {
        ...msg,
        content:
          typeof msg.content === 'undefined'
            ? '(empty content)'
            : JSON.stringify(msg.content),
      }
    }

    return msg
  })
}

function parseErrorMessage(errorData: unknown, status: number): string {
  if (typeof errorData === 'object' && errorData !== null) {
    const record = errorData as Record<string, unknown>
    const errorObj =
      typeof record.error === 'object' && record.error !== null
        ? (record.error as Record<string, unknown>)
        : null
    const nested = errorObj?.message
    if (typeof nested === 'string' && nested.trim()) return nested
    const direct = record.message
    if (typeof direct === 'string' && direct.trim()) return direct
  }
  return `HTTP ${status}`
}

function endpointForProvider(provider: string): string {
  const azureApiVersion = '2024-06-01'
  if (provider === 'azure') {
    return `/chat/completions?api-version=${azureApiVersion}`
  }
  if (provider === 'minimax') {
    return '/text/chatcompletion_v2'
  }
  return '/chat/completions'
}

function createProxy(): ProxyAgent | undefined {
  return getGlobalConfig().proxy
    ? new ProxyAgentCtor(getGlobalConfig().proxy)
    : undefined
}

function createHeaders(
  provider: string,
  apiKey: string | undefined,
  requestHeadersProfile?: RequestHeadersProfile,
): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(requestHeadersProfile === 'compat' ? buildCompatHeaders() : {}),
  }

  if (apiKey) {
    if (provider === 'azure') {
      headers['api-key'] = apiKey
    } else {
      headers.Authorization = `Bearer ${apiKey}`
    }
  }

  return headers
}

async function fetchCompletionResponse(args: {
  baseURL: string
  endpoint: string
  provider: string
  proxy: ProxyAgent | undefined
  headers: Record<string, string>
  opts: OpenAI.ChatCompletionCreateParams
  stream: boolean
  signal?: AbortSignal
}): Promise<{ response: Response; endpoint: string }> {
  const isOpenAICompatible = args.stream
    ? STREAM_OPENAI_COMPATIBLE.includes(
        args.provider as OpenAICompatibleProvider,
      )
    : NON_STREAM_OPENAI_COMPATIBLE.includes(
        args.provider as Exclude<OpenAICompatibleProvider, 'glm-coding'>,
      )

  if (isOpenAICompatible && args.provider !== 'azure') {
    return await tryWithEndpointFallback(
      args.baseURL,
      args.opts,
      args.headers,
      args.provider,
      args.proxy,
      args.signal,
    )
  }

  const response = await fetch(`${args.baseURL}${args.endpoint}`, {
    method: 'POST',
    headers: args.headers,
    body: JSON.stringify(
      args.stream ? { ...args.opts, stream: true } : args.opts,
    ),
    dispatcher: args.proxy,
    signal: args.signal,
  })
  return { response, endpoint: args.endpoint }
}

export async function getCompletionWithProfile(
  modelProfile: unknown,
  opts: OpenAI.ChatCompletionCreateParams,
  attempt: number = 0,
  maxAttempts: number = 10,
  signal?: AbortSignal,
  requestHeadersProfile?: RequestHeadersProfile,
): Promise<OpenAI.ChatCompletion | AsyncIterable<OpenAI.ChatCompletionChunk>> {
  const profile = modelProfile as {
    provider?: string
    baseURL?: string
    apiKey?: string
    modelName?: string
    name?: string
  } | null

  const provider = profile?.provider || 'anthropic'
  const providerConfig = providers[provider as keyof typeof providers]
  const baseURL = profile?.baseURL || providerConfig?.baseURL || ''
  const apiKey = profile?.apiKey
  const proxy = createProxy()
  const headers = createHeaders(provider, apiKey, requestHeadersProfile)

  for (
    let currentAttempt = attempt;
    currentAttempt < maxAttempts;
    currentAttempt++
  ) {
    throwIfAborted(signal)

    applyModelSpecificTransformations(opts)
    await applyModelErrorFixes(opts, baseURL || '')
    normalizeToolMessages(opts)

    debugLogger.api('OPENAI_API_CALL_START', {
      endpoint: baseURL || 'DEFAULT_OPENAI',
      model: opts.model,
      provider,
      apiKeyConfigured: !!apiKey,
      apiKeyPrefix: apiKey ? apiKey.substring(0, 8) : null,
      maxTokens: opts.max_tokens,
      temperature: opts.temperature,
      messageCount: opts.messages?.length || 0,
      streamMode: opts.stream,
      timestamp: new Date().toISOString(),
      modelProfileModelName: profile?.modelName,
      modelProfileName: profile?.name,
    })

    const endpoint = endpointForProvider(provider)

    try {
      const wantsStream = !!opts.stream
      const { response, endpoint: usedEndpoint } =
        await fetchCompletionResponse({
          baseURL,
          endpoint,
          provider,
          proxy,
          headers,
          opts,
          stream: wantsStream,
          signal,
        })

      if (!response.ok) {
        throwIfAborted(signal)

        try {
          const errorData = await response.json()
          const errorMessage = parseErrorMessage(errorData, response.status)

          const fixed = await maybeFixModelError({
            baseURL: baseURL || '',
            opts,
            errorMessage,
            status: response.status,
          })

          if (fixed) {
            continue
          }

          debugLogger.warn('OPENAI_API_ERROR_UNHANDLED', {
            model: opts.model,
            status: response.status,
            errorMessage,
          })

          if (wantsStream) {
            logAPIError({
              model: opts.model,
              endpoint: `${baseURL}${usedEndpoint}`,
              status: response.status,
              error: errorMessage,
              request: opts,
              response: errorData,
              provider,
            })
          }
        } catch (parseError) {
          debugLogger.warn('OPENAI_API_ERROR_PARSE_FAILED', {
            model: opts.model,
            status: response.status,
            error:
              parseError instanceof Error
                ? parseError.message
                : String(parseError),
          })

          if (wantsStream) {
            logAPIError({
              model: opts.model,
              endpoint: `${baseURL}${usedEndpoint}`,
              status: response.status,
              error: `Could not parse error response: ${parseError instanceof Error ? parseError.message : String(parseError)}`,
              request: opts,
              response: {
                parseError:
                  parseError instanceof Error
                    ? parseError.message
                    : String(parseError),
              },
              provider,
            })
          }
        }

        debugLogger.warn('OPENAI_API_RETRY', {
          model: opts.model,
          status: response.status,
          attempt: currentAttempt + 1,
          maxAttempts,
          delayMs: getRetryDelay(currentAttempt),
        })

        await abortableDelay(getRetryDelay(currentAttempt), signal).catch(
          err => {
            if (err instanceof Error && err.message === 'Request was aborted') {
              throw new Error('Request cancelled by user')
            }
            throw err
          },
        )
        continue
      }

      if (wantsStream) {
        const body = response.body
        if (!body) throw new Error('Stream is null or undefined')
        return createStreamProcessor(body, signal)
      }

      return (await response.json()) as OpenAI.ChatCompletion
    } catch (error) {
      throwIfAborted(signal)

      if (currentAttempt + 1 >= maxAttempts) {
        throw error
      }

      debugLogger.warn('OPENAI_NETWORK_RETRY', {
        model: opts.model,
        attempt: currentAttempt + 1,
        maxAttempts,
        delayMs: getRetryDelay(currentAttempt),
        error: error instanceof Error ? error.message : String(error),
      })

      await abortableDelay(getRetryDelay(currentAttempt), signal).catch(err => {
        if (err instanceof Error && err.message === 'Request was aborted') {
          throw new Error('Request cancelled by user')
        }
        throw err
      })
    }
  }

  throw new Error('Max attempts reached')
}
