import { useEffect, useRef, useState } from 'react'

import type {
  CompletionContext,
  UnifiedSuggestion,
} from '#cli-utils/completion/types'
import type { CompletionState } from './types'

function shouldAutoTrigger(context: CompletionContext): boolean {
  switch (context.type) {
    case 'command':
    case 'agent':
      return true
    case 'file': {
      const prefix = context.prefix
      if (
        prefix.startsWith('./') ||
        prefix.startsWith('../') ||
        prefix.startsWith('/') ||
        prefix.startsWith('~') ||
        prefix.includes('/')
      ) {
        return true
      }
      if (prefix.startsWith('.') && prefix.length >= 2) {
        return true
      }
      return false
    }
    default:
      return false
  }
}

export function __computeAutoTriggerActionForTests(args: {
  input: string
  previousInput: string
  now: number
  lastInputTime: number
  forceRefresh?: boolean
  isEnabled: boolean
  state: CompletionState
  context: CompletionContext | null
  generateSuggestions: (context: CompletionContext) => UnifiedSuggestion[]
}): {
  nextLastInput: string
  nextLastInputTime: number
  action: 'none' | 'reset' | 'activate'
  suggestions?: UnifiedSuggestion[]
  context?: CompletionContext
} {
  if (args.previousInput === args.input && !args.forceRefresh) {
    return {
      nextLastInput: args.previousInput,
      nextLastInputTime: args.lastInputTime,
      action: 'none',
    }
  }

  if (!args.isEnabled) {
    return {
      nextLastInput: args.input,
      nextLastInputTime: args.lastInputTime,
      action: args.state.isActive ? 'reset' : 'none',
    }
  }

  // IME composition produces bursts of small, fast edits. A time-only
  // heuristic misfires when users type ASCII quickly (e.g. "/cmd" right after
  // a CJK sentence), which kept the completion panel from ever opening. Detect
  // composition by content instead: only edits introducing non-ASCII text are
  // treated as potentially IME-driven.
  const isPossiblyIMEInput = /[^\x00-\x7f]/.test(args.input)

  const inputLengthChange = Math.abs(
    args.input.length - args.previousInput.length,
  )
  const isHistoryNavigation =
    (inputLengthChange > 10 ||
      (inputLengthChange > 5 &&
        !args.input.includes(args.previousInput.slice(-5)))) &&
    args.input !== args.previousInput

  const shouldAutoHideSingleMatch = (
    suggestion: UnifiedSuggestion,
    context: CompletionContext,
  ): boolean => {
    const currentInput = args.input.slice(context.startPos, context.endPos)

    if (context.type === 'file') {
      if (suggestion.value.endsWith('/')) return false
      if (currentInput === suggestion.value) return true
      if (
        currentInput.endsWith('/' + suggestion.value) ||
        currentInput.endsWith(suggestion.value)
      ) {
        return true
      }
      return false
    }

    if (context.type === 'command') {
      return currentInput === `/${suggestion.value}`
    }

    if (context.type === 'agent') {
      return currentInput === `@${suggestion.value}`
    }

    return false
  }

  const nextLastInputTime = args.now
  const nextLastInput = args.input

  if (args.state.preview?.isActive || args.now < args.state.suppressUntil) {
    return { nextLastInput, nextLastInputTime, action: 'none' }
  }

  if (isHistoryNavigation && args.state.isActive) {
    return { nextLastInput, nextLastInputTime, action: 'reset' }
  }

  // 立即关闭补全面板如果 context 不存在但面板仍然激活
  // 这解决了删除 "/" 或 "@" 后补全面板不关闭的问题
  if (!args.context && args.state.isActive) {
    return { nextLastInput, nextLastInputTime, action: 'reset' }
  }

  // 如果可能是 IME 输入且面板未激活，暂时不触发补全
  // 这可以减少中文输入时的干扰
  if (isPossiblyIMEInput && !args.state.isActive) {
    return { nextLastInput, nextLastInputTime, action: 'none' }
  }

  if (args.context && shouldAutoTrigger(args.context)) {
    const newSuggestions = args.generateSuggestions(args.context)

    if (newSuggestions.length === 0) {
      return { nextLastInput, nextLastInputTime, action: 'reset' }
    }

    if (
      newSuggestions.length === 1 &&
      shouldAutoHideSingleMatch(newSuggestions[0]!, args.context)
    ) {
      return { nextLastInput, nextLastInputTime, action: 'reset' }
    }

    return {
      nextLastInput,
      nextLastInputTime,
      action: 'activate',
      suggestions: newSuggestions,
      context: args.context,
    }
  }

  if (args.state.context) {
    const current = args.context
    const previous = args.state.context
    const contextChanged =
      !current ||
      previous.type !== current.type ||
      previous.startPos !== current.startPos ||
      !current.prefix.startsWith(previous.prefix)

    if (contextChanged) {
      return { nextLastInput, nextLastInputTime, action: 'reset' }
    }
  }

  return { nextLastInput, nextLastInputTime, action: 'none' }
}

export function __getSuppressWakeDelayForTests(args: {
  isEnabled: boolean
  now: number
  suppressUntil: number
}): number | null {
  if (!args.isEnabled) return null
  if (args.suppressUntil <= 0) return null
  const delay = args.suppressUntil - args.now
  return delay > 0 ? delay : null
}

export function useUnifiedCompletionAutoTrigger(args: {
  input: string
  cursorOffset: number
  state: CompletionState
  getWordAtCursor: () => CompletionContext | null
  generateSuggestions: (context: CompletionContext) => UnifiedSuggestion[]
  activateCompletion: (
    suggestions: UnifiedSuggestion[],
    context: CompletionContext,
  ) => void
  resetCompletion: () => void
  isEnabled: boolean
}): void {
  const lastInputRef = useRef('')
  const lastInputTimeRef = useRef(0)
  const handledSuppressWakeTickRef = useRef(0)
  const [suppressWakeTick, setSuppressWakeTick] = useState(0)
  const latestArgsRef = useRef(args)
  latestArgsRef.current = args
  const { input, cursorOffset, isEnabled } = args
  const { isActive, suppressUntil } = args.state

  useEffect(() => {
    const delay = __getSuppressWakeDelayForTests({
      isEnabled,
      now: Date.now(),
      suppressUntil,
    })
    if (delay === null) return undefined

    const timeout = setTimeout(() => {
      setSuppressWakeTick(tick => tick + 1)
    }, delay)

    return () => clearTimeout(timeout)
  }, [isEnabled, suppressUntil])

  useEffect(() => {
    const currentArgs = latestArgsRef.current
    const now = Date.now()
    const context = currentArgs.getWordAtCursor()
    const hasUnhandledSuppressWake =
      suppressWakeTick !== handledSuppressWakeTickRef.current
    const forceRefresh =
      hasUnhandledSuppressWake &&
      currentArgs.state.suppressUntil > 0 &&
      now >= currentArgs.state.suppressUntil &&
      lastInputRef.current === currentArgs.input
    if (hasUnhandledSuppressWake && now >= currentArgs.state.suppressUntil) {
      handledSuppressWakeTickRef.current = suppressWakeTick
    }
    const result = __computeAutoTriggerActionForTests({
      input: currentArgs.input,
      previousInput: lastInputRef.current,
      now,
      lastInputTime: lastInputTimeRef.current,
      forceRefresh,
      isEnabled: currentArgs.isEnabled,
      state: currentArgs.state,
      context,
      generateSuggestions: currentArgs.generateSuggestions,
    })

    lastInputRef.current = result.nextLastInput
    lastInputTimeRef.current = result.nextLastInputTime

    if (result.action === 'reset') {
      currentArgs.resetCompletion()
      return
    }

    if (result.action === 'activate' && result.suggestions && result.context) {
      currentArgs.activateCompletion(result.suggestions, result.context)
    }
  }, [
    cursorOffset,
    input,
    isActive,
    isEnabled,
    suppressUntil,
    suppressWakeTick,
  ])
}
