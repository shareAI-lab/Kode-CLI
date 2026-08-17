import type { Message } from '#core/query'
import type { PermissionMode } from '#core/types/PermissionMode'
import { computeContextWindowPercentages } from '#core/utils/contextWindowPercentages'
import type { PromptMode } from './types'

export type AssistantTokenUsage = {
  input_tokens: number
  output_tokens: number
  cache_creation_input_tokens: number
  cache_read_input_tokens: number
}

export type PromptStatusLineUsage = {
  totalInputTokens: number
  totalOutputTokens: number
  totalCostUSD: number
  currentUsage: AssistantTokenUsage | null
}

export type PromptStatusLineProfile =
  | {
      modelName?: string
      name?: string
      provider?: string | null
      contextLength?: number
    }
  | null
  | undefined

function getAssistantTokenUsage(message: Message): AssistantTokenUsage | null {
  if (!message || message.type !== 'assistant') return null
  const usage = (message.message as unknown as { usage?: unknown }).usage
  if (!usage || typeof usage !== 'object') return null

  const rec = usage as Record<string, unknown>
  const inputTokens = rec.input_tokens
  const outputTokens = rec.output_tokens
  if (typeof inputTokens !== 'number' || typeof outputTokens !== 'number') {
    return null
  }

  return {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    cache_creation_input_tokens:
      typeof rec.cache_creation_input_tokens === 'number'
        ? rec.cache_creation_input_tokens
        : 0,
    cache_read_input_tokens:
      typeof rec.cache_read_input_tokens === 'number'
        ? rec.cache_read_input_tokens
        : 0,
  }
}

export function getPromptStatusLineUsage(
  messages: Message[],
): PromptStatusLineUsage {
  let totalInputTokens = 0
  let totalOutputTokens = 0
  let totalCostUSD = 0
  let currentUsage: AssistantTokenUsage | null = null

  for (const message of messages) {
    if (message.type === 'assistant') totalCostUSD += message.costUSD

    const usage = getAssistantTokenUsage(message)
    if (!usage) continue
    totalInputTokens += usage.input_tokens
    totalOutputTokens += usage.output_tokens
    currentUsage = usage
  }

  return { totalInputTokens, totalOutputTokens, totalCostUSD, currentUsage }
}

export function buildPromptStatusLineInput(args: {
  sessionId: string
  transcriptPath: string
  currentPwd: string
  originalCwd: string
  version: string
  outputStyleName: string
  profile: PromptStatusLineProfile
  usage: PromptStatusLineUsage
  currentContextTokens?: number
  totalCostUSD: number
  totalDurationMs: number
  totalAPIDurationMs: number
  messageLogName: string
  forkNumber: number
  mode: PromptMode
  permissionMode: PermissionMode
  editorMode?: string
  vimMode?: 'INSERT' | 'NORMAL'
}): Record<string, unknown> {
  const contextWindowSize =
    typeof args.profile?.contextLength === 'number'
      ? args.profile.contextLength
      : 0
  const currentContextTokens =
    typeof args.currentContextTokens === 'number' &&
    Number.isFinite(args.currentContextTokens) &&
    args.currentContextTokens >= 0
      ? Math.trunc(args.currentContextTokens)
      : null

  const { used_percentage, remaining_percentage } =
    computeContextWindowPercentages({
      currentUsage:
        currentContextTokens === null
          ? args.usage.currentUsage
          : { input_tokens: currentContextTokens },
      contextWindowSize,
    })
  const currentUsage = args.usage.currentUsage
  const currentUsageTokens = currentUsage
    ? currentUsage.input_tokens +
      currentUsage.output_tokens +
      currentUsage.cache_creation_input_tokens +
      currentUsage.cache_read_input_tokens
    : 0
  const exceeds200kTokens =
    (currentContextTokens ?? currentUsageTokens) > 200000

  return {
    session_id: args.sessionId,
    transcript_path: args.transcriptPath,
    cwd: args.currentPwd,
    model: {
      id: args.profile?.modelName ?? '',
      display_name: args.profile?.name ?? args.profile?.modelName ?? '',
    },
    workspace: {
      current_dir: args.currentPwd,
      project_dir: args.originalCwd,
    },
    version: args.version,
    output_style: { name: args.outputStyleName },
    cost: {
      total_cost_usd: args.totalCostUSD,
      total_duration_ms: args.totalDurationMs,
      total_api_duration_ms: args.totalAPIDurationMs,
    },
    context_window: {
      total_input_tokens: args.usage.totalInputTokens,
      total_output_tokens: args.usage.totalOutputTokens,
      context_window_size: contextWindowSize,
      current_context_tokens: currentContextTokens,
      current_usage: currentUsage,
      used_percentage,
      remaining_percentage,
    },
    exceeds_200k_tokens: exceeds200kTokens,
    ...(args.editorMode === 'vim' ? { vim: { mode: args.vimMode } } : {}),
    kode: {
      conversation: {
        messageLogName: args.messageLogName,
        forkNumber: args.forkNumber,
      },
      input_mode: args.mode,
      permission_mode: args.permissionMode,
      model: {
        provider: args.profile?.provider ?? null,
      },
    },
  }
}
