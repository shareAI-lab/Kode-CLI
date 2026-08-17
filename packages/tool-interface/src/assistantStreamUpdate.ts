import type { AssistantStreamUpdate, ToolUseContext } from './Tool'

export type AssistantStreamUpdateOptions = {
  onAssistantStreamUpdate?: NonNullable<
    ToolUseContext['options']
  >['onAssistantStreamUpdate']
  agentId?: string
  requestId?: string
}

type AssistantStreamUpdatePayload =
  | { type: 'start' }
  | { type: 'thinking_delta'; delta: string }
  | { type: 'text_delta'; delta: string }

export function emitAssistantStreamUpdate(
  options: AssistantStreamUpdateOptions | undefined,
  payload: AssistantStreamUpdatePayload,
): void {
  const callback = options?.onAssistantStreamUpdate
  if (typeof callback !== 'function') return

  const metadata = {
    ...(options?.agentId !== undefined ? { agentId: options.agentId } : {}),
    ...(options?.requestId !== undefined
      ? { requestId: options.requestId }
      : {}),
  }
  const event: AssistantStreamUpdate =
    payload.type === 'start'
      ? { type: 'start', ...metadata }
      : { type: payload.type, delta: payload.delta, ...metadata }

  try {
    const result = callback(event)
    if (result) void result.catch(() => {})
  } catch {
    /* no-op */
  }
}
