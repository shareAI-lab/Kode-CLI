import { describe, expect, test } from 'bun:test'

import { FileReadTool } from '#tools/tools/filesystem/FileReadTool/FileReadTool'
import { GlobTool } from '#tools/tools/filesystem/GlobTool/GlobTool'
import { LSTool } from '#tools/tools/filesystem/LSTool/LSTool'
import { GrepTool } from '#tools/tools/search/GrepTool/GrepTool'
import { BashTool } from '#tools/tools/system/BashTool/BashTool'

describe('read-mode tool profile', () => {
  test('explicitly exposes local inspection tools', () => {
    expect(FileReadTool.readModeAccess).toBe('always')
    expect(LSTool.readModeAccess).toBe('always')
    expect(GlobTool.readModeAccess).toBe('always')
    expect(GrepTool.readModeAccess).toBe('always')
    expect(BashTool.readModeAccess).toBe('conditional')
  })

  test('allows only safe Bash parameters before command classification', () => {
    expect(
      BashTool.readModeInputSchema?.safeParse({ command: 'git diff' }).success,
    ).toBe(true)
    expect(
      BashTool.readModeInputSchema?.safeParse({
        command: 'git diff',
        dangerouslyDisableSandbox: true,
      }).success,
    ).toBe(false)
    expect(BashTool.isReadOnly({ command: 'git diff' })).toBe(true)
    expect(BashTool.isReadOnly({ command: 'touch new-file' })).toBe(false)
  })
})
