import { describe, expect, test } from 'bun:test'

import { VoiceProviderError } from '@kode/ai'

import {
  __canCloseVoiceScreenOnEscapeForTests,
  getSafeVoiceErrorMessage,
} from './VoiceScreen'

describe('VoiceScreen error messages', () => {
  test('shows the safe MiMo provider status instead of a generic failure', () => {
    expect(
      getSafeVoiceErrorMessage(
        new VoiceProviderError('MiMo voice request failed (HTTP 400).'),
      ),
    ).toBe('MiMo voice request failed (HTTP 400).')
  })
})

describe('VoiceScreen escape-close state machine', () => {
  test('does not close the screen while a send is in flight', () => {
    expect(__canCloseVoiceScreenOnEscapeForTests('submitting')).toBe(false)
  })

  test('still closes from every cancellable state', () => {
    for (const kind of [
      'ready',
      'preparing',
      'recording',
      'transcribing',
      'review',
      'error',
    ] as const) {
      expect(__canCloseVoiceScreenOnEscapeForTests(kind)).toBe(true)
    }
  })
})
