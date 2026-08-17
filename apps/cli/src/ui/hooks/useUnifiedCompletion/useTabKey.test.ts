import { describe, expect, test } from 'bun:test'
import {
  __commandTabCompletionActionForTests,
  __completionPreviewOriginalInputForTests,
} from './useTabKey'

describe('command Tab completion', () => {
  test('shows the list when the first Tab has more than one command', () => {
    expect(
      __commandTabCompletionActionForTests({
        isAlreadyActive: false,
        suggestionCount: 3,
      }),
    ).toBe('show-list')
  })

  test('accepts a unique command on the first Tab', () => {
    expect(
      __commandTabCompletionActionForTests({
        isAlreadyActive: false,
        suggestionCount: 1,
      }),
    ).toBe('accept-first')
  })

  test('accepts the highlighted command once the panel is open', () => {
    expect(
      __commandTabCompletionActionForTests({
        isAlreadyActive: true,
        suggestionCount: 3,
      }),
    ).toBe('accept-selected')
  })
})

describe('Tab preview original input', () => {
  test('keeps the first typed input across later Tab cycles', () => {
    expect(
      __completionPreviewOriginalInputForTests({
        currentInput: 'src/main.ts',
        existingPreview: { isActive: true, originalInput: 'src/ma' },
      }),
    ).toBe('src/ma')
  })

  test('records the current input when a preview is not yet active', () => {
    expect(
      __completionPreviewOriginalInputForTests({
        currentInput: 'src/ma',
        existingPreview: null,
      }),
    ).toBe('src/ma')
  })
})
