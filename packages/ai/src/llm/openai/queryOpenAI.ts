import OpenAI from 'openai'
import type { ChatCompletionStream } from 'openai/lib/ChatCompletionStream'
import { randomUUID } from 'crypto'
import type { UUID } from 'crypto'
import { zodToJsonSchema } from 'zod-to-json-schema'
import type { TextBlockParam } from '@anthropic-ai/sdk/resources/index.mjs'
import type { Tool, ToolUseContext } from '@kode/tool-interface/Tool'
import type {
  AiAssistantMessage as AssistantMessage,
  AiUserMessage as UserMessage,
  UnifiedRequestParams,
} from '../../internal/messageTypes'
import { MODEL_COSTS, resolveModelCostTier } from '#config'
import {
  debug as debugLogger,
  getCurrentRequest,
  logLLMInteraction,
  logSystemPromptConstruction,
} from '../../internal/debug'
import {
  addAiTotalCost,
  getAiMainModelProfile,
  getAiStream,
  logAiError,
  type AiModelProfileLike,
} from '../../internal/runtimeConfig'
import { normalizeContentFromAPI } from '../../internal/content'
import {
  CLI_SYSPROMPT_PREFIX,
  MAIN_QUERY_TEMPERATURE,
} from '../../internal/constants'
import {
  PROMPT_CACHING_ENABLED,
  splitSysPromptPrefix,
} from '../../internal/systemPromptUtils'
import { withRetry } from '../../internal/retry'
import { getAssistantMessageFromError } from '../../internal/errors'
import { resolveReasoningEffort } from '../../internal/reasoningEffort'
import {
  getAiAdapterFactory,
  type AiModelAdapter,
} from '../../internal/adapterFactory'
import {
  getCompletionWithProfile,
  getGPT5CompletionWithProfile,
} from '@kode/ai/openai'
import type { RequestHeadersProfile } from '../../internal/restrictedClientCompat'
import type { AssistantStreamUpdateOptions } from '@kode/tool-interface/assistantStreamUpdate'

import {
  convertAnthropicMessagesToOpenAIMessages,
  convertOpenAIResponseToAnthropic,
} from './conversion'
import { buildOpenAIChatCompletionCreateParams, isGPT5Model } from './params'
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

function createAssistantMessageFromOpenAIResponse(args: {
  response: OpenAI.ChatCompletion
  tools: Tool[]
  start: number
}): AssistantMessage {
  const message = convertOpenAIResponseToAnthropic(args.response, args.tools)
  const assistantMsg: AssistantMessage = {
    type: 'assistant',
    message,
    costUSD: 0,
    durationMs: Date.now() - args.start,
    uuid: randomUUID() as UUID,
  }
  if (isOpenAIStreamDegradedResponse(args.response)) {
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
    /** Prefer passing the resolved profile; falls back to host binding. */
    modelProfile?: AiModelProfileLike | null
    /** Per-call stream override; falls back to host binding (default true). */
    stream?: boolean
    toolUseContext?: ToolUseContext
    requestHeadersProfile?: RequestHeadersProfile
    cliSyspromptPrefix?: string
  },
): Promise<AssistantMessage> {
  const streamEnabled = options?.stream ?? getAiStream()
  const toolUseContext = options?.toolUseContext

  const modelProfile = options?.modelProfile ?? getAiMainModelProfile()
  let model: string

  // 🔍 Debug: 记录模型配置详情
  const currentRequest = getCurrentRequest()
  const assistantStreamUpdateOptions = {
    onAssistantStreamUpdate: toolUseContext?.options?.onAssistantStreamUpdate,
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

  if (modelProfile?.modelName) {
    model = modelProfile.modelName
  } else {
    model = options?.model || modelProfile?.modelName || ''
  }
  // Prepend system prompt block for easy API identification
  if (options?.prependCLISysprompt) {
    const prefix = options.cliSyspromptPrefix ?? CLI_SYSPROMPT_PREFIX
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
    // Project docs context is host-owned; empty here keeps transport free of
    // context package coupling while hosts can still log richer prompts.
    kodeContext: '',
    reminders: [],
    finalPrompt: systemPrompt.join('\n'),
  })

  let start = Date.now()

  type AdapterExecutionContext = {
    adapter: AiModelAdapter
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
    const adapterFactory = getAiAdapterFactory()

    if (USE_NEW_ADAPTER_SYSTEM && adapterFactory) {
      // Default factory is the in-package ModelAdapterFactory; hosts may
      // override or unbind (null => Chat Completions only).
      const adapterProfile = modelProfile as any
      const shouldUseResponses =
        adapterFactory.shouldUseResponsesAPI(adapterProfile)

      // Only use new adapters for Responses API models
      // Chat Completions models use legacy path for stability
      if (shouldUseResponses) {
        const adapter = adapterFactory.createAdapter(adapterProfile)
        const reasoningEffort = resolveReasoningEffort({
          modelProfile,
          thinkingTokens: maxThinkingTokens,
        })

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
          stream: streamEnabled,
          reasoningEffort: reasoningEffort ?? undefined,
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
      async () => {
        start = Date.now()

        if (adapterContext) {
          const { callGPT5ResponsesAPI } = await import('@kode/ai/openai')

          const response = await callGPT5ResponsesAPI(
            modelProfile as any,
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
          stream: streamEnabled,
          toolSchemas: toolSchemas,
          stopSequences: options?.stopSequences,
          provider:
            typeof modelProfile?.provider === 'string'
              ? modelProfile.provider
              : null,
          reasoningEffort: resolveReasoningEffort({
            modelProfile,
            thinkingTokens: maxThinkingTokens,
          }),
        })

        const completionFunction = isGPT5Model(modelProfile?.modelName || '')
          ? getGPT5CompletionWithProfile
          : getCompletionWithProfile
        const s = await completionFunction(
          modelProfile as any,
          opts,
          0,
          providerMaxAttempts,
          signal,
          options?.requestHeadersProfile,
        )
        let finalResponse
        if (opts.stream) {
          finalResponse = await handleMessageStream(
            s as ChatCompletionStream,
            signal,
            assistantStreamUpdateOptions,
          )
        } else {
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
    logAiError(error)
    return getAssistantMessageFromError(error)
  }

  const durationMs = Date.now() - start
  const durationMsIncludingRetries = Date.now() - startIncludingRetries

  const assistantMessage = queryResult.assistantMessage
  assistantMessage.message.content = normalizeContentFromAPI(
    assistantMessage.message.content || [],
  )

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

  addAiTotalCost(costUSD, durationMsIncludingRetries)

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
