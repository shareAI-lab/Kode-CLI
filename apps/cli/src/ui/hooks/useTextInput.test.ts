import { describe, expect, test } from 'bun:test'
import { __resolveTextInputDestructiveActionForTests } from './useTextInput'

describe('text input destructive keys', () => {
  test('forward-delete stays distinct from backspace and DEL', () => {
    expect(
      __resolveTextInputDestructiveActionForTests(
        { delete: true, backspace: false },
        '',
      ),
    ).toBe('delete')
    expect(
      __resolveTextInputDestructiveActionForTests(
        { delete: false, backspace: true },
        '',
      ),
    ).toBe('backspace')
    expect(
      __resolveTextInputDestructiveActionForTests(
        { delete: false, backspace: false },
        '\u007f',
      ),
    ).toBe('backspace')
    expect(
      __resolveTextInputDestructiveActionForTests(
        { delete: false, backspace: false },
        'a',
      ),
    ).toBeNull()
  })
})
