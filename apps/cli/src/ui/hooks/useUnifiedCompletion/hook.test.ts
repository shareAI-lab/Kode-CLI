import { describe, expect, test } from 'bun:test'

import {
  __computeCompletionActivationForTests,
  __computeCompletionRefreshForTests,
  __shouldGenerateCompletionRefreshSuggestionsForTests,
  __shouldLoadMentionSuggestionsForTests,
} from './hook'
import type {
  CompletionContext,
  UnifiedSuggestion,
} from '#cli-utils/completion/types'
import type { CompletionState } from './types'

function makeState(overrides: Partial<CompletionState>): CompletionState {
  return {
    suggestions: [],
    selectedIndex: 0,
    isActive: false,
    context: null,
    preview: null,
    emptyDirMessage: '',
    suppressUntil: 0,
    ...overrides,
  }
}

const commandContext: CompletionContext = {
  type: 'command',
  prefix: '/h',
  startPos: 0,
  endPos: 2,
  trigger: '/',
}

const commandSuggestions: UnifiedSuggestion[] = [
  { value: 'help', displayValue: 'help', type: 'command', score: 10 },
  {
    value: 'history',
    displayValue: 'history',
    type: 'command',
    score: 9,
  },
]

describe('__computeCompletionActivationForTests', () => {
  test('does not reset selection for the same active completion list', () => {
    const result = __computeCompletionActivationForTests({
      state: makeState({
        isActive: true,
        context: commandContext,
        suggestions: commandSuggestions,
        selectedIndex: 1,
      }),
      context: commandContext,
      suggestions: commandSuggestions,
    })

    expect(result.action).toBe('none')
  })

  test('starts from the first suggestion when the completion context changes', () => {
    const result = __computeCompletionActivationForTests({
      state: makeState({
        isActive: true,
        context: commandContext,
        suggestions: commandSuggestions,
        selectedIndex: 1,
      }),
      context: {
        ...commandContext,
        prefix: '/hi',
        endPos: 3,
      },
      suggestions: commandSuggestions,
    })

    expect(result.action).toBe('activate')
    if (result.action !== 'activate') return
    expect(result.selectedIndex).toBe(0)
  })
})

describe('__computeCompletionRefreshForTests', () => {
  test('refreshes active loading suggestions when new command matches arrive', () => {
    const state = makeState({
      isActive: true,
      context: {
        type: 'file',
        prefix: 'kub',
        startPos: 0,
        endPos: 3,
      },
      suggestions: [
        {
          value: 'loading...',
          displayValue: 'Loading system commands...',
          type: 'file',
          score: 0,
          metadata: { isLoading: true },
        },
      ],
    })

    const result = __computeCompletionRefreshForTests({
      isEnabled: true,
      state,
      suggestions: [
        {
          value: 'kubectl',
          displayValue: '$ kubectl',
          type: 'command',
          score: 100,
        },
      ],
    })

    expect(result.action).toBe('refresh')
    if (result.action !== 'refresh') return
    expect(result.suggestions[0]?.value).toBe('kubectl')
    expect(result.selectedIndex).toBe(0)
  })

  test('does not refresh while a completion preview is active', () => {
    const result = __computeCompletionRefreshForTests({
      isEnabled: true,
      state: makeState({
        isActive: true,
        context: {
          type: 'file',
          prefix: 'gi',
          startPos: 0,
          endPos: 2,
        },
        preview: {
          isActive: true,
          originalInput: 'gi',
          wordRange: [0, 3],
        },
      }),
      suggestions: [
        {
          value: 'git',
          displayValue: '$ git',
          type: 'command',
          score: 100,
        },
      ],
    })

    expect(result.action).toBe('none')
  })
})

describe('__shouldGenerateCompletionRefreshSuggestionsForTests', () => {
  test('avoids rebuilding suggestions while the panel is inactive', () => {
    expect(
      __shouldGenerateCompletionRefreshSuggestionsForTests({
        isEnabled: true,
        isActive: false,
        context: commandContext,
        isPreviewActive: false,
      }),
    ).toBe(false)
  })

  test('avoids rebuilding suggestions while a preview is active', () => {
    expect(
      __shouldGenerateCompletionRefreshSuggestionsForTests({
        isEnabled: true,
        isActive: true,
        context: commandContext,
        isPreviewActive: true,
      }),
    ).toBe(false)
  })

  test('refreshes only active, non-preview completion panels', () => {
    expect(
      __shouldGenerateCompletionRefreshSuggestionsForTests({
        isEnabled: true,
        isActive: true,
        context: commandContext,
        isPreviewActive: false,
      }),
    ).toBe(true)
  })
})

describe('__shouldLoadMentionSuggestionsForTests', () => {
  test('does not load mention providers for ordinary prompt text', () => {
    expect(
      __shouldLoadMentionSuggestionsForTests({
        isEnabled: true,
        currentContext: {
          type: 'file',
          prefix: 'hello',
          startPos: 0,
          endPos: 5,
          trigger: null,
        },
        activeContext: null,
      }),
    ).toBe(false)
  })

  test('loads mention providers only after agent mention context appears', () => {
    expect(
      __shouldLoadMentionSuggestionsForTests({
        isEnabled: true,
        currentContext: {
          type: 'agent',
          prefix: 'run-agent',
          startPos: 0,
          endPos: 10,
          trigger: '@',
        },
        activeContext: null,
      }),
    ).toBe(true)
  })

  test('keeps mention providers enabled while an agent completion panel is active', () => {
    expect(
      __shouldLoadMentionSuggestionsForTests({
        isEnabled: true,
        currentContext: null,
        activeContext: {
          type: 'agent',
          prefix: '',
          startPos: 0,
          endPos: 1,
          trigger: '@',
        },
      }),
    ).toBe(true)
  })

  test('does not load mention providers when completion is disabled', () => {
    expect(
      __shouldLoadMentionSuggestionsForTests({
        isEnabled: false,
        currentContext: {
          type: 'agent',
          prefix: '',
          startPos: 0,
          endPos: 1,
          trigger: '@',
        },
        activeContext: null,
      }),
    ).toBe(false)
  })
})
