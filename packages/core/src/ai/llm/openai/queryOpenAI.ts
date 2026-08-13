import OpenAI from 'openai'
import { randomUUID } from 'crypto'
import type { UUID } from 'crypto'
import { zodToJsonSchema } from 'zod-to-json-schema'
import type { TextBlockParam } from '@anthropic-ai/sdk/resources/index.mjs'
import type { Tool, ToolUseContext } from '@kode/tool-interface/Tool'
import type { AssistantMessage, UserMessage } from '#core/query'
import type { ModelProfile } from '#core/utils/config'
import {
  getGlobalConfig,
  MODEL_COSTS,
  resolveModelCostTier,
} from '#core/utils/config'
import { getModelManager } from '#core/utils/model'
import {
  debug as debugLogger,
  getCurrentRequest,
  logLLMInteraction,
  logSystemPromptConstruction,
} from '#core/utils/debugLogger'
import { logError } from '#core/utils/log'
import { addToTotalCost } from '#core/cost-tracker'
import { normalizeContentFromAPI } from '#core/utils/messages'
import { getCLISyspromptPrefix } from '#core/constants/prompts'
import { getReasoningEffort } from '#core/utils/thinking'
import { generateKodeContext } from '#core/ai/llm/kodeContext'
import { MAIN_QUERY_TEMPERATURE } from '#core/ai/llm/constants'
import {
  PROMPT_CACHING_ENABLED,
  splitSysPromptPrefix,
} from '#core/ai/llm/systemPromptUtils'
import { withRetry } from '#core/ai/llm/retry'
import { getAssistantMessageFromError } from '#core/ai/llm/errors'
import { ModelAdapterFactory } from '#core/ai/modelAdapterFactory'
import {
  getCompletionWithProfile,
  getGPT5CompletionWithProfile,
} from '#core/ai/openai'
import type { UnifiedRequestParams } from '#core/types/modelCapabilities'
import type { RequestHeadersProfile } from '#core/ai/llm/restrictedClientCompat'
import type { AssistantStreamUpdateOptions } from '@kode/tool-interface/assistantStreamUpdate'

import {
  convertAnthropicMessagesToOpenAIMessages,
  convertOpenAIResponseToAnthropic,
} from './conversion'
import {
  buildOpenAIChatCompletionCreateParams,
  isGPT5Model,
  resolveOpenAIStreamDecision,
} from './params'
import { handleMessageStream, isOpenAIStreamDegradedResponse } from './stream'
import { buildAssistantMessageFromUnifiedResponse } from './unifiedResponse'
import {
  estimateCostUSD,
  getMaxTokensFromProfile,
  normalizeUsage,
} from './usage'

export { buildOpenAIChatCompletionCreateParams, isGPT5Model } from './params'

function containsCommittedToolResult(
  messages: OpenAI.ChatCompletionMessageParam[],
): boolean {
  return messages.some(message => message.role === 'tool')
}

function isOpenAIChunkStream(
  response: OpenAI.ChatCompletion | AsyncIterable<OpenAI.ChatCompletionChunk>,
): response is AsyncIterable<OpenAI.ChatCompletionChunk> {
  return (
    response !== null &&
    typeof response === 'object' &&
    typeof Reflect.get(response, Symbol.asyncIterator) === 'function'
  )
}

function createAssistantMessageFromOpenAIResponse(args: {
  response: OpenAI.ChatCompletion
  tools: Tool[]
  start: number
}): AssistantMessage {
  const message = convertOpenAIResponseToAnthropic(args.response, args.tools)
  const finishReason = args.response.choices?.[0]?.finish_reason
  const hasUnusableToolCall =
    (finishReason === 'tool_calls' || finishReason === 'function_call') &&
    !message.content.some(block => block.type === 'tool_use')
  const assistantMsg: AssistantMessage = {
    type: 'assistant',
    message,
    costUSD: 0,
    durationMs: Date.now() - args.start,
    uuid: randomUUID() as UUID,
  }
  if (isOpenAIStreamDegradedResponse(args.response) || hasUnusableToolCall) {
    assistantMsg.isApiErrorMessage = true
  }
  return assistantMsg
}

export async function queryOpenAI(
  messages: (UserMessage | AssistantMessage)[],
  systemPrompt: string[],
  maxThinkingTokens: number,
  tools: Tool[],
  signal: AbortSignal,
  options?: {
    safeMode: boolean
    model: string
    prependCLISysprompt: boolean
    temperature?: number
    maxTokens?: number
    stopSequences?: string[]
    modelProfile?: ModelProfile | null
    toolUseContext?: ToolUseContext
    requestHeadersProfile?: RequestHeadersProfile
    cliSyspromptPrefix?: string
  },
): Promise<AssistantMessage> {
  const config = getGlobalConfig()
  const toolUseContext = options?.toolUseContext
  const thinkingMode = toolUseContext?.options?.thinkingMode
  const shouldRequestReasoningSummary = thinkingMode !== 'disabled'

  const modelProfile =
    options?.modelProfile ?? getModelManager().getModel('main')
  let model: string

  // 🔍 Debug: 记录模型配置详情
  const currentRequest = getCurrentRequest()
  const onAssistantStreamUpdate =
    toolUseContext?.options?.onAssistantStreamUpdate
  const assistantStreamUpdateOptions = {
    onAssistantStreamUpdate: onAssistantStreamUpdate
      ? event => {
          // A disabled session must not reintroduce provider thinking through a
          // legacy OpenAI-compatible stream. The completed transcript is
          // filtered below for the same reason.
          if (thinkingMode === 'disabled' && event.type === 'thinking_delta') {
            return
          }
          onAssistantStreamUpdate(event)
        }
      : undefined,
    agentId: toolUseContext?.agentId,
    requestId: toolUseContext?.requestId ?? currentRequest?.id ?? randomUUID(),
  } satisfies AssistantStreamUpdateOptions
  debugLogger.api('MODEL_CONFIG_OPENAI', {
    modelProfileFound: !!modelProfile,
    modelProfileId: modelProfile?.modelName,
    modelProfileName: modelProfile?.name,
    modelProfileModelName: modelProfile?.modelName,
    modelProfileProvider: modelProfile?.provider,
    modelProfileBaseURL: modelProfile?.baseURL,
    modelProfileApiKeyExists: !!modelProfile?.apiKey,
    optionsModel: options?.model,
    requestId: getCurrentRequest()?.id,
  })

  if (modelProfile) {
    model = modelProfile.modelName
  } else {
    model = options?.model || ''
  }
  // Prepend system prompt block for easy API identification
  if (options?.prependCLISysprompt) {
    const prefix = options.cliSyspromptPrefix ?? getCLISyspromptPrefix()
    // Some OpenAI-like providers need the entire system prompt as a single block.
    systemPrompt = [[prefix, ...systemPrompt].join('\n')]
  }

  const system: TextBlockParam[] = splitSysPromptPrefix(systemPrompt).map(
    _ => ({
      ...(PROMPT_CACHING_ENABLED
        ? { cache_control: { type: 'ephemeral' } }
        : {}),
      text: _,
      type: 'text',
    }),
  )

  const toolSchemas = await Promise.all(
    tools.map(
      async _ =>
        ({
          type: 'function',
          function: {
            name: _.name,
            description: await _.prompt({
              safeMode: options?.safeMode,
              tools,
            }),
            // Use tool's JSON schema directly if provided, otherwise convert Zod schema
            parameters:
              'inputJSONSchema' in _ && _.inputJSONSchema
                ? _.inputJSONSchema
                : (zodToJsonSchema(_.inputSchema) as Record<string, unknown>),
          },
        }) as OpenAI.ChatCompletionTool,
    ),
  )

  const configuredStream = config.stream ?? true
  const streamDecision = resolveOpenAIStreamDecision({
    configuredStream,
    model,
    toolNames: tools.map(tool => tool.name),
  })
  debugLogger.api('OPENAI_STREAM_POLICY', {
    model,
    toolCount: String(toolSchemas.length),
    configuredStream: String(configuredStream),
    effectiveStream: String(streamDecision.stream),
    reason: streamDecision.reason,
    requestId: getCurrentRequest()?.id,
  })

  const openaiSystem = system.map(
    s =>
      ({
        role: 'system',
        content: s.text,
      }) as OpenAI.ChatCompletionMessageParam,
  )

  const openaiMessages = convertAnthropicMessagesToOpenAIMessages(messages)
  const hasCommittedToolResult = containsCommittedToolResult(openaiMessages)
  const providerMaxAttempts = hasCommittedToolResult ? 1 : 10

  // 记录系统提示构建过程 (OpenAI path)
  logSystemPromptConstruction({
    basePrompt: systemPrompt.join('\n'),
    kodeContext: generateKodeContext() || '',
    reminders: [], // 这里可以从 generateSystemReminders 获取
    finalPrompt: systemPrompt.join('\n'),
  })

  let start = Date.now()

  type AdapterExecutionContext = {
    adapter: ReturnType<typeof ModelAdapterFactory.createAdapter>
    request: any
  }

  type QueryResult = {
    assistantMessage: AssistantMessage
    rawResponse?: any
    apiFormat: 'openai'
  }

  let adapterContext: AdapterExecutionContext | null = null

  if (modelProfile && modelProfile.modelName) {
    debugLogger.api('CHECKING_ADAPTER_SYSTEM', {
      modelProfileName: modelProfile.modelName,
      modelName: modelProfile.modelName,
      provider: modelProfile.provider,
      requestId: getCurrentRequest()?.id,
    })

    const USE_NEW_ADAPTER_SYSTEM = process.env.USE_NEW_ADAPTERS !== 'false'

    if (USE_NEW_ADAPTER_SYSTEM) {
      const shouldUseResponses =
        ModelAdapterFactory.shouldUseResponsesAPI(modelProfile)

      // Only use new adapters for Responses API models
      // Chat Completions models use legacy path for stability
      if (shouldUseResponses) {
        const adapter = ModelAdapterFactory.createAdapter(modelProfile)
        const reasoningEffort = shouldRequestReasoningSummary
          ? await getReasoningEffort(modelProfile, messages, {
              thinkingTokens: maxThinkingTokens,
            })
          : null

        // Determine verbosity based on model name
        // Most GPT-5 codex models only support 'medium', so default to that unless we detect 'high' in the name
        let verbosity: 'low' | 'medium' | 'high' = 'medium'
        const modelNameLower = modelProfile.modelName.toLowerCase()
        if (modelNameLower.includes('high')) {
          verbosity = 'high'
        } else if (modelNameLower.includes('low')) {
          verbosity = 'low'
        }
        // Default to 'medium' for all other cases, including mini, codex, etc.

        const unifiedParams: UnifiedRequestParams = {
          messages: openaiMessages,
          systemPrompt: openaiSystem.map(s => s.content as string),
          tools,
          maxTokens:
            options?.maxTokens ?? getMaxTokensFromProfile(modelProfile),
          stream: streamDecision.stream,
          reasoningEffort: reasoningEffort ?? undefined,
          reasoning: {
            enable: shouldRequestReasoningSummary,
            effort: reasoningEffort ?? 'medium',
            summary: 'auto',
          },
          temperature:
            options?.temperature ??
            (isGPT5Model(model) ? 1 : MAIN_QUERY_TEMPERATURE),
          previousResponseId: toolUseContext?.responseState?.previousResponseId,
          verbosity,
          ...(options?.stopSequences && options.stopSequences.length > 0
            ? { stopSequences: options.stopSequences }
            : {}),
        }

        adapterContext = {
          adapter,
          request: adapter.createRequest(unifiedParams),
        }
      }
    }
  }

  let queryResult: QueryResult
  let startIncludingRetries = Date.now()

  try {
    queryResult = await withRetry(
      async attempt => {
        start = Date.now()

        if (adapterContext) {
          const { callGPT5ResponsesAPI } = await import('#core/ai/openai')

          const response = await callGPT5ResponsesAPI(
            modelProfile,
            adapterContext.request,
            signal,
            options?.requestHeadersProfile,
          )

          const unifiedResponse = await adapterContext.adapter.parseResponse(
            response,
            adapterContext.request.stream === true
              ? assistantStreamUpdateOptions
              : undefined,
          )

          const assistantMessage = buildAssistantMessageFromUnifiedResponse(
            unifiedResponse,
            start,
          )
          assistantMessage.message.usage = normalizeUsage(
            assistantMessage.message.usage,
          )

          return {
            assistantMessage,
            rawResponse: unifiedResponse,
            apiFormat: 'openai',
          }
        }

        const maxTokens =
          options?.maxTokens ?? getMaxTokensFromProfile(modelProfile)

        const opts = buildOpenAIChatCompletionCreateParams({
          model,
          maxTokens,
          messages: [...openaiSystem, ...openaiMessages],
          temperature:
            options?.temperature ??
            (isGPT5Model(model) ? 1 : MAIN_QUERY_TEMPERATURE),
          stream: attempt > 1 ? false : streamDecision.stream,
          toolSchemas: toolSchemas,
          stopSequences: options?.stopSequences,
          provider:
            typeof modelProfile?.provider === 'string'
              ? modelProfile.provider
              : null,
          // Omitting this field avoids explicitly opting into profile-level
          // extended reasoning in the legacy endpoint. Some old models have
          // no portable `none` value, so they retain their provider default.
          reasoningEffort: shouldRequestReasoningSummary
            ? await getReasoningEffort(modelProfile, messages, {
                thinkingTokens: maxThinkingTokens,
              })
            : undefined,
        })

        const completionFunction = isGPT5Model(modelProfile?.modelName || '')
          ? getGPT5CompletionWithProfile
          : getCompletionWithProfile
        const s = await completionFunction(
          modelProfile,
          opts,
          0,
          providerMaxAttempts,
          signal,
          options?.requestHeadersProfile,
        )
        let finalResponse: OpenAI.ChatCompletion
        if (opts.stream) {
          if (!isOpenAIChunkStream(s)) {
            throw new Error(
              'OpenAI provider returned a non-streaming response for a streaming request',
            )
          }
          finalResponse = await handleMessageStream(
            s,
            signal,
            assistantStreamUpdateOptions,
          )
        } else {
          if (isOpenAIChunkStream(s)) {
            throw new Error(
              'OpenAI provider returned a streaming response for a non-streaming request',
            )
          }
          finalResponse = s
        }
        const assistantMsg = createAssistantMessageFromOpenAIResponse({
          response: finalResponse,
          tools,
          start,
        })
        return {
          assistantMessage: assistantMsg,
          rawResponse: finalResponse,
          apiFormat: 'openai',
        }
      },
      { signal, maxRetries: hasCommittedToolResult ? 0 : undefined },
    )
  } catch (error) {
    logError(error)
    return getAssistantMessageFromError(error)
  }

  const durationMs = Date.now() - start
  const durationMsIncludingRetries = Date.now() - startIncludingRetries

  const assistantMessage = queryResult.assistantMessage
  assistantMessage.message.content = normalizeContentFromAPI(
    assistantMessage.message.content || [],
  )
  if (thinkingMode === 'disabled') {
    assistantMessage.message.content = assistantMessage.message.content.filter(
      block => block.type !== 'thinking' && block.type !== 'redacted_thinking',
    )
  }

  const normalizedUsage = normalizeUsage(assistantMessage.message.usage)
  assistantMessage.message.usage = normalizedUsage

  const inputTokens = normalizedUsage.input_tokens ?? 0
  const outputTokens = normalizedUsage.output_tokens ?? 0
  const cacheReadInputTokens = normalizedUsage.cache_read_input_tokens ?? 0
  const cacheCreationInputTokens =
    normalizedUsage.cache_creation_input_tokens ?? 0

  const costTier =
    MODEL_COSTS[
      resolveModelCostTier(
        model,
        typeof modelProfile?.provider === 'string'
          ? modelProfile.provider
          : null,
      )
    ]
  const costUSD = estimateCostUSD({
    inputTokens,
    outputTokens,
    cacheReadInputTokens,
    cacheCreationInputTokens,
    rates: costTier,
  })

  addToTotalCost(costUSD, durationMsIncludingRetries)

  logLLMInteraction({
    systemPrompt: systemPrompt.join('\n'),
    messages: [...openaiSystem, ...openaiMessages],
    response: assistantMessage.message || queryResult.rawResponse,
    usage: {
      inputTokens,
      outputTokens,
      cacheReadInputTokens,
      cacheCreationInputTokens,
    },
    timing: {
      start,
      end: Date.now(),
    },
    apiFormat: queryResult.apiFormat,
  })

  assistantMessage.costUSD = costUSD
  assistantMessage.durationMs = durationMs
  assistantMessage.uuid = assistantMessage.uuid || (randomUUID() as UUID)

  return assistantMessage
}
