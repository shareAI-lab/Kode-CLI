import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { getAllTools } from '#tools'
import { getCommands } from '#cli-commands'

describe('public contracts (refactor safety net)', () => {
  test('built-in tool registry names + order stay stable', () => {
    const toolNames = getAllTools().map(t => t.name)
    expect(toolNames).toEqual([
      'Task',
      'TaskBatch',
      'AskExpertModel',
      'Bash',
      'TaskOutput',
      'TaskMonitor',
      'TaskGuide',
      'TaskStop',
      'LS',
      'Glob',
      'Grep',
      'LSP',
      'Read',
      'Edit',
      'Write',
      'NotebookEdit',
      'TaskCreate',
      'TaskList',
      'TaskGet',
      'TaskUpdate',
      'TodoWrite',
      'WebSearch',
      'WebFetch',
      'AskUserQuestion',
      'EnterPlanMode',
      'ExitPlanMode',
      'SlashCommand',
      'Skill',
      'SessionMessage',
      'ListMcpResourcesTool',
      'ReadMcpResourceTool',
      'MCPSearch',
      'mcp',
    ])
    expect(new Set(toolNames).size).toBe(toolNames.length)
  })

  test('built-in command surface stays stable (names + aliases)', async () => {
    const tmpConfigDir = mkdtempSync(join(tmpdir(), 'kode-contract-commands-'))
    const tmpHomeDir = mkdtempSync(join(tmpdir(), 'kode-contract-home-'))
    const previousConfigDir = process.env.KODE_CONFIG_DIR
    const previousHome = process.env.HOME
    const previousUserProfile = process.env.USERPROFILE
    process.env.KODE_CONFIG_DIR = tmpConfigDir
    process.env.HOME = tmpHomeDir
    process.env.USERPROFILE = tmpHomeDir
    try {
      const commands = await getCommands()
      const byName = new Map(commands.map(c => [c.userFacingName(), c]))

      const expected = [
        'agents',
        'clear',
        'compact',
        'config',
        'cost',
        'doctor',
        'extensions',
        'help',
        'init',
        'inspect',
        'output-style',
        'statusline',
        'mcp',
        'plugin',
        'model',
        'modelstatus',
        'onboarding',
        'pr-comments',
        'rename',
        'session',
        'settings',
        'tag',
        'refresh-commands',
        'bug',
        'review',
        'work',
      ]

      for (const name of expected) {
        expect(byName.has(name)).toBe(true)
      }

      const expectedSet = new Set(expected)
      const builtins = commands.filter(c => expectedSet.has(c.userFacingName()))
      expect(builtins.map(c => c.userFacingName())).toEqual(expected)
      expect(new Set(builtins.map(c => c.userFacingName())).size).toBe(
        builtins.length,
      )

      const aliasTokens = builtins.flatMap(c => c.aliases ?? [])
      expect(new Set(aliasTokens).size).toBe(aliasTokens.length)

      for (const name of [
        'work',
        'session',
        'settings',
        'extensions',
        'inspect',
      ]) {
        expect(byName.get(name)?.isHidden).toBe(false)
      }
      for (const name of [
        'automation',
        'browser',
        'bug',
        'checkpoint',
        'console',
        'config',
        'cost',
        'doctor',
        'files',
        'goal',
        'loop',
        'memory',
        'open',
        'plugin',
        'plugins',
        'pr-comments',
        'rename',
        'rollback',
        'tasks',
        'theme',
        'worktree',
      ]) {
        expect(byName.get(name)?.isHidden).toBe(true)
      }
    } finally {
      if (previousConfigDir === undefined) delete process.env.KODE_CONFIG_DIR
      else process.env.KODE_CONFIG_DIR = previousConfigDir
      if (previousHome === undefined) delete process.env.HOME
      else process.env.HOME = previousHome
      if (previousUserProfile === undefined) delete process.env.USERPROFILE
      else process.env.USERPROFILE = previousUserProfile
      rmSync(tmpConfigDir, { recursive: true, force: true })
      rmSync(tmpHomeDir, { recursive: true, force: true })
    }
  })

  test('apps/cli/src/dispatch.ts preserves --help-lite and --version output', () => {
    const script = join(process.cwd(), 'apps', 'cli', 'src', 'dispatch.ts')

    const fullHelpRes = spawnSync(process.execPath, [script, '--help'], {
      cwd: process.cwd(),
      env: { ...process.env },
      encoding: 'utf8',
    })
    expect(fullHelpRes.status).toBe(0)
    expect(fullHelpRes.stdout).toContain('Usage: kode')
    // Full help is provided by the CLI program parser; web flags are part of server app.

    const helpRes = spawnSync(process.execPath, [script, '--help-lite'], {
      cwd: process.cwd(),
      env: { ...process.env },
      encoding: 'utf8',
    })
    expect(helpRes.status).toBe(0)
    expect(helpRes.stdout).toContain('Usage: kode')
    expect(helpRes.stdout).toContain('--help')
    expect(helpRes.stdout).toContain('--print')
    expect(helpRes.stdout).toContain('--headless')

    const pkg = JSON.parse(
      readFileSync(join(process.cwd(), 'package.json'), 'utf8'),
    )
    const verRes = spawnSync(process.execPath, [script, '--version'], {
      cwd: process.cwd(),
      env: { ...process.env },
      encoding: 'utf8',
    })
    expect(verRes.status).toBe(0)
    expect(verRes.stdout.trim()).toBe(String(pkg.version))
  })

  test('subcommand help stays stable (mcp --help)', () => {
    const script = join(process.cwd(), 'apps', 'cli', 'src', 'dispatch.ts')
    const tmpConfigDir = mkdtempSync(join(tmpdir(), 'kode-contract-mcp-help-'))

    try {
      const res = spawnSync(process.execPath, [script, 'mcp', '--help'], {
        cwd: process.cwd(),
        env: { ...process.env, KODE_CONFIG_DIR: tmpConfigDir },
        encoding: 'utf8',
      })

      expect(res.status).toBe(0)
      expect(res.stdout).toContain('Usage: kode mcp')
      expect(res.stdout).toContain('Configure and manage MCP servers')
      expect(res.stdout).toContain('Commands:')
      expect(res.stdout).toContain('serve')
      expect(res.stdout).toContain('add ')
      expect(res.stdout).toContain('remove')
      expect(res.stdout).toContain('list')
    } finally {
      rmSync(tmpConfigDir, { recursive: true, force: true })
    }
  })

  test('apps/cli/src/dispatch.ts matches old_version_2 output (help/version)', () => {
    const oldRoot = process.env.KODE_OLD_VERSION_2_ROOT
    if (!oldRoot) return

    if (!existsSync(oldRoot)) return

    const newRoot = process.cwd()
    const newScript = join(newRoot, 'apps', 'cli', 'src', 'dispatch.ts')
    const oldScript = join(oldRoot, 'src', 'index.ts')

    const tmpRoot = mkdtempSync(join(tmpdir(), 'kode-contract-parity-'))

    const commonEnv: Record<string, string | undefined> = {
      ...process.env,
      NO_COLOR: '1',
      NODE_DISABLE_COLORS: '1',
      FORCE_COLOR: '0',
      TERM: 'dumb',
      KODE_CONFIG_DIR: tmpRoot,
    }

    try {
      const argsToCheck = [['--help-lite'], ['--help'], ['--version']]
      for (const args of argsToCheck) {
        const oldRes = spawnSync(process.execPath, [oldScript, ...args], {
          cwd: oldRoot,
          env: commonEnv,
          encoding: 'utf8',
        })
        expect(oldRes.status).toBe(0)

        const newRes = spawnSync(process.execPath, [newScript, ...args], {
          cwd: newRoot,
          env: commonEnv,
          encoding: 'utf8',
        })
        expect(newRes.status).toBe(0)

        expect(newRes.stdout).toBe(oldRes.stdout)
      }
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true })
    }
  })
})
