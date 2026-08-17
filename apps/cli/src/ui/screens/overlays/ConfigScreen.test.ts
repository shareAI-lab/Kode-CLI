import { describe, expect, test } from 'bun:test'
import { __getConfigQuickStartCommandForTests } from './ConfigScreen'

describe('ConfigScreen quick start', () => {
  test('maps 1-4 to setup commands and ignores other keys', () => {
    expect(__getConfigQuickStartCommandForTests('1')).toBe('/onboarding')
    expect(__getConfigQuickStartCommandForTests('2')).toBe('/model')
    expect(__getConfigQuickStartCommandForTests('3')).toBe('/permissions')
    expect(__getConfigQuickStartCommandForTests('4')).toBe('/mcp')
    expect(__getConfigQuickStartCommandForTests('5')).toBeNull()
    expect(__getConfigQuickStartCommandForTests('a')).toBeNull()
  })
})
