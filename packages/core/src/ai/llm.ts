import { randomUUID } from 'crypto'
import type { UUID } from 'crypto'
import { config as loadDotenv } from 'dotenv'
import type { AssistantMessage, UserMessage } from '#core/query'
import { resolveToolDescription, type Tool } from '#core/tooling/Tool'
import { createAssistantAPIErrorMessage } from '#core/utils/messages'
import { queryOpenAI } from '#core/ai/llm/openai'
import { queryAnthropicNative } from '#core/ai/llm/anthropic'
import { queryCodexOAuth } from '#core/ai/llm/codexOAuth'
import { queryGitHubCopilot } from '#core/ai/llm/githubCopilot'
import { queryGrokBuild } from '#core/ai/llm/grokBuild'
import { getGlobalConfig, type ModelProfile } from '#core/utils/config'
import { withVCR } from '#core/services/vcr'
import {
  debug as debugLogger,
  markPhase,
  getCurrentRequest,
  logErrorWithDiagnosis,
} from '#core/utils/debugLogger'
import {
  getModelManager,
  type ModelParam,
  type ResolvedModelInfo,
} from '#core/utils/model'
import {
  responseStateManager,
  getConversationId,
} from '#core/services/responseStateManager'
import { addNotification } from '#core/services/notificationCenter'
import type { ToolUseContext } from '#core/tooling/Tool'
import {
  getCLISyspromptPrefix,
  getCompatSyspromptPrefix,
  getCompatSystemPrompt,
} from '#core/constants/prompts'
import {
  buildRequestStrategyFallbackPlan,
  filterToolsForCompatProfile,
  shouldAttemptRestrictedClientFallback,
} from '#core/ai/llm/restrictedClientCompat'
import { generateKodeContext, refreshKodeContext } from './llm/kodeContext'
import {
  API_ERROR_MESSAGE_PREFIX,
  CREDIT_BALANCE_TOO_LOW_ERROR_MESSAGE,
  INVALID_API_KEY_ERROR_MESSAGE,
  MAIN_QUERY_TEMPERATURE,
  NO_CONTENT_MESSAGE,
  PROMPT_TOO_LONG_ERROR_MESSAGE,
} from './constants'
export { fetchAnthropicModels, verifyApiKey } from './llm/apiKey'

loadDotenv({ quiet: true })

// KodeContext helpers are implemented in `./kodeContext` to keep this module lean.
export { generateKodeContext, refreshKodeContext }
export {
  getAnthropicClient,
  resetAnthropicClient,
  userMessageToMessageParam,
  assistantMessageToMessageParam,
} from '#core/ai/llm/anthropic'

type QueryLLMTestModelManager = {
  resolveModelWithInfo(modelParam: ModelParam): ResolvedModelInfo
  resolveModel(modelParam: ModelParam): ModelProfile | null
}

type QueryLLMWithPromptCachingFn = typeof queryLLMWithPromptCaching

const MODEL_POINTERS = new Set(['main', 'task', 'compact', 'quick'])
const AUXILIARY_MODEL_POINTERS = new Set(['task', 'compact', 'quick'])
const OAUTH_PROVIDERS_WITHOUT_KODE_TOOL_BRIDGE = new Set([
  'github-copilot',
  'grok-build',
])

export const EXTERNAL_RUNTIME_TOOL_BRIDGE_UNAVAILABLE_MESSAGE =
  'API Error: The selected OAuth model runtime cannot execute Kode tools yet, so this project inspection or action was not executed. Use /model to select a tool-capable API model and retry.'

function requiresKodeToolBridge(
  systemPrompt: string[],
  tools: Tool[],
): boolean {
  return (
    tools.length > 0 &&
    systemPrompt.some(prompt => prompt.includes('<tool_use_requirement>'))
  )
}

/**
 * Loads the process-wide model configuration before the first user request.
 * This performs no provider I/O and is intentionally safe to run in the
 * background after the interactive UI has mounted.
 */
export function prepareLlmRuntime(): void {
  getModelManager()
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  if (isRecord(error)) {
    const message = error.message
    if (typeof message === 'string') return message
    const nestedError = error.error
    if (isRecord(nestedError) && typeof nestedError.message === 'string') {
      return nestedError.message
    }
  }
  return String(error)
}

function getErrorStatus(error: unknown): number | undefined {
  if (!isRecord(error)) return undefined
  const candidates = [
    error.status,
    error.statusCode,
    error.code,
    isRecord(error.response) ? error.response.status : undefined,
    isRecord(error.error) ? error.error.status : undefined,
  ]

  for (const candidate of candidates) {
    if (typeof candidate === 'number' && Number.isFinite(candidate)) {
      return candidate
    }
    if (typeof candidate === 'string' && /^\d+$/.test(candidate)) {
      return Number(candidate)
    }
  }
  return undefined
}

function isAbortLikeError(error: unknown, signal: AbortSignal): boolean {
  if (signal.aborted) return true
  if (!(error instanceof Error)) return false
  const message = error.message.toLowerCase()
  return (
    error.name === 'AbortError' ||
    message.includes('request was cancelled') ||
    message.includes('operation was aborted')
  )
}

function isPromptSizeError(error: unknown): boolean {
  const message = getErrorMessage(error).toLowerCase()
  return (
    message.includes(PROMPT_TOO_LONG_ERROR_MESSAGE.toLowerCase()) ||
    message.includes('prompt is too long') ||
    message.includes('context_length_exceeded') ||
    message.includes('maximum context length') ||
    message.includes('context window') ||
    message.includes('too many tokens')
  )
}

function isRuntimeFallbackError(error: unknown, signal: AbortSignal): boolean {
  if (isAbortLikeError(error, signal) || isPromptSizeError(error)) return false

  const status = getErrorStatus(error)
  if (
    status === 401 ||
    status === 403 ||
    status === 404 ||
    status === 408 ||
    status === 409 ||
    status === 425 ||
    status === 429 ||
    (status !== undefined && status >= 500)
  ) {
    return true
  }

  const message = getErrorMessage(error).toLowerCase()
  const recoverableMarkers = [
    'invalid api key',
    'x-api-key',
    'unauthorized',
    'authentication',
    'permission denied',
    'forbidden',
    'model_not_found',
    'model not found',
    'does not exist',
    'not available',
    'unavailable',
    'overloaded',
    'rate limit',
    'ratelimit',
    'quota',
    'credit balance',
    'insufficient_quota',
    'timeout',
    'timed out',
    'fetch failed',
    'network',
    'connection',
    'connect',
    'econn',
    'etimedout',
    'enotfound',
    'eai_again',
    'socket',
    'tls',
    'ssl',
    'terminated',
    'stream ended before',
    'complete response',
    'empty_response',
    'service unavailable',
  ]

  return recoverableMarkers.some(marker => message.includes(marker))
}

function isAuxiliaryRuntimeRequest(
  modelParam: string | import('#core/utils/config').ModelPointerType,
  toolUseContext?: ToolUseContext,
): boolean {
  const modelKey = String(modelParam)
  if (AUXILIARY_MODEL_POINTERS.has(modelKey)) return true
  return Boolean(toolUseContext?.agentId && toolUseContext.agentId !== 'main')
}

function isSameModelProfile(a: ModelProfile, b: ModelProfile): boolean {
  return (
    a.modelName === b.modelName &&
    a.provider === b.provider &&
    (a.baseURL || '') === (b.baseURL || '') &&
    a.apiKey === b.apiKey
  )
}

export {
  API_ERROR_MESSAGE_PREFIX,
  PROMPT_TOO_LONG_ERROR_MESSAGE,
  CREDIT_BALANCE_TOO_LOW_ERROR_MESSAGE,
  INVALID_API_KEY_ERROR_MESSAGE,
  NO_CONTENT_MESSAGE,
  MAIN_QUERY_TEMPERATURE,
}

export async function queryLLM(
  messages: (UserMessage | AssistantMessage)[],
  systemPrompt: string[],
  maxThinkingTokens: number,
  tools: Tool[],
  signal: AbortSignal,
  options: {
    safeMode: boolean
    model: string | import('#core/utils/config').ModelPointerType
    prependCLISysprompt: boolean
    temperature?: number
    /**
     * Optional per-call max tokens override (used for small deterministic sub-queries like safety gates).
     */
    maxTokens?: number
    /**
     * Optional per-call stop sequences (best-effort; ignored by providers that don't support it).
     */
    stopSequences?: string[]
    toolUseContext?: ToolUseContext
    __testModelManager?: QueryLLMTestModelManager
    __testQueryLLMWithPromptCaching?: QueryLLMWithPromptCachingFn
  },
): Promise<AssistantMessage> {
  const modelManager = options.__testModelManager ?? getModelManager()
  const modelResolution = modelManager.resolveModelWithInfo(options.model)

  if (!modelResolution.success || !modelResolution.profile) {
    const fallbackProfile = modelManager.resolveModel(options.model)
    if (!fallbackProfile) {
      throw new Error(
        modelResolution.error || `Failed to resolve model: ${options.model}`,
      )
    }

    debugLogger.warn('MODEL_RESOLUTION_FALLBACK', {
      inputParam: options.model,
      error: modelResolution.error,
      fallbackModelName: fallbackProfile.modelName,
      fallbackProvider: fallbackProfile.provider,
      requestId: getCurrentRequest()?.id,
    })

    modelResolution.success = true
    modelResolution.profile = fallbackProfile
  }

  const modelProfile = modelResolution.profile
  const resolvedModel = modelProfile.modelName

  // OAuth runtimes currently return text-only responses and deliberately do
  // not bridge their native tools into Kode's permission and transcript flow.
  // Fail before any provider call instead of letting an explicit project action
  // enter the required-tool retry loop and appear to have been inspected.
  if (
    OAUTH_PROVIDERS_WITHOUT_KODE_TOOL_BRIDGE.has(modelProfile.provider) &&
    requiresKodeToolBridge(systemPrompt, tools)
  ) {
    return createAssistantAPIErrorMessage(
      EXTERNAL_RUNTIME_TOOL_BRIDGE_UNAVAILABLE_MESSAGE,
    )
  }

  // Initialize response state if toolUseContext is provided
  const toolUseContext = options.toolUseContext
  if (toolUseContext && !toolUseContext.responseState) {
    const conversationId = getConversationId(
      toolUseContext.agentId,
      toolUseContext.messageId,
    )
    const previousResponseId =
      responseStateManager.getPreviousResponseId(conversationId)

    toolUseContext.responseState = {
      previousResponseId,
      conversationId,
    }
  }

  // Resolve and cache tool descriptions before building any provider tool schemas.
  // Some adapters build JSON schemas synchronously and rely on `cachedDescription`.
  await Promise.all(tools.map(tool => resolveToolDescription(tool)))

  debugLogger.api('MODEL_RESOLVED', {
    inputParam: options.model,
    resolvedModelName: resolvedModel,
    provider: modelProfile.provider,
    isPointer: MODEL_POINTERS.has(String(options.model)),
    hasResponseState: !!toolUseContext?.responseState,
    conversationId: toolUseContext?.responseState?.conversationId,
    requestId: getCurrentRequest()?.id,
  })

  const currentRequest = getCurrentRequest()
  debugLogger.api('LLM_REQUEST_START', {
    messageCount: messages.length,
    systemPromptLength: systemPrompt.join(' ').length,
    toolCount: tools.length,
    model: resolvedModel,
    originalModelParam: options.model,
    requestId: getCurrentRequest()?.id,
  })

  markPhase('LLM_CALL')

  const queryFn =
    options.__testQueryLLMWithPromptCaching ?? queryLLMWithPromptCaching
  const cleanOptions = { ...options }
  delete cleanOptions.__testModelManager
  delete cleanOptions.__testQueryLLMWithPromptCaching

  const executeQueryWithProfile = (profile: ModelProfile) => {
    const runQuery = () =>
      queryFn(messages, systemPrompt, maxThinkingTokens, tools, signal, {
        ...cleanOptions,
        model: profile.modelName,
        modelProfile: profile,
        toolUseContext,
      })

    return options.__testQueryLLMWithPromptCaching
      ? runQuery()
      : withVCR(messages, runQuery)
  }

  const recordSuccessfulRequest = (
    result: AssistantMessage,
    usedProfile: ModelProfile,
    fallbackToMain = false,
  ) => {
    debugLogger.api('LLM_REQUEST_SUCCESS', {
      costUSD: result.costUSD,
      durationMs: result.durationMs,
      responseLength: result.message.content?.length || 0,
      model: usedProfile.modelName,
      provider: usedProfile.provider,
      fallbackToMain,
      requestId: getCurrentRequest()?.id,
    })

    // Update response state for GPT-5 Responses API continuation
    if (toolUseContext?.responseState?.conversationId && result.responseId) {
      responseStateManager.setPreviousResponseId(
        toolUseContext.responseState.conversationId,
        result.responseId,
      )

      debugLogger.api('RESPONSE_STATE_UPDATED', {
        conversationId: toolUseContext.responseState.conversationId,
        responseId: result.responseId,
        fallbackToMain,
        requestId: getCurrentRequest()?.id,
      })
    }
  }

  try {
    const result = await executeQueryWithProfile(modelProfile)
    recordSuccessfulRequest(result, modelProfile)
    return result
  } catch (error) {
    if (
      isAuxiliaryRuntimeRequest(options.model, toolUseContext) &&
      isRuntimeFallbackError(error, signal)
    ) {
      const mainProfile = modelManager.resolveModel('main')
      if (mainProfile && !isSameModelProfile(mainProfile, modelProfile)) {
        const reason = getErrorMessage(error).slice(0, 500)
        debugLogger.warn('MODEL_RUNTIME_FALLBACK_TO_MAIN', {
          inputParam: options.model,
          failedModelName: modelProfile.modelName,
          failedProvider: modelProfile.provider,
          fallbackModelName: mainProfile.modelName,
          fallbackProvider: mainProfile.provider,
          agentId: toolUseContext?.agentId,
          reason,
          status: getErrorStatus(error),
          requestId: getCurrentRequest()?.id,
        })

        addNotification({
          title: 'Model fallback',
          message: `Auxiliary model ${modelProfile.name || modelProfile.modelName} failed; routing this request to main profile ${mainProfile.name || mainProfile.modelName}.`,
          kind: 'warning',
          source: 'system',
        })

        try {
          const fallbackResult = await executeQueryWithProfile(mainProfile)
          recordSuccessfulRequest(fallbackResult, mainProfile, true)
          return fallbackResult
        } catch (fallbackError) {
          debugLogger.warn('MODEL_RUNTIME_FALLBACK_TO_MAIN_FAILED', {
            inputParam: options.model,
            fallbackModelName: mainProfile.modelName,
            fallbackProvider: mainProfile.provider,
            agentId: toolUseContext?.agentId,
            originalReason: reason,
            fallbackReason: getErrorMessage(fallbackError).slice(0, 500),
            fallbackStatus: getErrorStatus(fallbackError),
            requestId: getCurrentRequest()?.id,
          })

          logErrorWithDiagnosis(
            fallbackError,
            {
              messageCount: messages.length,
              systemPromptLength: systemPrompt.join(' ').length,
              model: 'main',
              originalModel: options.model,
              toolCount: tools.length,
              phase: 'LLM_CALL_FALLBACK_TO_MAIN',
            },
            currentRequest?.id,
          )

          throw fallbackError
        }
      }
    }

    // 使用错误诊断系统记录 LLM 相关错误
    logErrorWithDiagnosis(
      error,
      {
        messageCount: messages.length,
        systemPromptLength: systemPrompt.join(' ').length,
        model: options.model,
        toolCount: tools.length,
        phase: 'LLM_CALL',
      },
      currentRequest?.id,
    )

    throw error
  }
}

export { formatSystemPromptWithContext } from '#core/services/systemPrompt'

async function queryLLMWithPromptCaching(
  messages: (UserMessage | AssistantMessage)[],
  systemPrompt: string[],
  maxThinkingTokens: number,
  tools: Tool[],
  signal: AbortSignal,
  options: {
    safeMode: boolean
    model: string
    prependCLISysprompt: boolean
    temperature?: number
    maxTokens?: number
    stopSequences?: string[]
    modelProfile?: ModelProfile | null
    toolUseContext?: ToolUseContext
  },
): Promise<AssistantMessage> {
  const config = getGlobalConfig()
  const toolUseContext = options.toolUseContext

  const modelProfile =
    options.modelProfile ?? getModelManager().getModel('main')
  let provider: string

  if (modelProfile) {
    provider = modelProfile.provider || config.primaryProvider || 'anthropic'
  } else {
    provider = config.primaryProvider || 'anthropic'
  }

  const fallbackPlan = buildRequestStrategyFallbackPlan(
    modelProfile?.requestStrategy,
    options.model,
  )
  const compatibilityToolUseContext =
    toolUseContext && toolUseContext.options
      ? {
          ...toolUseContext,
          options: {
            ...toolUseContext.options,
            getCustomSystemPromptAdditions: undefined,
          },
        }
      : toolUseContext

  let lastError: unknown = null

  for (const step of fallbackPlan) {
    const effectiveTools =
      step.tools === 'compat' ? filterToolsForCompatProfile(tools) : tools
    const effectiveSystemPrompt =
      step.systemPrompt === 'compat'
        ? await getCompatSystemPrompt({
            model: options.model,
            toolNames: effectiveTools.map(t => t.name),
            toolUseContext: compatibilityToolUseContext,
            outputStyleActive: false,
          })
        : systemPrompt
    const cliSyspromptPrefix =
      step.systemPrompt === 'compat'
        ? getCompatSyspromptPrefix()
        : getCLISyspromptPrefix()

    try {
      // OAuth runtimes resolve credentials in their own official clients. Do
      // not route these profiles through the API-key/OpenAI compatibility path.
      if (provider === 'codex-oauth') {
        if (!modelProfile)
          throw new Error('Codex OAuth model profile is missing')
        return await queryCodexOAuth(
          messages,
          effectiveSystemPrompt,
          maxThinkingTokens,
          effectiveTools,
          signal,
          { modelProfile, toolUseContext },
        )
      }
      if (provider === 'github-copilot') {
        if (!modelProfile)
          throw new Error('GitHub Copilot model profile is missing')
        return await queryGitHubCopilot(
          messages,
          effectiveSystemPrompt,
          maxThinkingTokens,
          effectiveTools,
          signal,
          { modelProfile, toolUseContext },
        )
      }
      if (provider === 'grok-build') {
        if (!modelProfile)
          throw new Error('Grok Build model profile is missing')
        return await queryGrokBuild(
          messages,
          effectiveSystemPrompt,
          maxThinkingTokens,
          effectiveTools,
          signal,
          { modelProfile, toolUseContext },
        )
      }

      // Use native Anthropic SDK for Anthropic and some Anthropic-compatible providers
      if (
        provider === 'anthropic' ||
        provider === 'bigdream' ||
        provider === 'opendev' ||
        provider === 'minimax-coding'
      ) {
        return await queryAnthropicNative(
          messages,
          effectiveSystemPrompt,
          maxThinkingTokens,
          effectiveTools,
          signal,
          {
            ...options,
            modelProfile,
            toolUseContext,
            requestHeadersProfile: step.headers,
            cliSyspromptPrefix,
          },
        )
      }

      // Use OpenAI-compatible interface for all other providers
      return await queryOpenAI(
        messages,
        effectiveSystemPrompt,
        maxThinkingTokens,
        effectiveTools,
        signal,
        {
          ...options,
          modelProfile,
          toolUseContext,
          requestHeadersProfile: step.headers,
          cliSyspromptPrefix,
        },
      )
    } catch (error) {
      lastError = error
      if (!shouldAttemptRestrictedClientFallback(error, options.model)) {
        throw error
      }
    }
  }

  if (lastError) throw lastError
  throw new Error('Failed to query model')
}

export async function queryModel(
  modelPointer: import('#core/utils/config').ModelPointerType,
  messages: (UserMessage | AssistantMessage)[],
  systemPrompt: string[] = [],
  signal?: AbortSignal,
): Promise<AssistantMessage> {
  // Use queryLLM with the pointer directly
  return queryLLM(
    messages,
    systemPrompt,
    0, // maxThinkingTokens
    [], // tools
    signal || new AbortController().signal,
    {
      safeMode: false,
      model: modelPointer,
      prependCLISysprompt: true,
    },
  )
}

// Note: Use queryModel(pointer, ...) directly instead of these convenience functions

// Simplified query function using quick model pointer
export async function queryQuick({
  systemPrompt = [],
  userPrompt,
  assistantPrompt,
  enablePromptCaching = false,
  signal,
}: {
  systemPrompt?: string[]
  userPrompt: string
  assistantPrompt?: string
  enablePromptCaching?: boolean
  signal?: AbortSignal
}): Promise<AssistantMessage> {
  const messages = [
    {
      message: { role: 'user', content: userPrompt },
      type: 'user',
      uuid: randomUUID(),
    },
  ] as (UserMessage | AssistantMessage)[]

  return queryModel('quick', messages, systemPrompt, signal)
}
