import { describe, expect, test } from 'bun:test'
import { resolveShortcutOptionValue } from './use-select'

const bashOptions = [
  { label: 'Allow once', value: 'yes', index: 0 },
  {
    label: 'Always allow commands starting with git in /repo',
    value: 'yes-dont-ask-again-prefix',
    index: 1,
  },
  { label: 'Deny and provide instructions (esc)', value: 'no', index: 2 },
]

describe('resolveShortcutOptionValue', () => {
  test('y selects the first allow-once option', () => {
    expect(resolveShortcutOptionValue(bashOptions, 'y')).toBe('yes')
    expect(resolveShortcutOptionValue(bashOptions, 'Y')).toBe('yes')
  })

  test('a selects the dont-ask-again option', () => {
    expect(resolveShortcutOptionValue(bashOptions, 'a')).toBe(
      'yes-dont-ask-again-prefix',
    )
  })

  test('n selects the deny option', () => {
    expect(resolveShortcutOptionValue(bashOptions, 'n')).toBe('no')
  })

  test('returns null when no option matches', () => {
    expect(resolveShortcutOptionValue(bashOptions, 'x')).toBeNull()
    expect(resolveShortcutOptionValue(bashOptions, '')).toBeNull()
    expect(resolveShortcutOptionValue(bashOptions, 'ab')).toBeNull()
  })

  test('falls back to the full-command always-allow value when prefix is unavailable', () => {
    const fullOnly = [
      { label: 'Allow once', value: 'yes', index: 0 },
      {
        label: 'Always allow this exact command',
        value: 'yes-dont-ask-again-full',
        index: 1,
      },
      { label: 'Deny', value: 'no', index: 2 },
    ]
    expect(resolveShortcutOptionValue(fullOnly, 'a')).toBe(
      'yes-dont-ask-again-full',
    )
  })

  test('a selects session-scoped always-allow values in file dialogs', () => {
    const fileWriteOptions = [
      { label: 'Allow once', value: 'yes', index: 0 },
      { label: 'Allow for this session', value: 'yes-session', index: 1 },
      { label: 'Deny', value: 'no', index: 2 },
    ]
    expect(resolveShortcutOptionValue(fileWriteOptions, 'a')).toBe(
      'yes-session',
    )
  })

  test('a selects exact/prefix always-allow values in skill and slash dialogs', () => {
    expect(
      resolveShortcutOptionValue(
        [
          { label: 'Allow once', value: 'yes', index: 0 },
          { label: 'Always allow this skill', value: 'yes-exact', index: 1 },
          { label: 'Deny', value: 'no', index: 2 },
        ],
        'a',
      ),
    ).toBe('yes-exact')
    expect(
      resolveShortcutOptionValue(
        [
          { label: 'Allow once', value: 'yes', index: 0 },
          { label: 'Always allow this prefix', value: 'yes-prefix', index: 1 },
          { label: 'Deny', value: 'no', index: 2 },
        ],
        'a',
      ),
    ).toBe('yes-prefix')
  })

  test('skips header-like options without values', () => {
    const withHeader = [
      { label: 'Header', index: 0 } as { label: string; index: number },
      { label: 'Allow once', value: 'yes', index: 1 },
    ]
    expect(resolveShortcutOptionValue(withHeader as never, 'y')).toBe('yes')
  })
})
