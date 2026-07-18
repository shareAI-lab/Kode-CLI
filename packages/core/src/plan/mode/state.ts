import type { ToolUseContext } from '#core/tooling/Tool'

export const DEFAULT_CONVERSATION_KEY = 'default'

export type PlanModeFlags = {
  hasExitedPlanMode: boolean
  needsPlanModeExitAttachment: boolean
}

export type PlanModeAttachmentState = {
  hasInjected: boolean
  lastInjectedAssistantTurn: number
  injectedCountSinceExit: number
}

const planModeEnabledByConversationKey = new Map<string, boolean>()
const planModeFlagsByConversationKey = new Map<string, PlanModeFlags>()
const planModeAttachmentStateByAgentKey = new Map<
  string,
  PlanModeAttachmentState
>()

let activePlanConversationKey: string | null = null

export function getConversationKey(
  context?: Pick<ToolUseContext, 'options'>,
): string {
  const messageLogName =
    context?.options?.messageLogName ?? DEFAULT_CONVERSATION_KEY
  const forkNumber = context?.options?.forkNumber ?? 0
  return `${messageLogName}:${forkNumber}`
}

export function getPlanConversationKey(
  context?: Pick<ToolUseContext, 'options'>,
): string {
  return getConversationKey(context)
}

export function setActivePlanConversationKey(conversationKey: string): void {
  activePlanConversationKey = conversationKey
}

export function getActivePlanConversationKey(): string | null {
  return activePlanConversationKey
}

export function getAgentKey(
  context?: Pick<ToolUseContext, 'options' | 'agentId'>,
): string {
  const conversationKey = getConversationKey(context)
  const agentId = context?.agentId ?? 'main'
  return `${conversationKey}:${agentId}`
}

export function isPlanModeEnabled(context?: ToolUseContext): boolean {
  const key = getConversationKey(context)
  return isPlanModeEnabledForConversationKey(key)
}

export function isPlanModeEnabledForConversationKey(
  conversationKey: string,
): boolean {
  return planModeEnabledByConversationKey.get(conversationKey) ?? false
}

export function setPlanModeEnabledForConversationKey(
  conversationKey: string,
  enabled: boolean,
): void {
  planModeEnabledByConversationKey.set(conversationKey, enabled)
}

export function getPlanModeFlags(conversationKey: string): PlanModeFlags {
  const existing = planModeFlagsByConversationKey.get(conversationKey)
  if (existing) return existing
  const created: PlanModeFlags = {
    hasExitedPlanMode: false,
    needsPlanModeExitAttachment: false,
  }
  planModeFlagsByConversationKey.set(conversationKey, created)
  return created
}

export function getPlanModeAttachmentState(
  agentKey: string,
): PlanModeAttachmentState | undefined {
  return planModeAttachmentStateByAgentKey.get(agentKey)
}

export function setPlanModeAttachmentState(
  agentKey: string,
  state: PlanModeAttachmentState,
): void {
  planModeAttachmentStateByAgentKey.set(agentKey, state)
}

export function resetPlanModeAttachmentCountsForConversationKey(
  conversationKey: string,
): void {
  const prefix = `${conversationKey}:`
  for (const [agentKey, state] of planModeAttachmentStateByAgentKey.entries()) {
    if (!agentKey.startsWith(prefix)) continue
    planModeAttachmentStateByAgentKey.set(agentKey, {
      ...state,
      injectedCountSinceExit: 0,
    })
  }
}

export function __resetPlanModeStateForTests(): void {
  planModeEnabledByConversationKey.clear()
  planModeFlagsByConversationKey.clear()
  planModeAttachmentStateByAgentKey.clear()
  activePlanConversationKey = null
}
