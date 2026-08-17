import type { AssistantStreamUpdate } from '@kode/tool-interface/Tool'

export const ASSISTANT_STREAM_FRAME_INTERVAL_MS = 33
export const ASSISTANT_STREAM_MAX_TAIL_CHARS = 32 * 1024

export type AssistantStreamUpdateEvent = Readonly<AssistantStreamUpdate>

export type AssistantStreamSnapshot = Readonly<{
  thinking: string
  text: string
}>

type AssistantStreamScheduler = {
  now: () => number
  schedule: (callback: () => void, delayMs: number) => () => void
}

export type AssistantStreamStore = {
  subscribe: (listener: () => void) => () => void
  getSnapshot: () => AssistantStreamSnapshot
  beginTurn: (turn: AbortController) => void
  handleUpdate: (
    turn: AbortController,
    event: AssistantStreamUpdateEvent,
  ) => void
  clearPreview: (turn: AbortController) => void
  endTurn: (turn: AbortController) => void
  destroy: () => void
}

type CreateAssistantStreamStoreOptions = {
  frameIntervalMs?: number
  maxTailChars?: number
  scheduler?: AssistantStreamScheduler
}

const EMPTY_SNAPSHOT: AssistantStreamSnapshot = Object.freeze({
  thinking: '',
  text: '',
})

const defaultScheduler: AssistantStreamScheduler = {
  now: () => Date.now(),
  schedule: (callback, delayMs) => {
    const timer = setTimeout(callback, delayMs)
    return () => clearTimeout(timer)
  },
}

function appendBoundedTail(
  current: string,
  delta: string,
  maxTailChars: number,
): string {
  if (delta.length >= maxTailChars) {
    return sliceTailWithoutSplittingSurrogate(delta, maxTailChars)
  }

  const overflow = current.length + delta.length - maxTailChars
  const retainedCurrent =
    overflow > 0
      ? sliceTailWithoutSplittingSurrogate(current, current.length - overflow)
      : current
  return `${retainedCurrent}${delta}`
}

function sliceTailWithoutSplittingSurrogate(
  value: string,
  maxChars: number,
): string {
  let start = Math.max(0, value.length - maxChars)
  const codeUnit = value.charCodeAt(start)
  if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
    start += 1
  }
  return value.slice(start)
}

function isMainAgentUpdate(event: AssistantStreamUpdateEvent): boolean {
  return event.agentId === undefined || event.agentId === 'main'
}

export function createAssistantStreamStore(
  options: CreateAssistantStreamStoreOptions = {},
): AssistantStreamStore {
  const frameIntervalMs = Math.max(
    1,
    options.frameIntervalMs ?? ASSISTANT_STREAM_FRAME_INTERVAL_MS,
  )
  const maxTailChars = Math.max(
    1,
    options.maxTailChars ?? ASSISTANT_STREAM_MAX_TAIL_CHARS,
  )
  const scheduler = options.scheduler ?? defaultScheduler

  const listeners = new Set<() => void>()
  let snapshot = EMPTY_SNAPSHOT
  let activeTurn: AbortController | null = null
  // undefined: no stream selected; null: selected legacy stream without an id.
  let activeRequestId: string | null | undefined
  let retainedThinking = ''
  let retainedText = ''
  let hasPublishedFirstContent = false
  let lastPublishAt = 0
  let generation = 0
  let cancelScheduledPublish: (() => void) | null = null
  let destroyed = false

  const publishSnapshot = (thinking: string, text: string) => {
    if (snapshot.thinking === thinking && snapshot.text === text) return

    snapshot =
      thinking.length || text.length
        ? Object.freeze({ thinking, text })
        : EMPTY_SNAPSHOT
    for (const listener of listeners) listener()
  }

  const cancelPendingPublish = () => {
    cancelScheduledPublish?.()
    cancelScheduledPublish = null
  }

  const resetPreview = (resetRequest = false) => {
    generation += 1
    cancelPendingPublish()
    retainedThinking = ''
    retainedText = ''
    hasPublishedFirstContent = false
    lastPublishAt = 0
    if (resetRequest) activeRequestId = undefined
    publishSnapshot('', '')
  }

  const publishRetainedContent = () => {
    lastPublishAt = scheduler.now()
    publishSnapshot(retainedThinking, retainedText)
  }

  const schedulePublish = (turn: AbortController) => {
    if (cancelScheduledPublish) return

    const elapsed = Math.max(0, scheduler.now() - lastPublishAt)
    const delayMs = Math.max(0, frameIntervalMs - elapsed)
    if (delayMs === 0) {
      publishRetainedContent()
      return
    }

    const scheduledGeneration = generation
    cancelScheduledPublish = scheduler.schedule(() => {
      cancelScheduledPublish = null
      if (
        destroyed ||
        activeTurn !== turn ||
        generation !== scheduledGeneration
      ) {
        return
      }
      publishRetainedContent()
    }, delayMs)
  }

  return {
    subscribe(listener) {
      if (destroyed) return () => {}
      listeners.add(listener)
      return () => listeners.delete(listener)
    },

    getSnapshot() {
      return snapshot
    },

    beginTurn(turn) {
      if (destroyed) return
      activeTurn = turn
      resetPreview(true)
    },

    handleUpdate(turn, event) {
      if (destroyed || activeTurn !== turn || !isMainAgentUpdate(event)) {
        return
      }

      if (event.type === 'start') {
        const requestId = event.requestId ?? null
        if (activeRequestId !== undefined && requestId !== activeRequestId)
          return
        activeRequestId = requestId
        resetPreview()
        return
      }

      const requestId = event.requestId ?? null
      if (activeRequestId !== undefined && requestId !== activeRequestId) return
      activeRequestId = requestId

      if (event.delta.length === 0) return
      if (event.type === 'thinking_delta') {
        retainedThinking = appendBoundedTail(
          retainedThinking,
          event.delta,
          maxTailChars,
        )
      } else {
        retainedText = appendBoundedTail(
          retainedText,
          event.delta,
          maxTailChars,
        )
      }

      if (!hasPublishedFirstContent) {
        if (
          retainedThinking.trim().length === 0 &&
          retainedText.trim().length === 0
        )
          return
        hasPublishedFirstContent = true
        publishRetainedContent()
        return
      }

      schedulePublish(turn)
    },

    clearPreview(turn) {
      if (destroyed || activeTurn !== turn) return
      resetPreview(true)
    },

    endTurn(turn) {
      if (destroyed || activeTurn !== turn) return
      activeTurn = null
      resetPreview(true)
    },

    destroy() {
      if (destroyed) return
      destroyed = true
      activeTurn = null
      activeRequestId = undefined
      generation += 1
      cancelPendingPublish()
      retainedThinking = ''
      retainedText = ''
      snapshot = EMPTY_SNAPSHOT
      listeners.clear()
    },
  }
}
