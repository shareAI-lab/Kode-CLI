import { describe, expect, test } from 'bun:test'

import { createDefaultToolPermissionContext } from '#core/types/toolPermissionContext'

import {
  buildHeadlessToolPermissionContext,
  InvalidHeadlessPermissionModeError,
} from './headlessPermissionContext'

describe('buildHeadlessToolPermissionContext', () => {
  test('applies CLI rules, directories, and permission mode', () => {
    const context = buildHeadlessToolPermissionContext({
      baseContext: createDefaultToolPermissionContext({
        isBypassPermissionsModeAvailable: true,
      }),
      allowedTools: ['Read, Write(/tmp/output.html)'],
      disallowedTools: 'Bash,WebFetch',
      addDir: ['/tmp/generated,/tmp/assets'],
      permissionMode: 'acceptEdits',
      inputFormat: 'text',
      hasPermissionPromptTool: false,
    })

    expect(context.mode).toBe('acceptEdits')
    expect(context.alwaysAllowRules.cliArg).toEqual([
      'Read',
      'Write(/tmp/output.html)',
    ])
    expect(context.alwaysDenyRules.cliArg).toEqual(['Bash', 'WebFetch'])
    expect([...context.additionalWorkingDirectories.keys()]).toEqual([
      '/tmp/generated',
      '/tmp/assets',
    ])
  })

  test('accepts legacy values but emits one of the three supported modes', () => {
    const delegated = buildHeadlessToolPermissionContext({
      baseContext: createDefaultToolPermissionContext(),
      permissionMode: 'delegate',
      inputFormat: 'text',
      hasPermissionPromptTool: false,
    })
    expect(delegated.mode).toBe('cautious')

    const legacyEdit = buildHeadlessToolPermissionContext({
      baseContext: createDefaultToolPermissionContext(),
      permissionMode: 'yolo',
      inputFormat: 'text',
      hasPermissionPromptTool: false,
    })
    expect(legacyEdit.mode).toBe('acceptEdits')

    const ask = buildHeadlessToolPermissionContext({
      baseContext: createDefaultToolPermissionContext(),
      permissionMode: 'ask',
      inputFormat: 'text',
      hasPermissionPromptTool: false,
    })
    expect(ask.mode).toBe('cautious')

    expect(() =>
      buildHeadlessToolPermissionContext({
        baseContext: createDefaultToolPermissionContext(),
        permissionMode: 'unsafe-forever',
        inputFormat: 'text',
        hasPermissionPromptTool: false,
      }),
    ).toThrow(InvalidHeadlessPermissionModeError)
  })
})
