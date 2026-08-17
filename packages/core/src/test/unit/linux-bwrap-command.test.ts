import { describe, expect, test } from 'bun:test'
import { mkdirSync } from 'fs'
import { buildLinuxBwrapCommand } from '#runtime/shell'

describe('Linux bwrap command construction', () => {
  test('includes /tmp/kode bind + TMPDIR env when write-restricted', () => {
    const previousKodeTmp = process.env.KODE_TMPDIR
    const previousClaudeTmpDir = process.env.CLAUDE_TMPDIR
    const previousClaudeTmp = process.env.CLAUDE_CODE_TMPDIR
    delete process.env.KODE_TMPDIR
    delete process.env.CLAUDE_TMPDIR
    delete process.env.CLAUDE_CODE_TMPDIR

    try {
      // This is a pure command-construction test; it can run on any platform.
      try {
        mkdirSync('/tmp/kode', { recursive: true })
      } catch {
        /* no-op */
      }

      const cmd = buildLinuxBwrapCommand({
        bwrapPath: '/usr/bin/bwrap',
        command: 'echo hi',
        needsNetworkRestriction: true,
        readConfig: { denyOnly: [] },
        writeConfig: { allowOnly: ['.'], denyWithinAllow: [] },
        enableWeakerNestedSandbox: false,
        binShellPath: '/bin/bash',
        cwd: '/work',
        homeDir: '/home/user',
      })

      expect(cmd[0]).toBe('/usr/bin/bwrap')
      expect(cmd).toContain('--unshare-net')
      expect(cmd).toContain('--die-with-parent')
      expect(cmd).toContain('--unshare-ipc')
      expect(cmd).toContain('--bind')
      expect(cmd.join(' ')).toContain('/tmp/kode')
      expect(cmd.join(' ')).toContain('--setenv TMPDIR /tmp/kode')
    } finally {
      if (previousKodeTmp === undefined) delete process.env.KODE_TMPDIR
      else process.env.KODE_TMPDIR = previousKodeTmp
      if (previousClaudeTmpDir === undefined) delete process.env.CLAUDE_TMPDIR
      else process.env.CLAUDE_TMPDIR = previousClaudeTmpDir
      if (previousClaudeTmp === undefined) delete process.env.CLAUDE_CODE_TMPDIR
      else process.env.CLAUDE_CODE_TMPDIR = previousClaudeTmp
    }
  })
})
