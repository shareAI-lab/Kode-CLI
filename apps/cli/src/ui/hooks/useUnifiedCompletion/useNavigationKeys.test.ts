import { describe, expect, test } from 'bun:test'
import { __completionEnterActionForTests } from './useNavigationKeys'

describe('completion Enter', () => {
  test('sends slash commands on the same keypress', () => {
    expect(__completionEnterActionForTests('command')).toBe('accept-and-submit')
  })

  test('submits typed file input and only inserts mention completions', () => {
    expect(__completionEnterActionForTests('file')).toBe('submit')
    expect(__completionEnterActionForTests('agent')).toBe('accept')
  })
})
