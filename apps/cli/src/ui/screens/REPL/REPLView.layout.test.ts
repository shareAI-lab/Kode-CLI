import { describe, expect, test } from 'bun:test'
import { getMessageSelectorLayoutSignature } from './REPLView'

describe('REPL layout measurement signatures', () => {
  test('ignores transcript growth while the message selector is hidden', () => {
    expect(getMessageSelectorLayoutSignature(false, 1)).toBe(0)
    expect(getMessageSelectorLayoutSignature(false, 100)).toBe(0)
  })

  test('tracks message count while the selector is visible', () => {
    expect(getMessageSelectorLayoutSignature(true, 1)).toBe(1)
    expect(getMessageSelectorLayoutSignature(true, 100)).toBe(100)
  })
})
