import { useEffect, useRef, useState } from 'react'
import { BunShell } from '#runtime/shell'
import { getStatusLineConfig } from '#core/services/statusline'
import { getBackgroundTaskCounts } from '#core/tasks/backgroundRegistry'

type StatusLineState = {
  text: string | null
  padding: number
  isConfigured: boolean
}

function serializeStatusLineInput(value: unknown): string {
  try {
    return JSON.stringify(value ?? {}, null, 0) + '\n'
  } catch {
    return '{}\n'
  }
}

export function normalizeStatusLineOutput(raw: string): string | null {
  const firstLine = raw
    .split(/\r?\n/)
    .map(line => line.trim())
    .find(line => line.length > 0)

  return firstLine ?? null
}

export const STATUS_LINE_BASE_INTERVAL_MS = 1_000
export const STATUS_LINE_GROW_STREAK = 2
export const STATUS_LINE_MAX_INTERVAL_MS = 10_000

/**
 * Poll-rate backoff for the status line command: as long as neither the input
 * nor the command output changed, the interval grows (1s to 3s to 9s, capped at
 * 10s) instead of spawning the command at 1 Hz forever. Any input or output
 * change resets the rate to the base interval.
 */
export function nextStatusLineIntervalMs(args: {
  inputChanged: boolean
  outputChanged: boolean
  unchangedStreak: number
  currentMs: number
}): number {
  if (args.inputChanged || args.outputChanged) {
    return STATUS_LINE_BASE_INTERVAL_MS
  }
  if (args.unchangedStreak < STATUS_LINE_GROW_STREAK) {
    return Math.max(STATUS_LINE_BASE_INTERVAL_MS, args.currentMs)
  }
  return Math.min(
    STATUS_LINE_MAX_INTERVAL_MS,
    Math.max(STATUS_LINE_BASE_INTERVAL_MS, args.currentMs * 3),
  )
}

function buildDynamicStatusLineInput(
  baseInput: unknown,
): Record<string, unknown> {
  const base =
    baseInput && typeof baseInput === 'object' && !Array.isArray(baseInput)
      ? (baseInput as Record<string, unknown>)
      : {}

  const existingKode =
    base.kode && typeof base.kode === 'object' && !Array.isArray(base.kode)
      ? (base.kode as Record<string, unknown>)
      : {}

  const tasks = getBackgroundTaskCounts()

  return {
    ...base,
    kode: {
      ...existingKode,
      tasks,
    },
  }
}

function isStatusLineRuntimeEnabled(): boolean {
  return (
    process.env.KODE_STATUSLINE_ENABLED === '1' ||
    process.env.NODE_ENV !== 'test'
  )
}

function getInitialStatusLineState(): StatusLineState {
  if (!isStatusLineRuntimeEnabled()) {
    return { text: null, padding: 0, isConfigured: false }
  }

  try {
    const config = getStatusLineConfig()
    return {
      text: null,
      padding: config?.padding ?? 0,
      isConfigured: Boolean(config?.command),
    }
  } catch {
    return { text: null, padding: 0, isConfigured: false }
  }
}

export function useStatusLine(input?: unknown): {
  text: string | null
  padding: number
  isConfigured: boolean
} {
  const [state, setState] = useState<StatusLineState>(getInitialStatusLineState)
  const lastCommandRef = useRef<string | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const inputRef = useRef<unknown>(input)
  const inputSignatureRef = useRef<string | null>(null)
  const tickRef = useRef<((source?: 'input' | 'interval') => void) | null>(null)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const runningRef = useRef(false)
  const rerunAfterCurrentRef = useRef(false)
  const lastOutputTextRef = useRef<string | null>(null)
  const unchangedStreakRef = useRef(0)
  const nextDelayRef = useRef(STATUS_LINE_BASE_INTERVAL_MS)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    const nextSignature = serializeStatusLineInput(input)
    inputRef.current = input
    if (inputSignatureRef.current === nextSignature) return undefined
    inputSignatureRef.current = nextSignature

    if (!tickRef.current) return undefined
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => {
      tickRef.current?.('input')
    }, 300)

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
      debounceRef.current = null
    }
  }, [input])

  useEffect(() => {
    const enabled = isStatusLineRuntimeEnabled()
    if (!enabled) return undefined

    const shell = BunShell.getInstance()
    let alive = true

    const tick = async (source: 'input' | 'interval' = 'interval') => {
      if (!alive) return
      if (runningRef.current) {
        if (source === 'input') rerunAfterCurrentRef.current = true
        return
      }

      const config = getStatusLineConfig()
      const command = config?.command ?? null
      const padding = config?.padding ?? 0

      if (!command) {
        lastCommandRef.current = null
        abortRef.current?.abort()
        abortRef.current = null
        rerunAfterCurrentRef.current = false
        if (alive) {
          setState(prev =>
            prev.text === null && prev.padding === 0 && !prev.isConfigured
              ? prev
              : { text: null, padding: 0, isConfigured: false },
          )
        }
        // Keep polling so a later config change is picked up.
        scheduleNextInterval(STATUS_LINE_BASE_INTERVAL_MS)
        return
      }

      const commandChanged = lastCommandRef.current !== command
      lastCommandRef.current = command
      const ac = new AbortController()
      abortRef.current = ac
      runningRef.current = true
      const runInputSignature =
        inputSignatureRef.current ?? serializeStatusLineInput(inputRef.current)

      if (alive) {
        setState(prev => {
          const nextText = commandChanged ? null : prev.text
          return prev.text === nextText &&
            prev.padding === padding &&
            prev.isConfigured
            ? prev
            : { text: nextText, padding, isConfigured: true }
        })
      }

      let outputChanged = false
      try {
        const result = await shell.exec(command, ac.signal, 5000, {
          stdin: serializeStatusLineInput(
            buildDynamicStatusLineInput(inputRef.current),
          ),
        })
        if (!alive) return
        if (result.interrupted) return
        if (ac.signal.aborted) return
        if (runInputSignature !== inputSignatureRef.current) {
          rerunAfterCurrentRef.current = true
          return
        }

        const raw = result.code === 0 ? result.stdout : ''
        const next = normalizeStatusLineOutput(raw)
        const text = next || null
        outputChanged = text !== lastOutputTextRef.current
        lastOutputTextRef.current = text
        if (alive) {
          setState(prev =>
            prev.text === text && prev.padding === padding && prev.isConfigured
              ? prev
              : { text, padding, isConfigured: true },
          )
        }
      } finally {
        if (abortRef.current === ac) abortRef.current = null
        runningRef.current = false

        // Schedule the next poll unless the component unmounted.
        if (alive) {
          if (rerunAfterCurrentRef.current) {
            rerunAfterCurrentRef.current = false
            setTimeout(() => {
              if (!alive) return
              tick('input').catch(() => {})
            }, 0)
          } else if (source !== 'interval') {
            // Input-driven ticks reset the poll rate so changes surface quickly.
            unchangedStreakRef.current = 0
            nextDelayRef.current = STATUS_LINE_BASE_INTERVAL_MS
            scheduleNextInterval(STATUS_LINE_BASE_INTERVAL_MS)
          } else {
            // Interval ticks back off while input and output stay unchanged.
            const inputChanged = runInputSignature !== inputSignatureRef.current
            if (inputChanged || outputChanged) {
              unchangedStreakRef.current = 0
            } else {
              unchangedStreakRef.current += 1
            }
            const delay = nextStatusLineIntervalMs({
              inputChanged,
              outputChanged,
              unchangedStreak: unchangedStreakRef.current,
              currentMs: nextDelayRef.current,
            })
            nextDelayRef.current = delay
            scheduleNextInterval(delay)
          }
        }
      }
    }

    const scheduleNextInterval = (delayMs: number) => {
      if (!alive) return
      if (timerRef.current) clearTimeout(timerRef.current)
      timerRef.current = setTimeout(() => {
        timerRef.current = null
        tickRef.current?.('interval')
      }, delayMs)
    }

    tickRef.current = source => {
      tick(source).catch(() => {})
    }

    tick().catch(() => {})

    return () => {
      alive = false
      abortRef.current?.abort()
      tickRef.current = null
      runningRef.current = false
      rerunAfterCurrentRef.current = false
      if (timerRef.current) {
        clearTimeout(timerRef.current)
        timerRef.current = null
      }
    }
  }, [])

  return state
}
