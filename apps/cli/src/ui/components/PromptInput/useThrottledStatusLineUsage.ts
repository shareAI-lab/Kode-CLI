import { useEffect, useRef, useState } from 'react'
import type { Message } from '#core/query'
import {
  getPromptStatusLineUsage,
  type PromptStatusLineUsage,
} from './statusLineModel'

export const STATUS_LINE_USAGE_UPDATE_INTERVAL_MS = 500

function isSameAssistantUsage(
  first: PromptStatusLineUsage['currentUsage'],
  second: PromptStatusLineUsage['currentUsage'],
): boolean {
  return (
    first === second ||
    (first !== null &&
      second !== null &&
      first.input_tokens === second.input_tokens &&
      first.output_tokens === second.output_tokens &&
      first.cache_creation_input_tokens ===
        second.cache_creation_input_tokens &&
      first.cache_read_input_tokens === second.cache_read_input_tokens)
  )
}

export function arePromptStatusLineUsagesEqual(
  first: PromptStatusLineUsage,
  second: PromptStatusLineUsage,
): boolean {
  return (
    first.totalInputTokens === second.totalInputTokens &&
    first.totalOutputTokens === second.totalOutputTokens &&
    first.totalCostUSD === second.totalCostUSD &&
    isSameAssistantUsage(first.currentUsage, second.currentUsage)
  )
}

export function useThrottledStatusLineUsage(
  messages: Message[],
  intervalMs = STATUS_LINE_USAGE_UPDATE_INTERVAL_MS,
): PromptStatusLineUsage {
  const latestMessagesRef = useRef(messages)
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const didMountRef = useRef(false)
  const [usage, setUsage] = useState(() => getPromptStatusLineUsage(messages))

  useEffect(() => {
    latestMessagesRef.current = messages
    if (!didMountRef.current) {
      didMountRef.current = true
      return
    }
    if (timeoutRef.current) return

    timeoutRef.current = setTimeout(
      () => {
        timeoutRef.current = null
        const next = getPromptStatusLineUsage(latestMessagesRef.current)
        setUsage(previous =>
          arePromptStatusLineUsagesEqual(previous, next) ? previous : next,
        )
      },
      Math.max(0, intervalMs),
    )
  }, [intervalMs, messages])

  useEffect(() => {
    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current)
        timeoutRef.current = null
      }
    }
  }, [])

  return usage
}
