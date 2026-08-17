import type {
  ToolPermissionContext,
  ToolPermissionContextUpdate,
} from '#core/types/toolPermissionContext'
import { applyToolPermissionContextUpdate } from '#core/types/toolPermissionContext'
import { loadToolPermissionContextFromDisk } from '#core/utils/permissions/toolPermissionSettings'

const toolPermissionContextByConversationKey = new Map<
  string,
  ToolPermissionContext
>()

type ToolPermissionContextListener = (event: {
  conversationKey: string
  context: ToolPermissionContext
}) => void

const toolPermissionContextListeners = new Set<ToolPermissionContextListener>()

function notifyToolPermissionContextListeners(event: {
  conversationKey: string
  context: ToolPermissionContext
}): void {
  for (const listener of toolPermissionContextListeners) {
    try {
      listener(event)
    } catch {
      // Listener errors should not break permission enforcement.
    }
  }
}

export function subscribeToolPermissionContextUpdates(
  listener: ToolPermissionContextListener,
): () => void {
  toolPermissionContextListeners.add(listener)
  return () => {
    toolPermissionContextListeners.delete(listener)
  }
}

export function getToolPermissionContextForConversationKey(options: {
  conversationKey: string
  isBypassPermissionsModeAvailable: boolean
}): ToolPermissionContext {
  const existing = toolPermissionContextByConversationKey.get(
    options.conversationKey,
  )
  if (existing) {
    return existing
  }

  const initial = loadToolPermissionContextFromDisk({
    isBypassPermissionsModeAvailable: options.isBypassPermissionsModeAvailable,
  })
  toolPermissionContextByConversationKey.set(options.conversationKey, initial)
  return initial
}

export function setToolPermissionContextForConversationKey(options: {
  conversationKey: string
  context: ToolPermissionContext
}): void {
  toolPermissionContextByConversationKey.set(
    options.conversationKey,
    options.context,
  )
  notifyToolPermissionContextListeners({
    conversationKey: options.conversationKey,
    context: options.context,
  })
}

export function applyToolPermissionContextUpdateForConversationKey(options: {
  conversationKey: string
  isBypassPermissionsModeAvailable: boolean
  update: ToolPermissionContextUpdate
}): ToolPermissionContext {
  const prev = getToolPermissionContextForConversationKey({
    conversationKey: options.conversationKey,
    isBypassPermissionsModeAvailable: options.isBypassPermissionsModeAvailable,
  })
  const next = applyToolPermissionContextUpdate(prev, options.update)
  toolPermissionContextByConversationKey.set(options.conversationKey, next)
  notifyToolPermissionContextListeners({
    conversationKey: options.conversationKey,
    context: next,
  })
  return next
}

export function __resetToolPermissionContextStateForTests(): void {
  toolPermissionContextByConversationKey.clear()
  toolPermissionContextListeners.clear()
}
