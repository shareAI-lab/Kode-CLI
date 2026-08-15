import { describe, expect, test } from 'bun:test'
import { getCompletionContext } from './context'

describe('getCompletionContext', () => {
  test('classifies a leading slash token as a command', () => {
    const context = getCompletionContext({
      input: '/hel',
      cursorOffset: 4,
    })
    expect(context).toEqual({
      type: 'command',
      prefix: 'hel',
      startPos: 0,
      endPos: 4,
      trigger: '/',
    })
  })

  test('classifies @agent as a mention', () => {
    const context = getCompletionContext({
      input: 'see @run-ag',
      cursorOffset: 11,
    })
    expect(context).toEqual({
      type: 'agent',
      prefix: 'run-ag',
      startPos: 4,
      endPos: 11,
      trigger: '@',
    })
  })

  test('classifies @path tokens as file mentions', () => {
    const atSrc = getCompletionContext({
      input: '@src/ma',
      cursorOffset: 7,
    })
    expect(atSrc).toEqual({
      type: 'file',
      prefix: 'src/ma',
      startPos: 0,
      endPos: 7,
      trigger: '@',
    })

    const atHome = getCompletionContext({
      input: '@~/.kode',
      cursorOffset: 8,
    })
    expect(atHome?.type).toBe('file')
    expect(atHome?.trigger).toBe('@')
    expect(atHome?.prefix).toBe('~/.kode')
  })

  test('does not treat mid-token @ as a mention trigger', () => {
    const context = getCompletionContext({
      input: 'user@host',
      cursorOffset: 9,
    })
    expect(context).toEqual({
      type: 'file',
      prefix: 'user@host',
      startPos: 0,
      endPos: 9,
      trigger: null,
    })
  })

  test('keeps a mid-sentence email as a single file word', () => {
    const input = 'ping admin@example.com please'
    const at = input.indexOf('admin@example.com') + 'admin@example.com'.length
    const context = getCompletionContext({
      input,
      cursorOffset: at,
    })
    expect(context?.type).toBe('file')
    expect(context?.trigger).toBeNull()
    expect(context?.prefix).toBe('admin@example.com')
  })
})
