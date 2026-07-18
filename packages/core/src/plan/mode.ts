import type { ToolUseContext } from '#core/tooling/Tool'

import { getPlanFilePath, getPlanDirectory, readPlanFile } from './mode/paths'
import {
  getActivePlanConversationKey,
  getAgentKey,
  getConversationKey,
  getPlanConversationKey,
  getPlanModeAttachmentState,
  getPlanModeFlags,
  isPlanModeEnabled,
  isPlanModeEnabledForConversationKey,
  resetPlanModeAttachmentCountsForConversationKey,
  setActivePlanConversationKey,
  setPlanModeAttachmentState,
  setPlanModeEnabledForConversationKey,
  __resetPlanModeStateForTests,
} from './mode/state'
import {
  getPlanModeSystemPromptAdditions,
  isMainPlanFilePathForActiveConversation,
  isPathInPlanDirectory,
  isPlanFilePathForActiveConversation,
} from './mode/systemPrompt'
import {
  getPlanSlugForConversationKey,
  hydratePlanSlugFromMessages,
  setPlanSlug,
  __resetPlanSlugsForTests,
} from './mode/slug'

export {
  getPlanConversationKey,
  setActivePlanConversationKey,
  getActivePlanConversationKey,
  getPlanModeSystemPromptAdditions,
  isPlanModeEnabled,
  isPlanModeEnabledForConversationKey,
  setPlanSlug,
  getPlanSlugForConversationKey,
  hydratePlanSlugFromMessages,
  getPlanDirectory,
  getPlanFilePath,
  isPlanFilePathForActiveConversation,
  isMainPlanFilePathForActiveConversation,
  isPathInPlanDirectory,
  readPlanFile,
}

export function enterPlanMode(context?: ToolUseContext): {
  planFilePath: string
} {
  const key = getConversationKey(context)
  setPlanModeEnabledForConversationKey(key, true)
  return { planFilePath: getPlanFilePath(context?.agentId, key) }
}

export function enterPlanModeForConversationKey(conversationKey: string): void {
  setPlanModeEnabledForConversationKey(conversationKey, true)
}

export function exitPlanMode(context?: ToolUseContext): {
  planFilePath: string
} {
  const key = getConversationKey(context)
  setPlanModeEnabledForConversationKey(key, false)

  const flags = getPlanModeFlags(key)
  flags.hasExitedPlanMode = true
  flags.needsPlanModeExitAttachment = true
  resetPlanModeAttachmentCountsForConversationKey(key)

  return { planFilePath: getPlanFilePath(context?.agentId, key) }
}

export function exitPlanModeForConversationKey(conversationKey: string): void {
  setPlanModeEnabledForConversationKey(conversationKey, false)
  const flags = getPlanModeFlags(conversationKey)
  flags.hasExitedPlanMode = true
  flags.needsPlanModeExitAttachment = true
  resetPlanModeAttachmentCountsForConversationKey(conversationKey)
}

export function __resetPlanModeForTests(): void {
  __resetPlanModeStateForTests()
  __resetPlanSlugsForTests()
}
