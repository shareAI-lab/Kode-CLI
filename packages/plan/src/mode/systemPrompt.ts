import { existsSync } from 'fs'
import type { ToolUseContext } from '@kode/tool-interface/Tool'

import {
  getPlanFilePath,
  isMainPlanFilePathForActiveConversation,
  isPathInPlanDirectory,
  isPlanFilePathForActiveConversation,
} from './paths'
import {
  getAgentKey,
  getConversationKey,
  getPlanModeAttachmentState,
  getPlanModeFlags,
  isPlanModeEnabled,
  resetPlanModeAttachmentCountsForConversationKey,
  setPlanModeAttachmentState,
} from './state'
import {
  buildPlanModeExitReminder,
  buildPlanModeMainReminder,
  buildPlanModeMainInterviewReminder,
  buildPlanModeReentryReminder,
  buildPlanModeSparseReminder,
  buildPlanModeSubAgentReminder,
  isPlanModeInterviewPhaseEnabled,
  wrapSystemReminder,
} from './reminders'

const TURNS_BETWEEN_ATTACHMENTS = 5
const FULL_REMINDER_EVERY_N_ATTACHMENTS = 5

function isThinkingOnlyAssistantMessage(message: unknown): boolean {
  if (!message || typeof message !== 'object') return false
  const content = (message as { content?: unknown }).content
  if (!Array.isArray(content)) return false
  if (content.length === 0) return false

  return content.every(block => {
    if (!block || typeof block !== 'object') return false
    const type = (block as { type?: unknown }).type
    return type === 'thinking' || type === 'redacted_thinking'
  })
}

export {
  isPlanFilePathForActiveConversation,
  isMainPlanFilePathForActiveConversation,
  isPathInPlanDirectory,
}

export function getPlanModeSystemPromptAdditions(
  messages: Array<{ type?: string; message?: { content?: unknown } }>,
  context: ToolUseContext,
): string[] {
  const conversationKey = getConversationKey(context)
  const agentKey = getAgentKey(context)
  const flags = getPlanModeFlags(conversationKey)
  const additions: string[] = []

  const assistantTurns = messages.filter(m => {
    if (m?.type !== 'assistant') return false
    return !isThinkingOnlyAssistantMessage(m.message)
  }).length

  if (isPlanModeEnabled(context)) {
    const previous = getPlanModeAttachmentState(agentKey) ?? {
      hasInjected: false,
      lastInjectedAssistantTurn: -Infinity,
      injectedCountSinceExit: 0,
    }

    if (
      previous.hasInjected &&
      assistantTurns - previous.lastInjectedAssistantTurn <
        TURNS_BETWEEN_ATTACHMENTS
    ) {
      return []
    }

    const planFilePath = getPlanFilePath(context.agentId, conversationKey)
    const planExists = existsSync(planFilePath)
    const interviewPhaseEnabled = isPlanModeInterviewPhaseEnabled()

    const hadExitedPlanMode = flags.hasExitedPlanMode && planExists
    if (hadExitedPlanMode) {
      additions.push(
        wrapSystemReminder(buildPlanModeReentryReminder(planFilePath)),
      )
      flags.hasExitedPlanMode = false
    }

    const isSubAgent = Boolean(context.agentId && context.agentId !== 'main')

    const reminderType =
      previous.injectedCountSinceExit % FULL_REMINDER_EVERY_N_ATTACHMENTS === 0
        ? 'full'
        : 'sparse'

    additions.push(
      wrapSystemReminder(
        isSubAgent
          ? buildPlanModeSubAgentReminder({ planExists, planFilePath })
          : reminderType === 'sparse'
            ? buildPlanModeSparseReminder({
                planFilePath,
                interviewPhaseEnabled,
              })
            : interviewPhaseEnabled
              ? buildPlanModeMainInterviewReminder({ planExists, planFilePath })
              : buildPlanModeMainReminder({ planExists, planFilePath }),
      ),
    )

    setPlanModeAttachmentState(agentKey, {
      hasInjected: true,
      lastInjectedAssistantTurn: assistantTurns,
      injectedCountSinceExit: previous.injectedCountSinceExit + 1,
    })

    return additions
  }

  if (flags.needsPlanModeExitAttachment) {
    const planFilePath = getPlanFilePath(context.agentId, conversationKey)
    additions.push(
      wrapSystemReminder(
        buildPlanModeExitReminder({
          planFilePath,
          planExists: existsSync(planFilePath),
        }),
      ),
    )
    flags.needsPlanModeExitAttachment = false
    resetPlanModeAttachmentCountsForConversationKey(conversationKey)
  }

  return additions
}
