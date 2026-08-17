import { describe, expect, test } from 'bun:test'

import {
  __computeAutoTriggerActionForTests,
  __getSuppressWakeDelayForTests,
} from './useAutoTrigger'

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

describe('__computeAutoTriggerActionForTests', () => {
  test('closes active panel when context disappears (e.g. deleting "/")', () => {
    const prevContext: CompletionContext = {
      type: 'command',
      prefix: '/',
      startPos: 0,
      endPos: 1,
    }

    const result = __computeAutoTriggerActionForTests({
      previousInput: '/',
      input: '',
      now: 1000,
      lastInputTime: 800,
      isEnabled: true,
      state: makeState({ isActive: true, context: prevContext }),
      context: null,
      generateSuggestions: () => [],
    })

    expect(result.action).toBe('reset')
  })

  test('suppresses auto-trigger when the edit introduces non-ASCII text (IME)', () => {
    const context: CompletionContext = {
      type: 'command',
      prefix: '/h',
      startPos: 0,
      endPos: 2,
    }

    const suggestions: UnifiedSuggestion[] = [
      { type: 'command', value: 'help', displayValue: 'help', score: 1 },
    ]

    const result = __computeAutoTriggerActionForTests({
      previousInput: '你',
      input: '你好/h',
      now: 1000,
      lastInputTime: 950,
      isEnabled: true,
      state: makeState({ isActive: false, context: null }),
      context,
      generateSuggestions: () => suggestions,
    })

    expect(result.action).toBe('none')
  })

  test('auto-triggers for fast ASCII edits even right after another keystroke', () => {
    // Regression: the old time-only IME heuristic (fast typing < 150ms) kept
    // the completion panel closed when "/cmd" was typed quickly after a CJK
    // sentence. Only content with non-ASCII text is treated as IME now.
    const context: CompletionContext = {
      type: 'command',
      prefix: '/h',
      startPos: 0,
      endPos: 2,
    }

    const suggestions: UnifiedSuggestion[] = [
      { type: 'command', value: 'help', displayValue: 'help', score: 1 },
    ]

    const result = __computeAutoTriggerActionForTests({
      previousInput: '/',
      input: '/h',
      now: 1000,
      lastInputTime: 950, // 50ms apart — previously misclassified as IME
      isEnabled: true,
      state: makeState({ isActive: false, context: null }),
      context,
      generateSuggestions: () => suggestions,
    })

    expect(result.action).toBe('activate')
    expect(result.suggestions?.length).toBe(1)
  })

  test('auto-hides a single exact-match suggestion', () => {
    const context: CompletionContext = {
      type: 'command',
      prefix: '/help',
      startPos: 0,
      endPos: 5,
    }

    const suggestions: UnifiedSuggestion[] = [
      { type: 'command', value: 'help', displayValue: 'help', score: 1 },
    ]

    const result = __computeAutoTriggerActionForTests({
      previousInput: '/hel',
      input: '/help',
      now: 1000,
      lastInputTime: 0,
      isEnabled: true,
      state: makeState({ isActive: false, context: null }),
      context,
      generateSuggestions: () => suggestions,
    })

    expect(result.action).toBe('reset')
  })

  test('does not auto-trigger while suppression is still active', () => {
    const context: CompletionContext = {
      type: 'command',
      prefix: '/h',
      startPos: 0,
      endPos: 2,
    }

    const result = __computeAutoTriggerActionForTests({
      previousInput: '/h',
      input: '/h',
      now: 1000,
      lastInputTime: 900,
      forceRefresh: true,
      isEnabled: true,
      state: makeState({ suppressUntil: 1100 }),
      context,
      generateSuggestions: () => [
        { type: 'command', value: 'help', displayValue: 'help', score: 1 },
      ],
    })

    expect(result.action).toBe('none')
  })

  test('can refresh the same input after suppression expires', () => {
    const context: CompletionContext = {
      type: 'command',
      prefix: '/h',
      startPos: 0,
      endPos: 2,
    }

    const result = __computeAutoTriggerActionForTests({
      previousInput: '/h',
      input: '/h',
      now: 1200,
      lastInputTime: 900,
      forceRefresh: true,
      isEnabled: true,
      state: makeState({ suppressUntil: 1100 }),
      context,
      generateSuggestions: () => [
        { type: 'command', value: 'help', displayValue: 'help', score: 1 },
        {
          type: 'command',
          value: 'history',
          displayValue: 'history',
          score: 1,
        },
      ],
    })

    expect(result.action).toBe('activate')
    expect(result.suggestions?.map(suggestion => suggestion.value)).toEqual([
      'help',
      'history',
    ])
  })
})

describe('__getSuppressWakeDelayForTests', () => {
  test('returns the remaining suppression delay when enabled', () => {
    expect(
      __getSuppressWakeDelayForTests({
        isEnabled: true,
        now: 1000,
        suppressUntil: 1125,
      }),
    ).toBe(125)
  })

  test('does not schedule when disabled or already expired', () => {
    expect(
      __getSuppressWakeDelayForTests({
        isEnabled: false,
        now: 1000,
        suppressUntil: 1125,
      }),
    ).toBeNull()
    expect(
      __getSuppressWakeDelayForTests({
        isEnabled: true,
        now: 1200,
        suppressUntil: 1125,
      }),
    ).toBeNull()
  })
})
