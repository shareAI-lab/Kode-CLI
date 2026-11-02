import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

describe('CLI rejects broken settings before execution (production mode)', () => {
  const entrypoint = resolve('apps/cli/src/dispatch.ts')
  let root: string
  let projectDir: string
  let configDir: string
  let policyPath: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'kode-cli-policy-'))
    projectDir = join(root, 'project')
    configDir = join(root, 'config')
    policyPath = join(projectDir, '.kode', 'settings.json')
    mkdirSync(dirname(policyPath), { recursive: true })
    mkdirSync(configDir)
    writeFileSync(join(configDir, 'settings.json'), '{}')
    writeFileSync(join(configDir, 'config.json'), '{}')
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  function run(args: string[], asUnprivileged = false) {
    return spawnSync(
      process.execPath,
      [entrypoint, ...args, '--cwd', projectDir],
      {
        cwd: projectDir,
        // Explicit environment keeps these regressions independent of real model
        // credentials and forces the production (formerly silent) error path.
        env: {
          PATH: process.env.PATH,
          CI: '1',
          NODE_ENV: 'production',
          KODE_CONFIG_DIR: configDir,
          CLAUDE_CONFIG_DIR: join(root, 'legacy'),
          NO_COLOR: '1',
        },
        encoding: 'utf8',
        timeout: 15000,
        ...(asUnprivileged && process.getuid?.() === 0
          ? { uid: 65534, gid: 65534 }
          : {}),
      },
    )
  }

  function expectBlocked(result: ReturnType<typeof run>, path = policyPath) {
    expect(result.error).toBeUndefined()
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('Cannot load settings')
    expect(result.stderr).toContain(JSON.stringify(path))
    expect(result.stderr).not.toContain('private-test-value')
    expect(result.stdout).not.toContain('"type":"result"')
    expect(existsSync(join(projectDir, '.env'))).toBe(false)
  }

  test.each(['text', 'json', 'stream-json'])(
    '%s print exits nonzero with a diagnostic for truncated settings',
    format => {
      writeFileSync(policyPath, '{"token":"private-test-value","permissions":')
      expectBlocked(
        run([
          '-p',
          'Write .env',
          '--permission-mode',
          'acceptEdits',
          '--output-format',
          format,
        ]),
      )
    },
  )

  test('interactive startup reports the same failure before rendering or executing', () => {
    writeFileSync(policyPath, '{"permissions":')
    expectBlocked(run(['--permission-mode', 'acceptEdits', 'Write .env']))
  })

  test('MCP server startup fails before accepting tool calls', () => {
    writeFileSync(policyPath, '{"permissions":')
    expectBlocked(run(['--mcp-server']))
  })

  test.each(['user', 'project', 'local'])(
    'invalid %s permission schema cannot be hidden by other valid sources',
    source => {
      const path =
        source === 'user'
          ? join(configDir, 'settings.json')
          : source === 'local'
            ? join(projectDir, '.kode', 'settings.local.json')
            : policyPath
      writeFileSync(path, '{"permissions":{"deny":"Write(.env)"}}')
      expectBlocked(
        run([
          '-p',
          'Write .env',
          '--permission-mode',
          'acceptEdits',
          '--output-format',
          'json',
        ]),
        path,
      )
    },
  )

  test('a directory at the primary path does not fall back to permissive legacy settings', () => {
    mkdirSync(policyPath)
    mkdirSync(join(projectDir, '.claude'))
    writeFileSync(
      join(projectDir, '.claude', 'settings.json'),
      '{"permissions":{"allow":["Write"]}}',
    )
    expectBlocked(run(['-p', 'Write .env', '--permission-mode', 'acceptEdits']))
  })

  test.skipIf(process.platform === 'win32')(
    'real EACCES is reported even when the test runner is root',
    () => {
      chmodSync(root, 0o755)
      writeFileSync(policyPath, '{"permissions":{"deny":["Write(.env)"]}}')
      chmodSync(policyPath, 0o000)
      try {
        const result = run(
          ['-p', 'Write .env', '--permission-mode', 'acceptEdits'],
          true,
        )
        expectBlocked(result)
        expect(result.stderr).toContain('EACCES')
      } finally {
        chmodSync(policyPath, 0o600)
      }
    },
  )
})
