import { describe, expect, test } from 'bun:test'
import { buildCompletionInsert } from './actions'
import type { CompletionContext } from '#cli-utils/completion/types'

const commandContext: CompletionContext = {
  type: 'command',
  prefix: '/hel',
  startPos: 0,
  endPos: 4,
}

const fileContext: CompletionContext = {
  type: 'file',
  prefix: 'src/ma',
  startPos: 6,
  endPos: 12,
}

describe('buildCompletionInsert', () => {
  test('completes a slash command prefix to a full command', () => {
    const result = buildCompletionInsert({
      input: '/hel',
      suggestion: {
        type: 'command',
        value: 'help',
        displayValue: 'help',
        score: 1,
      },
      context: commandContext,
    })
    expect(result).not.toBeNull()
    expect(result?.input).toBe('/help ')
  })

  test('replaces only the word range when the prefix is mid-sentence', () => {
    const midSentenceContext: CompletionContext = {
      type: 'command',
      prefix: '/he',
      startPos: 7,
      endPos: 10,
    }
    const result = buildCompletionInsert({
      input: 'please /he me',
      suggestion: {
        type: 'command',
        value: 'help',
        displayValue: 'help',
        score: 1,
      },
      context: midSentenceContext,
    })
    // The original space after the word is preserved by the insert.
    expect(result?.input).toBe('please /help  me')
  })

  test('completes a file path prefix', () => {
    const result = buildCompletionInsert({
      input: 'check src/ma',
      suggestion: {
        type: 'file',
        value: 'src/main.ts',
        displayValue: 'src/main.ts',
        score: 1,
      },
      context: fileContext,
    })
    expect(result?.input).toBe('check src/main.ts ')
  })

  test('returns null when the input would not change', () => {
    // Directory suggestions carry no trailing space, so a fully typed
    // directory produces the same input and there is nothing to insert.
    expect(
      buildCompletionInsert({
        input: 'src/ma/',
        suggestion: {
          type: 'file',
          value: 'src/ma/',
          displayValue: 'src/ma/',
          score: 1,
        },
        context: { ...fileContext, startPos: 0, endPos: 7 },
      }),
    ).toBeNull()
  })

  test('returns null for a loading suggestion', () => {
    const result = buildCompletionInsert({
      input: '/hel',
      suggestion: {
        type: 'command',
        value: 'help',
        displayValue: 'help',
        score: 1,
        metadata: { isLoading: true },
      } as never,
      context: commandContext,
    })
    expect(result).toBeNull()
  })
})
