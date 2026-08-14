import { useCallback } from 'react'

import {
  isLoadingSuggestion,
  type CompletionContext,
  type UnifiedSuggestion,
} from '#cli-utils/completion/types'

export type CompletionInsert = {
  input: string
  cursorOffset: number
}

/**
 * Pure completion construction shared by Tab/arrow acceptance and the submit
 * path: builds the input with the suggestion inserted over the word range.
 * Returns null when the suggestion is still loading or the input would not
 * change (e.g. the word is already fully completed).
 */
export function buildCompletionInsert(args: {
  input: string
  suggestion: UnifiedSuggestion
  context: CompletionContext
}): CompletionInsert | null {
  const { input, suggestion, context } = args
  if (isLoadingSuggestion(suggestion)) return null

  let completion: string

  if (context.type === 'command') {
    completion = `/${suggestion.value} `
  } else if (context.type === 'agent') {
    if (suggestion.type === 'agent' || suggestion.type === 'ask') {
      completion = `@${suggestion.value} `
    } else {
      const isDirectory = suggestion.value.endsWith('/')
      completion = `@${suggestion.value}${isDirectory ? '' : ' '}`
    }
  } else {
    if (suggestion.isSmartMatch) {
      completion = `@${suggestion.value} `
    } else {
      const isDirectory = suggestion.value.endsWith('/')
      const atPrefix = context.trigger === '@'
      completion = `${atPrefix ? '@' : ''}${suggestion.value}${
        isDirectory ? '' : ' '
      }`
    }
  }

  let actualEndPos: number

  if (
    context.type === 'file' &&
    suggestion.value.startsWith('/') &&
    !suggestion.isSmartMatch
  ) {
    let end = context.startPos
    while (end < input.length && input[end] !== ' ' && input[end] !== '\n') {
      end++
    }
    actualEndPos = end
  } else {
    const currentWord = input.slice(context.startPos)
    const nextSpaceIndex = currentWord.indexOf(' ')
    actualEndPos =
      nextSpaceIndex === -1 ? input.length : context.startPos + nextSpaceIndex
  }

  const newInput =
    input.slice(0, context.startPos) + completion + input.slice(actualEndPos)
  if (newInput === input) return null
  return { input: newInput, cursorOffset: context.startPos + completion.length }
}

export function useCompletionActions(args: {
  input: string
  onInputChange: (value: string) => void
  setCursorOffset: (offset: number) => void
}): {
  completeWith: (
    suggestion: UnifiedSuggestion,
    context: CompletionContext,
  ) => string | null
  partialComplete: (prefix: string, context: CompletionContext) => void
} {
  const { input, onInputChange, setCursorOffset } = args

  const completeWith = useCallback(
    (suggestion: UnifiedSuggestion, context: CompletionContext) => {
      const insert = buildCompletionInsert({ input, suggestion, context })
      if (insert === null) return null
      onInputChange(insert.input)
      setCursorOffset(insert.cursorOffset)
      return insert.input
    },
    [input, onInputChange, setCursorOffset],
  )

  const partialComplete = useCallback(
    (prefix: string, context: CompletionContext) => {
      const completion =
        context.type === 'command'
          ? `/${prefix}`
          : context.type === 'agent'
            ? `@${prefix}`
            : context.trigger === '@'
              ? `@${prefix}`
              : prefix

      const newInput =
        input.slice(0, context.startPos) +
        completion +
        input.slice(context.endPos)
      onInputChange(newInput)
      setCursorOffset(context.startPos + completion.length)
    },
    [input, onInputChange, setCursorOffset],
  )

  return { completeWith, partialComplete }
}
