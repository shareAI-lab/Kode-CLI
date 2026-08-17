import { useCallback, useEffect, useState } from 'react'
import { getCwd } from '#core/utils/state'
import { getCompletionContext } from '#cli-utils/completion/context'
import { generateSuggestionsForContext } from '#cli-utils/completion/generateSuggestions'
import type {
  CompletionContext,
  UnifiedSuggestion,
} from '#cli-utils/completion/types'

import type { CompletionState, UnifiedCompletionProps } from './types'
import { INITIAL_STATE } from './types'
import { useAgentSuggestions } from './useAgentSuggestions'
import { useCompletionActions } from './actions'
import { useModelSuggestions } from './useModelSuggestions'
import { useSystemCommands } from './useSystemCommands'
import { useUnifiedCompletionAutoTrigger } from './useAutoTrigger'
import { useUnifiedCompletionTabKey } from './useTabKey'
import { useUnifiedCompletionNavigationKeys } from './useNavigationKeys'

function areCompletionContextsEqual(
  a: CompletionContext | null,
  b: CompletionContext | null,
): boolean {
  if (a === b) return true
  if (!a || !b) return false
  return (
    a.type === b.type &&
    a.prefix === b.prefix &&
    a.startPos === b.startPos &&
    a.endPos === b.endPos &&
    a.trigger === b.trigger
  )
}

function getSuggestionMetadataKey(suggestion: UnifiedSuggestion): string {
  const metadata = suggestion.metadata
  if (!metadata || typeof metadata !== 'object') return ''
  return [
    metadata.isLoading ? 'loading' : '',
    metadata.isUnixCommand ? 'unix' : '',
    typeof metadata.color === 'string' ? metadata.color : '',
    typeof metadata.modelId === 'string' ? metadata.modelId : '',
  ].join('|')
}

function areSuggestionsEqual(
  a: UnifiedSuggestion[],
  b: UnifiedSuggestion[],
): boolean {
  if (a === b) return true
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    const left = a[i]
    const right = b[i]
    if (!left || !right) return false
    if (
      left.value !== right.value ||
      left.displayValue !== right.displayValue ||
      left.type !== right.type ||
      left.description !== right.description ||
      left.icon !== right.icon ||
      left.score !== right.score ||
      left.isSmartMatch !== right.isSmartMatch ||
      left.originalContext !== right.originalContext ||
      getSuggestionMetadataKey(left) !== getSuggestionMetadataKey(right)
    ) {
      return false
    }
  }
  return true
}

export function __getCompletionContextForTests(args: {
  input: string
  cursorOffset: number
  disableSlashCommands?: boolean
}): CompletionContext | null {
  return getCompletionContext(args)
}

export function __computeCompletionRefreshForTests(args: {
  isEnabled: boolean
  state: Pick<CompletionState, 'context' | 'isActive' | 'selectedIndex'> & {
    preview: Pick<NonNullable<CompletionState['preview']>, 'isActive'> | null
  }
  suggestions: UnifiedSuggestion[]
}):
  | { action: 'none' }
  | { action: 'reset' }
  | {
      action: 'refresh'
      suggestions: UnifiedSuggestion[]
      selectedIndex: number
    } {
  if (!args.isEnabled || !args.state.isActive || !args.state.context) {
    return { action: 'none' }
  }
  if (args.state.preview?.isActive) return { action: 'none' }
  if (args.suggestions.length === 0) return { action: 'reset' }

  return {
    action: 'refresh',
    suggestions: args.suggestions,
    selectedIndex: Math.min(
      args.state.selectedIndex,
      args.suggestions.length - 1,
    ),
  }
}

export function __shouldGenerateCompletionRefreshSuggestionsForTests(args: {
  isEnabled: boolean
  isActive: boolean
  context: CompletionContext | null
  isPreviewActive: boolean
}): boolean {
  return Boolean(
    args.isEnabled && args.isActive && args.context && !args.isPreviewActive,
  )
}

export function __computeCompletionActivationForTests(args: {
  state: CompletionState
  suggestions: UnifiedSuggestion[]
  context: CompletionContext
}):
  | { action: 'none' }
  | {
      action: 'activate'
      suggestions: UnifiedSuggestion[]
      selectedIndex: number
      context: CompletionContext
    } {
  const sameActiveCompletion =
    args.state.isActive &&
    args.state.preview === null &&
    areCompletionContextsEqual(args.state.context, args.context) &&
    areSuggestionsEqual(args.state.suggestions, args.suggestions)

  if (sameActiveCompletion) {
    return { action: 'none' }
  }

  return {
    action: 'activate',
    suggestions: args.suggestions,
    selectedIndex: 0,
    context: args.context,
  }
}

export function __shouldLoadMentionSuggestionsForTests(args: {
  isEnabled: boolean
  currentContext: CompletionContext | null
  activeContext: CompletionContext | null
}): boolean {
  if (!args.isEnabled) return false
  return (
    args.currentContext?.type === 'agent' ||
    args.activeContext?.type === 'agent'
  )
}

export function useUnifiedCompletion({
  input,
  cursorOffset,
  onInputChange,
  setCursorOffset,
  commands,
  disableSlashCommands = false,
  isEnabled = true,
  modelReloadKey = 0,
}: UnifiedCompletionProps) {
  const [state, setState] = useState<CompletionState>(INITIAL_STATE)

  const updateState = useCallback((updates: Partial<CompletionState>) => {
    setState(prev => {
      const next = { ...prev, ...updates }
      const suggestionsUnchanged =
        updates.suggestions === undefined ||
        areSuggestionsEqual(prev.suggestions, next.suggestions)
      const contextUnchanged =
        updates.context === undefined ||
        areCompletionContextsEqual(prev.context, next.context)

      if (
        suggestionsUnchanged &&
        contextUnchanged &&
        prev.selectedIndex === next.selectedIndex &&
        prev.isActive === next.isActive &&
        prev.preview === next.preview &&
        prev.emptyDirMessage === next.emptyDirMessage &&
        prev.suppressUntil === next.suppressUntil
      ) {
        return prev
      }

      return next
    })
  }, [])

  const resetCompletion = useCallback(() => {
    setState(prev => {
      if (
        prev.suggestions.length === 0 &&
        prev.selectedIndex === 0 &&
        !prev.isActive &&
        prev.context === null &&
        prev.preview === null &&
        prev.emptyDirMessage === ''
      ) {
        return prev
      }

      return {
        ...prev,
        suggestions: [],
        selectedIndex: 0,
        isActive: false,
        context: null,
        preview: null,
        emptyDirMessage: '',
      }
    })
  }, [])

  const activateCompletion = useCallback(
    (suggestions: UnifiedSuggestion[], context: CompletionContext) => {
      setState(prev => {
        const result = __computeCompletionActivationForTests({
          state: prev,
          suggestions,
          context,
        })

        if (result.action === 'none') {
          return prev
        }

        return {
          ...prev,
          suggestions: result.suggestions,
          selectedIndex: result.selectedIndex,
          isActive: true,
          context: result.context,
          preview: null,
        }
      })
    },
    [],
  )

  const getWordAtCursor = useCallback((): CompletionContext | null => {
    return __getCompletionContextForTests({
      input,
      cursorOffset,
      disableSlashCommands,
    })
  }, [input, cursorOffset, disableSlashCommands])

  const { systemCommands, isLoadingCommands } = useSystemCommands()
  const currentCompletionContext = getWordAtCursor()
  const shouldLoadMentionSuggestions = __shouldLoadMentionSuggestionsForTests({
    isEnabled,
    currentContext: currentCompletionContext,
    activeContext: state.context,
  })
  const {
    suggestions: agentSuggestions,
    isLoading: isLoadingAgentSuggestions,
  } = useAgentSuggestions({ enabled: shouldLoadMentionSuggestions })
  const {
    suggestions: modelSuggestions,
    isLoading: isLoadingModelSuggestions,
  } = useModelSuggestions({
    enabled: shouldLoadMentionSuggestions,
    reloadKey: modelReloadKey,
  })

  const generateSuggestions = useCallback(
    (context: CompletionContext): UnifiedSuggestion[] =>
      generateSuggestionsForContext({
        context,
        commands,
        agentSuggestions,
        modelSuggestions,
        isLoadingMentionSuggestions:
          isLoadingAgentSuggestions || isLoadingModelSuggestions,
        systemCommands,
        isLoadingCommands,
        cwd: getCwd(),
      }),
    [
      commands,
      agentSuggestions,
      modelSuggestions,
      isLoadingAgentSuggestions,
      isLoadingModelSuggestions,
      systemCommands,
      isLoadingCommands,
    ],
  )

  const { completeWith } = useCompletionActions({
    input,
    onInputChange,
    setCursorOffset,
  })

  useEffect(() => {
    if (!isEnabled && state.isActive) {
      resetCompletion()
    }
  }, [isEnabled, resetCompletion, state.isActive])

  const isCompletionPreviewActive = state.preview?.isActive ?? false
  useEffect(() => {
    if (
      !__shouldGenerateCompletionRefreshSuggestionsForTests({
        isEnabled,
        isActive: state.isActive,
        context: state.context,
        isPreviewActive: isCompletionPreviewActive,
      })
    ) {
      return
    }

    const nextSuggestions = generateSuggestions(state.context!)
    const result = __computeCompletionRefreshForTests({
      isEnabled,
      state: {
        context: state.context,
        isActive: state.isActive,
        preview: isCompletionPreviewActive ? { isActive: true } : null,
        selectedIndex: state.selectedIndex,
      },
      suggestions: nextSuggestions,
    })

    if (result.action === 'reset') {
      resetCompletion()
      return
    }

    if (result.action === 'refresh') {
      setState(prev => {
        if (
          prev.selectedIndex === result.selectedIndex &&
          areSuggestionsEqual(prev.suggestions, result.suggestions)
        ) {
          return prev
        }

        return {
          ...prev,
          suggestions: result.suggestions,
          selectedIndex: result.selectedIndex,
        }
      })
    }
  }, [
    generateSuggestions,
    isEnabled,
    resetCompletion,
    state.context,
    state.isActive,
    state.selectedIndex,
    isCompletionPreviewActive,
  ])

  useUnifiedCompletionTabKey({
    input,
    state,
    getWordAtCursor,
    generateSuggestions,
    completeWith,
    activateCompletion,
    resetCompletion,
    updateState,
    onInputChange,
    setCursorOffset,
    isEnabled,
  })

  useUnifiedCompletionNavigationKeys({
    input,
    state,
    resetCompletion,
    updateState,
    generateSuggestions,
    completeWith,
    activateCompletion,
    onInputChange,
    setCursorOffset,
    isEnabled,
  })

  useUnifiedCompletionAutoTrigger({
    input,
    cursorOffset,
    state,
    getWordAtCursor,
    generateSuggestions,
    activateCompletion,
    resetCompletion,
    isEnabled,
  })

  return {
    suggestions: state.suggestions,
    selectedIndex: state.selectedIndex,
    isActive: state.isActive && isEnabled,
    emptyDirMessage: state.emptyDirMessage,
    activeContext: state.context,
    resetCompletion,
  }
}
