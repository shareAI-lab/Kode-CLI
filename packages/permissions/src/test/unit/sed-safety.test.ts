import { describe, expect, test } from 'bun:test'

import type { ToolPermissionContext } from '@kode/tool-interface/permissions'

import { checkSedCommandSafety } from '../../bash/sed'

function ctx(mode: ToolPermissionContext['mode']): ToolPermissionContext {
  return {
    mode,
    additionalWorkingDirectories: new Map(),
    alwaysAllowRules: {},
    alwaysDenyRules: {},
    alwaysAskRules: {},
  }
}

describe('checkSedCommandSafety', () => {
  test('passthrough for plain read-only sed commands', () => {
    const decision = checkSedCommandSafety({
      command: 'sed -n 1,5p file.txt',
      toolPermissionContext: ctx('cautious'),
    })
    expect(decision.behavior).toBe('passthrough')
  })

  test('passthrough for multiple safe sed subcommands', () => {
    const decision = checkSedCommandSafety({
      command: 'sed -n 1p a.txt; sed -n 2p b.txt',
      toolPermissionContext: ctx('cautious'),
    })
    expect(decision.behavior).toBe('passthrough')
  })

  test('asks when sed writes files without acceptEdits', () => {
    const decision = checkSedCommandSafety({
      command: 'sed -i s/foo/bar/ file.txt',
      toolPermissionContext: ctx('cautious'),
    })
    expect(decision.behavior).toBe('ask')
    if (decision.behavior !== 'allow') {
      expect(decision.message).toContain('requires approval')
    }
  })

  test('allows simple in-place substitution in acceptEdits mode', () => {
    const decision = checkSedCommandSafety({
      command: 'sed -i s/foo/bar/ file.txt',
      toolPermissionContext: ctx('acceptEdits'),
    })
    expect(decision.behavior).toBe('passthrough')
  })

  test('asks for dangerous operations (e flag / exec)', () => {
    const decision = checkSedCommandSafety({
      command: 'sed s/foo/bar/e file.txt',
      toolPermissionContext: ctx('cautious'),
    })
    expect(decision.behavior).toBe('ask')
  })

  test('conservatively asks for quoted scripts', () => {
    const decision = checkSedCommandSafety({
      command: 'sed "s/foo/bar/" file.txt',
      toolPermissionContext: ctx('cautious'),
    })
    expect(decision.behavior).toBe('ask')
  })

  test('ignores non-sed commands', () => {
    const decision = checkSedCommandSafety({
      command: 'echo hello; grep foo file.txt',
      toolPermissionContext: ctx('cautious'),
    })
    expect(decision.behavior).toBe('passthrough')
  })
})
