import { describe, expect, test } from 'bun:test'
import { __completionEnterActionForTests } from './useNavigationKeys'

describe('completion Enter', () => {
  test('sends slash commands on the same keypress', () => {
    expect(__completionEnterActionForTests('command')).toBe('accept-and-submit')
  })

  test('only inserts file and mention completions', () => {
    expect(__completionEnterActionForTests('file')).toBe('accept')
    expect(__completionEnterActionForTests('agent')).toBe('accept')
  })
})
