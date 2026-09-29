import { describe, expect, test } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { BunShell, buildLinuxBwrapCommand } from '#runtime/shell'

// bubblewrap is a Linux-only sandbox backend: the command builder joins paths
// for that platform and the fallback test actually starts the shell. Neither is
// meaningful on Windows, where the sandbox uses a different backend entirely.
describe.skipIf(process.platform === 'win32')(
  'BunShell Linux bwrap sandbox (compatibility)',
  () => {
    test('buildLinuxBwrapCommand generates expected bwrap args (read deny + write allow + denyWithinAllow + unshare-net)', () => {
      const previousKodeTmp = process.env.KODE_TMPDIR
      const previousClaudeTmpDir = process.env.CLAUDE_TMPDIR
      const previousClaudeTmp = process.env.CLAUDE_CODE_TMPDIR
      delete process.env.KODE_TMPDIR
      delete process.env.CLAUDE_TMPDIR
      delete process.env.CLAUDE_CODE_TMPDIR

      const root = mkdtempSync(join(tmpdir(), 'kode-bwrap-'))
      try {
        const allowDir = join(root, 'allow')
        const denyWithinAllow = join(allowDir, 'deny')
        const denyReadDir = join(root, 'deny-read-dir')
        const denyReadFile = join(root, 'deny-read-file.txt')

        mkdirSync(allowDir, { recursive: true })
        mkdirSync(denyWithinAllow, { recursive: true })
        mkdirSync(denyReadDir, { recursive: true })
        writeFileSync(denyReadFile, 'secret', 'utf-8')
        mkdirSync('/tmp/kode', { recursive: true })

        const cmd = buildLinuxBwrapCommand({
          bwrapPath: '/usr/bin/bwrap',
          command: 'echo hi',
          needsNetworkRestriction: true,
          readConfig: { denyOnly: [denyReadDir, denyReadFile] },
          writeConfig: {
            allowOnly: [allowDir],
            denyWithinAllow: [denyWithinAllow],
          },
          enableWeakerNestedSandbox: false,
          binShellPath: '/bin/bash',
          cwd: root,
        })

        const expected: string[] = [
          '/usr/bin/bwrap',
          '--die-with-parent',
          '--new-session',
          '--unshare-pid',
          '--unshare-uts',
          '--unshare-ipc',
          '--unshare-net',
          '--ro-bind',
          '/',
          '/',
          '--bind',
          '/tmp/kode',
          '/tmp/kode',
          '--bind',
          realpathSync(allowDir),
          realpathSync(allowDir),
          '--ro-bind',
          realpathSync(denyWithinAllow),
          realpathSync(denyWithinAllow),
          '--tmpfs',
          realpathSync(denyReadDir),
          '--ro-bind',
          '/dev/null',
          realpathSync(denyReadFile),
        ]

        if (existsSync('/etc/ssh/ssh_config.d')) {
          const sshConfigD = realpathSync('/etc/ssh/ssh_config.d')
          if (statSync(sshConfigD).isDirectory())
            expected.push('--tmpfs', sshConfigD)
          else expected.push('--ro-bind', '/dev/null', sshConfigD)
        }

        expected.push(
          '--dev',
          '/dev',
          '--setenv',
          'SANDBOX_RUNTIME',
          '1',
          '--setenv',
          'TMPDIR',
          '/tmp/kode',
          '--proc',
          '/proc',
          '--',
          '/bin/bash',
          '-c',
          'echo hi',
        )

        expect(cmd).toEqual(expected)
      } finally {
        rmSync(root, { recursive: true, force: true })
        if (previousKodeTmp === undefined) delete process.env.KODE_TMPDIR
        else process.env.KODE_TMPDIR = previousKodeTmp
        if (previousClaudeTmpDir === undefined) delete process.env.CLAUDE_TMPDIR
        else process.env.CLAUDE_TMPDIR = previousClaudeTmpDir
        if (previousClaudeTmp === undefined)
          delete process.env.CLAUDE_CODE_TMPDIR
        else process.env.CLAUDE_CODE_TMPDIR = previousClaudeTmp
      }
    })

    test('falls back consistently when bwrap is unavailable (require vs non-require)', async () => {
      const root = mkdtempSync(join(tmpdir(), 'kode-bwrap-fallback-'))
      try {
        const shell = new BunShell(root)

        const required = await shell.exec('echo ok', undefined, 5_000, {
          sandbox: {
            enabled: true,
            require: true,
            needsNetworkRestriction: true,
            writableRoots: [root],
            __platformOverride: 'linux',
            __bwrapPathOverride: null,
          },
        })
        expect(required.code).toBe(2)
        expect(required.stderr).toContain(
          'System sandbox is required but unavailable',
        )

        const optional = await shell.exec('echo ok', undefined, 5_000, {
          sandbox: {
            enabled: true,
            require: false,
            needsNetworkRestriction: true,
            writableRoots: [root],
            __platformOverride: 'linux',
            __bwrapPathOverride: null,
          },
        })
        expect(optional.stdout.trim()).toBe('ok')
        expect(optional.stderr.trim()).toBe('')
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    })

    test('falls back consistently when bwrap fails to start (require=false)', async () => {
      const root = mkdtempSync(join(tmpdir(), 'kode-bwrap-failed-start-'))
      try {
        const shell = new BunShell(root)
        const fakeBwrap = join(root, 'fake-bwrap.sh')
        writeFileSync(
          fakeBwrap,
          `#!/bin/sh\n\necho \"bwrap: fake init failure\" 1>&2\nexit 1\n`,
          { encoding: 'utf-8' },
        )
        // Ensure it's executable.
        Bun.spawnSync({ cmd: ['chmod', '+x', fakeBwrap] })

        const result = await shell.exec('echo ok', undefined, 5_000, {
          sandbox: {
            enabled: true,
            require: false,
            needsNetworkRestriction: true,
            writableRoots: [root],
            __platformOverride: 'linux',
            __bwrapPathOverride: fakeBwrap,
          },
        })

        expect(result.stdout.trim()).toBe('ok')
        expect(result.stderr.trim()).toBe('')
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    })
  },
)
