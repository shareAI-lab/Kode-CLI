import { describe, expect, test } from 'bun:test'
import {
  getPromptPreparationFailureMessage,
  recoverPromptPreparationFailure,
} from './submit'

describe('prompt preparation failure recovery', () => {
  test('keeps text-only prompts recoverable without exposing the local error', () => {
    expect(getPromptPreparationFailureMessage(false)).toBe(
      'Unable to prepare the prompt. Your prompt was saved to history; press Up Arrow to restore it and retry.',
    )
  })

  test('asks users to reattach images that cannot be recovered from history', () => {
    expect(getPromptPreparationFailureMessage(true)).toBe(
      'Unable to prepare the prompt. The text was saved to history; press Up Arrow to restore it and retry. Reattach any images before retrying.',
    )
  })

  test('saves the prompt and clears the inactive request state', () => {
    const calls: string[] = []

    recoverPromptPreparationFailure({
      savePromptToHistory: () => calls.push('history'),
      resetHistory: () => calls.push('reset'),
      setAbortController: controller =>
        calls.push(controller === null ? 'controller' : 'unexpected'),
      setIsLoading: isLoading =>
        calls.push(isLoading ? 'loading' : 'not-loading'),
      hasImageAttachments: false,
      onProcessingError: message => calls.push(message),
    })

    expect(calls).toEqual([
      'history',
      'reset',
      'controller',
      'not-loading',
      getPromptPreparationFailureMessage(false),
    ])
  })
})
