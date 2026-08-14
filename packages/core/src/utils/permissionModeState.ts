import type { ToolUseContext } from '#core/tooling/Tool'
import type { PermissionMode } from '#core/types/PermissionMode'
import { normalizePermissionMode } from '#core/types/PermissionMode'
import { isPlanModeEnabled } from '#core/utils/planMode'

const DEFAULT_CONVERSATION_KEY = 'default'
// Keep the non-UI fallback aligned with createDefaultToolPermissionContext.
// This path is used by headless, ACP, and provider-backed conversations too.
const ACTUAL_DEFAULT_MODE: PermissionMode = 'plan'

const permissionModeByConversationKey = new Map<string, PermissionMode>()

function getConversationKey(context?: Pick<ToolUseContext, 'options'>): string {
  const messageLogName =
    context?.options?.messageLogName ?? DEFAULT_CONVERSATION_KEY
  const forkNumber = context?.options?.forkNumber ?? 0
  return `${messageLogName}:${forkNumber}`
}

export function getPermissionModeForConversationKey(options: {
  conversationKey: string
  isBypassPermissionsModeAvailable: boolean
}): PermissionMode {
  const existing = permissionModeByConversationKey.get(options.conversationKey)
  if (existing) {
    const normalized = normalizePermissionMode(existing)
    if (
      normalized === 'bypassPermissions' &&
      !options.isBypassPermissionsModeAvailable
    ) {
      permissionModeByConversationKey.set(
        options.conversationKey,
        ACTUAL_DEFAULT_MODE,
      )
      return ACTUAL_DEFAULT_MODE
    }
    return normalized
  }

  permissionModeByConversationKey.set(
    options.conversationKey,
    ACTUAL_DEFAULT_MODE,
  )
  return ACTUAL_DEFAULT_MODE
}

export function setPermissionModeForConversationKey(options: {
  conversationKey: string
  mode: PermissionMode
}): void {
  permissionModeByConversationKey.set(
    options.conversationKey,
    normalizePermissionMode(options.mode),
  )
}

export function getPermissionMode(context?: ToolUseContext): PermissionMode {
  const conversationKey = getConversationKey(context)
  const safeMode = context?.options?.safeMode ?? false

  if (context && isPlanModeEnabled(context)) return 'plan'

  const override = context?.options?.permissionMode
  if (override) {
    const normalized = normalizePermissionMode(override)
    if (normalized === 'bypassPermissions' && safeMode) {
      return ACTUAL_DEFAULT_MODE
    }
    return normalized
  }

  const fromToolPermissionContext =
    context?.options?.toolPermissionContext?.mode
  if (fromToolPermissionContext) {
    const normalized = normalizePermissionMode(fromToolPermissionContext)
    if (normalized === 'bypassPermissions' && safeMode) {
      return ACTUAL_DEFAULT_MODE
    }
    return normalized
  }

  return getPermissionModeForConversationKey({
    conversationKey,
    isBypassPermissionsModeAvailable: !safeMode,
  })
}

export function setPermissionMode(
  context: ToolUseContext,
  mode: PermissionMode,
): void {
  const conversationKey = getConversationKey(context)
  permissionModeByConversationKey.set(
    conversationKey,
    normalizePermissionMode(mode),
  )
}

export function __resetPermissionModeStateForTests(): void {
  permissionModeByConversationKey.clear()
}
