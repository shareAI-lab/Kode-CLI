import { useCallback, useEffect, useRef, useState } from 'react'
import { getHistoryWithPastes } from '#core/history'
import type { PromptMode } from '#ui-ink/components/PromptInput/types'

const HISTORY_PRELOAD_DELAY_MS = 100

type HistoryEntryWithPastes = {
  display: string
  pastedTexts: Array<{ placeholder: string; text: string }>
}

export type ArrowKeyHistorySnapshot<Extra> = {
  text: string
  mode: PromptMode
  cursorOffset: number
  extra: Extra
}

export function parsePromptHistoryDisplay(display: string): {
  text: string
  mode: PromptMode
} {
  if (display.startsWith('&')) {
    return { mode: 'background', text: display.slice(1) }
  }
  if (display.startsWith('#')) {
    return { mode: 'prompt', text: `/note ${display.slice(1)}` }
  }
  return { mode: 'prompt', text: display }
}

export function useArrowKeyHistory<Extra>(args: {
  current: ArrowKeyHistorySnapshot<Extra>
  emptyExtra: Extra
  historyScopeKey?: string
  loadHistory?: () => HistoryEntryWithPastes[]
  onRestore: (snapshot: ArrowKeyHistorySnapshot<Extra>) => void
  buildExtraFromHistoryEntry?: (entry: HistoryEntryWithPastes) => Extra
}) {
  const {
    current,
    emptyExtra,
    historyScopeKey,
    loadHistory = getHistoryWithPastes,
    onRestore,
    buildExtraFromHistoryEntry,
  } = args

  const [historyIndex, setHistoryIndex] = useState(0)
  const historyIndexRef = useRef(0)
  historyIndexRef.current = historyIndex

  const draftSnapshotRef = useRef<ArrowKeyHistorySnapshot<Extra> | null>(null)
  const historySnapshotRef = useRef<HistoryEntryWithPastes[] | null>(null)
  const preloadTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const currentRef = useRef(current)
  currentRef.current = current
  const loadHistoryRef = useRef(loadHistory)
  loadHistoryRef.current = loadHistory

  const loadHistorySnapshot = useCallback(() => {
    try {
      return loadHistoryRef.current()
    } catch {
      return []
    }
  }, [])

  const clearPreloadTimer = useCallback(() => {
    if (!preloadTimerRef.current) return
    clearTimeout(preloadTimerRef.current)
    preloadTimerRef.current = null
  }, [])

  const scheduleHistoryPreload = useCallback(() => {
    clearPreloadTimer()
    preloadTimerRef.current = setTimeout(() => {
      preloadTimerRef.current = null
      if (historySnapshotRef.current) return
      historySnapshotRef.current = loadHistorySnapshot()
    }, HISTORY_PRELOAD_DELAY_MS)
  }, [clearPreloadTimer, loadHistorySnapshot])

  useEffect(() => {
    historyIndexRef.current = 0
    setHistoryIndex(0)
    draftSnapshotRef.current = null
    historySnapshotRef.current = null
    scheduleHistoryPreload()

    return clearPreloadTimer
  }, [clearPreloadTimer, historyScopeKey, scheduleHistoryPreload])

  const getHistorySnapshot = () => {
    if (!historySnapshotRef.current) {
      historySnapshotRef.current = loadHistorySnapshot()
    }
    return historySnapshotRef.current
  }

  const updateFromHistoryEntry = (
    entry: HistoryEntryWithPastes | undefined,
    cursor: 'start' | 'end',
  ) => {
    if (entry === undefined) return
    const { mode, text } = parsePromptHistoryDisplay(entry.display)
    onRestore({
      text,
      mode,
      cursorOffset: cursor === 'start' ? 0 : text.length,
      extra: buildExtraFromHistoryEntry
        ? buildExtraFromHistoryEntry(entry)
        : emptyExtra,
    })
  }

  function onHistoryUp() {
    const latestHistory = getHistorySnapshot()
    const prev = historyIndexRef.current
    if (prev >= latestHistory.length) return

    if (prev === 0) draftSnapshotRef.current = currentRef.current
    updateFromHistoryEntry(latestHistory[prev], 'start')

    const next = prev + 1
    historyIndexRef.current = next
    setHistoryIndex(next)
  }

  function onHistoryDown() {
    const latestHistory = getHistorySnapshot()
    const prev = historyIndexRef.current
    if (prev > 1) {
      const next = prev - 1
      updateFromHistoryEntry(latestHistory[next - 1], 'end')
      historyIndexRef.current = next
      setHistoryIndex(next)
      return
    }

    if (prev === 1) {
      onRestore(draftSnapshotRef.current ?? currentRef.current)
      draftSnapshotRef.current = null
      historyIndexRef.current = 0
      setHistoryIndex(0)
      return
    }
  }

  const onUserInput = useCallback(() => {
    if (historyIndexRef.current === 0) return
    historyIndexRef.current = 0
    draftSnapshotRef.current = null
    historySnapshotRef.current = null
    scheduleHistoryPreload()
    setHistoryIndex(0)
  }, [scheduleHistoryPreload])

  function resetHistory() {
    historyIndexRef.current = 0
    setHistoryIndex(0)
    draftSnapshotRef.current = null
    historySnapshotRef.current = null
    scheduleHistoryPreload()
  }

  return {
    historyIndex,
    setHistoryIndex,
    onHistoryUp,
    onHistoryDown,
    onUserInput,
    resetHistory,
  }
}

export function __parsePromptHistoryDisplayForTests(
  display: string,
): ReturnType<typeof parsePromptHistoryDisplay> {
  return parsePromptHistoryDisplay(display)
}
