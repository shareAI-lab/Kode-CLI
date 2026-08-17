import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

type UndoEntry<TExtra> = {
  signature: string
  text: string
  cursorOffset: number
  extra: TExtra
  timestamp: number
}

type UndoBufferState<TExtra> = {
  entries: UndoEntry<TExtra>[]
  cursor: number
}

export function useUndoBuffer<TExtra>(args: {
  maxBufferSize: number
  debounceMs: number
}) {
  const { maxBufferSize, debounceMs } = args

  const [state, setState] = useState<UndoBufferState<TExtra>>({
    entries: [],
    cursor: -1,
  })
  const stateRef = useRef(state)
  useEffect(() => {
    stateRef.current = state
  }, [state])

  const pendingRef = useRef<Omit<UndoEntry<TExtra>, 'timestamp'> | null>(null)
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lastPushAtRef = useRef(0)

  const flushPending = useCallback(() => {
    const pending = pendingRef.current
    if (!pending) return

    const timestamp = Date.now()
    lastPushAtRef.current = timestamp
    pendingRef.current = null

    setState(prev => {
      const base =
        prev.cursor >= 0 ? prev.entries.slice(0, prev.cursor + 1) : prev.entries

      const last = base[base.length - 1]
      if (last && last.signature === pending.signature) {
        return { ...prev, cursor: base.length - 1, entries: base }
      }

      const next = [...base, { ...pending, timestamp }]
      const clipped =
        next.length > maxBufferSize ? next.slice(-maxBufferSize) : next
      return { entries: clipped, cursor: clipped.length - 1 }
    })
  }, [maxBufferSize])

  const pushToBuffer = useCallback(
    (entry: Omit<UndoEntry<TExtra>, 'timestamp'>) => {
      pendingRef.current = entry

      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current)
        timeoutRef.current = null
      }

      const now = Date.now()
      // The very first entry establishes the undo baseline. If it were
      // debounced, a fast first burst would collapse into a single entry and
      // Ctrl+_ could not step back through it.
      const bufferEmpty =
        stateRef.current.entries.length === 0 && stateRef.current.cursor === -1
      if (!bufferEmpty && now - lastPushAtRef.current < debounceMs) {
        timeoutRef.current = setTimeout(() => {
          timeoutRef.current = null
          flushPending()
        }, debounceMs)
        return
      }

      flushPending()
    },
    [debounceMs, flushPending],
  )

  const undo = useCallback((): UndoEntry<TExtra> | null => {
    const current = stateRef.current
    if (current.cursor <= 0 || current.entries.length === 0) return null

    const nextCursor = current.cursor - 1
    const snapshot = current.entries[nextCursor] ?? null
    setState({ ...current, cursor: nextCursor })
    return snapshot
  }, [])

  const clearBuffer = useCallback(() => {
    pendingRef.current = null
    lastPushAtRef.current = 0
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current)
      timeoutRef.current = null
    }
    setState({ entries: [], cursor: -1 })
  }, [])

  useEffect(() => {
    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current)
        timeoutRef.current = null
      }
    }
  }, [])

  const canUndo = useMemo(
    () => state.cursor > 0 && state.entries.length > 1,
    [state.cursor, state.entries.length],
  )

  return {
    pushToBuffer,
    undo,
    canUndo,
    clearBuffer,
  }
}
