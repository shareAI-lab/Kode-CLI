import Anthropic from '@anthropic-ai/sdk'
import { AnthropicBedrock } from '@anthropic-ai/bedrock-sdk'
import { AnthropicVertex } from '@anthropic-ai/vertex-sdk'
import type { ContentBlock } from '@anthropic-ai/sdk/resources/messages/messages'
import type {
  MessageParam,
  TextBlockParam,
} from '@anthropic-ai/sdk/resources/index.mjs'
import type { UUID } from 'crypto'
import { nanoid } from 'nanoid'
import { zodToJsonSchema } from 'zod-to-json-schema'

import { getCLISyspromptPrefix } from '#core/constants/prompts'
import type { AssistantMessage, UserMessage } from '#core/query'
import type { Tool, ToolUseContext } from '#core/tooling/Tool'
import { getGlobalConfig, type ModelProfile } from '#core/utils/config'
import { USER_AGENT } from '#core/utils/http'
import {
  buildCompatHeaders,
  COMPAT_DEFAULT_TIMEOUT_MS,
  type RequestHeadersProfile,
} from '#core/ai/llm/restrictedClientCompat'
import {
  debug as debugLogger,
  getCurrentRequest,
  logLLMInteraction,
  logSystemPromptConstruction,
} from '#core/utils/debugLogger'
import { getModelManager } from '#core/utils/model'

import { addToTotalCost } from '#core/cost-tracker'
import { getAssistantMessageFromError } from '#core/ai/llm/errors'
import { withRetry } from '#core/ai/llm/retry'
import { getMaxTokensFromProfile } from '#core/ai/llm/maxTokens'
import { splitSysPromptPrefix } from '#core/ai/llm/systemPromptUtils'
import { generateKodeContext } from '#core/ai/llm/kodeContext'
import { MAIN_QUERY_TEMPERATURE } from '#core/ai/llm/constants'

import { getAnthropicClient, resetAnthropicClient } from './client'
import { applyCacheControlWithLimits } from './cacheControl'
import {
  addCacheBreakpoints,
  assistantMessageToMessageParam,
  userMessageToMessageParam,
} from './messageParams'
import { createAnthropicStreamingMessage } from './streaming'
import { getModelInputTokenCostUSD, getModelOutputTokenCostUSD } from './cost'

export { getAnthropicClient, resetAnthropicClient }
export { assistantMessageToMessageParam, userMessageToMessageParam }

type AnthropicMessageCreateParams =
  Anthropic.Beta.Messages.MessageCreateParams & {
    extra_headers?: Record<string, string>
  }

function traceAnthropicQuery(args: {
  streamMode: boolean
  modelProfile: ModelProfile | null | undefined
  model: string
  provider: string
  params: AnthropicMessageCreateParams
  temperature: number | undefined
  toolsCount: number
  thinkingBudgetTokens: number
}): void {
  const payload = {
    endpoint: args.modelProfile?.baseURL || 'DEFAULT_ANTHROPIC',
    model: args.model,
    provider: args.provider,
    apiKeyConfigured: !!args.modelProfile?.apiKey,
    maxTokens: args.params.max_tokens,
    temperature: args.temperature ?? MAIN_QUERY_TEMPERATURE,
    messageCount: args.params.messages?.length || 0,
    streamMode: args.streamMode,
    toolsCount: args.toolsCount,
    thinkingTokens: args.thinkingBudgetTokens,
    timestamp: new Date().toISOString(),
    modelProfileId: args.modelProfile?.modelName,
    modelProfileName: args.modelProfile?.name,
  }

  debugLogger.api(
    args.streamMode
      ? 'ANTHROPIC_API_CALL_START_STREAMING'
      : 'ANTHROPIC_API_CALL_START_NON_STREAMING',
    args.streamMode ? { ...payload, params: args.params } : payload,
  )
}

/**
 * Environment variables for different client types:
 *
 * Direct API:
 * - ANTHROPIC_API_KEY: Required for direct API access
 *
 * AWS Bedrock:
 * - AWS credentials configured via aws-sdk defaults
 *
 * Vertex AI:
 * - Model-specific region variables (highest priority):
 *   - VERTEX_REGION_CLAUDE_3_5_HAIKU: Region override for this model
 *   - VERTEX_REGION_CLAUDE_3_5_SONNET: Region override for this model
 *   - VERTEX_REGION_CLAUDE_3_7_SONNET: Region override for this model
 * - CLOUD_ML_REGION: Optional. The default GCP region to use for all models
 *   If specific model region not specified above
 * - ANTHROPIC_VERTEX_PROJECT_ID: Required. Your GCP project ID
 * - Standard GCP credentials configured via google-auth-library
 *
 * Priority for determining region:
 * 1. Hardcoded model-specific environment variables
 * 2. Global CLOUD_ML_REGION variable
 * 3. Default region from config
 * 4. Fallback region (us-east5)
 */

export async function queryAnthropicNative(
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
  const assistantStreamRequestId =
    toolUseContext?.requestId ?? getCurrentRequest()?.id ?? nanoid()

  const modelProfile =
    options?.modelProfile ?? getModelManager().getModel('main')
  let anthropic: Anthropic | AnthropicBedrock | AnthropicVertex
  let model: string
  let provider: string
  const requestHeadersProfile = options?.requestHeadersProfile ?? 'kode'

  // 🔍 Debug: 记录模型配置详情
  debugLogger.api('MODEL_CONFIG_ANTHROPIC', {
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
    // 使用ModelProfile的完整配置
    model = modelProfile.modelName
    provider = modelProfile.provider || config.primaryProvider || 'anthropic'

    // 基于ModelProfile创建专用的API客户端
    if (
      modelProfile.provider === 'anthropic' ||
      modelProfile.provider === 'minimax-coding'
    ) {
      const clientConfig: any = {
        apiKey: modelProfile.apiKey,
        dangerouslyAllowBrowser: true,
        maxRetries: 0,
        timeout: parseInt(
          process.env.API_TIMEOUT_MS ||
            String(
              requestHeadersProfile === 'compat'
                ? COMPAT_DEFAULT_TIMEOUT_MS
                : 60 * 1000,
            ),
          10,
        ),
        defaultHeaders:
          requestHeadersProfile === 'compat'
            ? buildCompatHeaders()
            : {
                'x-app': 'cli',
                'User-Agent': USER_AGENT,
              },
      }

      // 使用ModelProfile的baseURL而不是全局配置
      if (modelProfile.baseURL) {
        clientConfig.baseURL = modelProfile.baseURL
      }

      anthropic = new Anthropic(clientConfig)
    } else {
      // 其他提供商的处理逻辑
      anthropic = getAnthropicClient(model, { requestHeadersProfile })
    }
  } else {
    // 🚨 降级：没有有效的ModelProfile时，应该抛出错误
    const errorDetails = {
      modelProfileExists: !!modelProfile,
      modelProfileModelName: undefined,
      requestedModel: options?.model,
      requestId: getCurrentRequest()?.id,
    }
    debugLogger.error('ANTHROPIC_FALLBACK_ERROR', errorDetails)
    throw new Error(
      `No valid ModelProfile available for Anthropic provider. Please configure model through /model command. Debug: ${JSON.stringify(errorDetails)}`,
    )
  }

  // Prepend system prompt block for easy API identification
  if (options?.prependCLISysprompt) {
    // Log stats about first block for analyzing prefix matching config
    const [firstSyspromptBlock] = splitSysPromptPrefix(systemPrompt)

    const prefix = options.cliSyspromptPrefix ?? getCLISyspromptPrefix()
    systemPrompt = [prefix, ...systemPrompt]
  }

  const system: TextBlockParam[] = splitSysPromptPrefix(systemPrompt).map(
    _ => ({
      text: _,
      type: 'text',
    }),
  )

  const toolSchemas = await Promise.all(
    tools.map(
      async tool =>
        ({
          name: tool.name,
          // Compatibility note: tool schema `description` uses the tool prompt text,
          // and some tools (e.g. MCPSearch) require access to the full tools list.
          description: await tool.prompt({
            safeMode: options?.safeMode,
            tools,
          }),
          input_schema:
            'inputJSONSchema' in tool && tool.inputJSONSchema
              ? tool.inputJSONSchema
              : (zodToJsonSchema(tool.inputSchema) as Record<string, unknown>),
        }) as unknown as Anthropic.Beta.Messages.BetaTool,
    ),
  )

  const anthropicMessages = addCacheBreakpoints(messages)

  //  apply cache control
  const { systemBlocks: processedSystem, messageParams: processedMessages } =
    applyCacheControlWithLimits(system, anthropicMessages)
  const startIncludingRetries = Date.now()

  // 记录系统提示构建过程
  logSystemPromptConstruction({
    basePrompt: systemPrompt.join('\n'),
    kodeContext: generateKodeContext() || '',
    reminders: [], // 这里可以从 generateSystemReminders 获取
    finalPrompt: systemPrompt.join('\n'),
  })

  let start = Date.now()
  let attemptNumber = 0
  let response

  try {
    response = await withRetry(
      async attempt => {
        attemptNumber = attempt
        start = Date.now()

        const maxTokens =
          options?.maxTokens ?? getMaxTokensFromProfile(modelProfile)
        const thinkingBudgetTokens =
          maxThinkingTokens > 0
            ? Math.min(maxThinkingTokens, Math.max(0, maxTokens - 1))
            : 0

        const params: AnthropicMessageCreateParams = {
          model,
          max_tokens: maxTokens,
          messages: processedMessages,
          system: processedSystem,
          tools: toolSchemas.length > 0 ? toolSchemas : undefined,
          tool_choice: toolSchemas.length > 0 ? { type: 'auto' } : undefined,
          ...(options?.temperature !== undefined
            ? { temperature: options.temperature }
            : {}),
          ...(options?.stopSequences && options.stopSequences.length > 0
            ? { stop_sequences: options.stopSequences }
            : {}),
        }

        if (thinkingBudgetTokens > 0) {
          params.extra_headers = {
            'anthropic-beta': 'max-tokens-3-5-sonnet-2024-07-15',
          }
          params.thinking = {
            type: 'enabled',
            budget_tokens: thinkingBudgetTokens,
          }
        }

        if (config.stream) {
          traceAnthropicQuery({
            streamMode: true,
            modelProfile,
            model,
            provider,
            params,
            temperature: options?.temperature,
            toolsCount: toolSchemas.length,
            thinkingBudgetTokens,
          })

          return await createAnthropicStreamingMessage(
            anthropic,
            params,
            signal,
            {
              onStreamEvent:
                typeof toolUseContext?.options?.onStreamEvent === 'function'
                  ? toolUseContext.options.onStreamEvent
                  : undefined,
              onAssistantStreamUpdate:
                toolUseContext?.options?.onAssistantStreamUpdate,
              agentId: toolUseContext?.agentId,
              requestId: assistantStreamRequestId,
            },
          )
        } else {
          traceAnthropicQuery({
            streamMode: false,
            modelProfile,
            model,
            provider,
            params,
            temperature: options?.temperature,
            toolsCount: toolSchemas.length,
            thinkingBudgetTokens,
          })

          return await anthropic.beta.messages.create(params, {
            signal: signal, // ← CRITICAL: Connect the AbortSignal to API call
          })
        }
      },
      { signal },
    )

    debugLogger.api('ANTHROPIC_API_CALL_SUCCESS', {
      content: response.content,
    })

    const ttftMs = Date.now() - start
    const durationMs = Date.now() - startIncludingRetries

    const content = response.content.map((block: ContentBlock) => {
      if (block.type === 'text') {
        return {
          type: 'text' as const,
          text: block.text,
        }
      } else if (block.type === 'tool_use') {
        return {
          type: 'tool_use' as const,
          id: block.id,
          name: block.name,
          input: block.input,
        }
      }
      return block
    })

    const assistantMessage: AssistantMessage = {
      message: {
        id: response.id,
        content,
        model: response.model,
        role: 'assistant',
        stop_reason: response.stop_reason,
        stop_sequence: response.stop_sequence,
        type: 'message',
        usage: response.usage,
      },
      type: 'assistant',
      uuid: nanoid() as UUID,
      durationMs,
      costUSD: 0, // Will be calculated below
    }

    // 记录完整的 LLM 交互调试信息 (Anthropic path)
    // 注意：Anthropic API将system prompt和messages分开，这里重构为完整的API调用视图
    const systemMessages = system.map(block => ({
      role: 'system',
      content: block.text,
    }))

    logLLMInteraction({
      systemPrompt: systemPrompt.join('\n'),
      messages: [...systemMessages, ...anthropicMessages],
      response: response,
      usage: response.usage
        ? {
            inputTokens: response.usage.input_tokens,
            outputTokens: response.usage.output_tokens,
          }
        : undefined,
      timing: {
        start: start,
        end: Date.now(),
      },
      apiFormat: 'anthropic',
    })

    // Calculate cost using native Anthropic usage data
    const inputTokens = response.usage.input_tokens
    const outputTokens = response.usage.output_tokens
    const cacheCreationInputTokens =
      response.usage.cache_creation_input_tokens ?? 0
    const cacheReadInputTokens = response.usage.cache_read_input_tokens ?? 0

    const costUSD =
      (inputTokens / 1_000_000) * getModelInputTokenCostUSD(model) +
      (outputTokens / 1_000_000) * getModelOutputTokenCostUSD(model) +
      (cacheCreationInputTokens / 1_000_000) *
        getModelInputTokenCostUSD(model) +
      (cacheReadInputTokens / 1_000_000) *
        (getModelInputTokenCostUSD(model) * 0.1) // Cache reads are 10% of input cost

    assistantMessage.costUSD = costUSD
    addToTotalCost(costUSD, durationMs)

    return assistantMessage
  } catch (error) {
    return getAssistantMessageFromError(error)
  }
}
