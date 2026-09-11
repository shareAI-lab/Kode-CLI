import { describe, expect, test } from 'bun:test'

import { sanitizeTerminalText } from './sanitizeTerminalText'

describe('sanitizeTerminalText', () => {
  test('strips CSI sequences such as clear-screen and colour', () => {
    expect(sanitizeTerminalText('A \u001b[2J B')).toBe('A B')
    expect(sanitizeTerminalText('A \u001b[1;31mred\u001b[0m B')).toBe('A red B')
    expect(sanitizeTerminalText('\u001b[2K\u001b[1Aforged')).toBe('forged')
  })

  test('covers the full CSI parameter byte range', () => {
    // Regression: a narrower `[0-9;?]*` parameter class left these as visible
    // garbage (e.g. "[38:2::255:0:0m"), even though ESC removal meant they were
    // never interpreted by the terminal.
    expect(sanitizeTerminalText('safe\u001b[38:2::255:0:0mtext')).toBe(
      'safetext',
    )
    expect(sanitizeTerminalText('safe\u001b[<0;10;10Mtext')).toBe('safetext')
    expect(sanitizeTerminalText('safe\u001b[=1htext')).toBe('safetext')
    expect(sanitizeTerminalText('safe\u001b[>0ctext')).toBe('safetext')
    expect(sanitizeTerminalText('safe\u001b[?25ltext')).toBe('safetext')
    expect(sanitizeTerminalText('safe\u001b[1;1Htext')).toBe('safetext')
  })

  test('strips OSC sequences such as window-title and hyperlinks', () => {
    expect(sanitizeTerminalText('a\u001b]0;pwned\u0007b')).toBe('ab')
    expect(sanitizeTerminalText('a\u001b]8;;http://evil\u001b\\link')).toBe(
      'alink',
    )
  })

  test('strips other ESC-prefixed sequences', () => {
    expect(sanitizeTerminalText('a\u001bMb')).toBe('ab')
  })

  test('drops control characters and collapses whitespace for labels', () => {
    expect(sanitizeTerminalText('a\u0000b\u0007c')).toBe('a b c')
    expect(sanitizeTerminalText('  padded \t text  ')).toBe('padded text')
  })

  test('keeps newlines and tabs only when asked, and never keeps other controls', () => {
    expect(sanitizeTerminalText('line1\nline2', { allowNewlines: true })).toBe(
      'line1\nline2',
    )
    expect(sanitizeTerminalText('a\tb', { allowNewlines: true })).toBe('a\tb')
    expect(
      sanitizeTerminalText('a\u001b[2Jb\nc', { allowNewlines: true }),
    ).toBe('ab\nc')
    expect(sanitizeTerminalText('line1\nline2')).toBe('line1 line2')
  })

  test('strips bidi overrides that could reorder rendered text', () => {
    expect(sanitizeTerminalText('a\u202eb')).toBe('ab')
    expect(sanitizeTerminalText('a\u2066b\u2069')).toBe('ab')
  })

  test('handles non-strings and empty input', () => {
    expect(sanitizeTerminalText(undefined)).toBe('')
    expect(sanitizeTerminalText(null)).toBe('')
    expect(sanitizeTerminalText(42)).toBe('')
    expect(sanitizeTerminalText('')).toBe('')
  })
})
