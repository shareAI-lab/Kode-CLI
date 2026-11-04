import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import {
  loadToolPermissionContextFromDisk,
  persistToolPermissionUpdateToDisk,
} from '#core/utils/permissions/toolPermissionSettings'

function writeJson(filePath: string, value: unknown) {
  mkdirSync(dirname(filePath), { recursive: true })
  writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf-8')
}

describe('tool permission settings (multi-source load/merge/persist)', () => {
  let projectDir: string
  let homeDir: string
  let configDir: string
  let prevConfigDir: string | undefined

  function setTrusted(trusted: boolean) {
    writeJson(join(configDir, 'config.json'), {
      projects: trusted
        ? { [projectDir]: { hasTrustDialogAccepted: true } }
        : {},
    })
  }

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), 'kode-perm-project-'))
    homeDir = mkdtempSync(join(tmpdir(), 'kode-perm-home-'))
    configDir = mkdtempSync(join(tmpdir(), 'kode-perm-config-'))
    prevConfigDir = process.env.KODE_CONFIG_DIR
    process.env.KODE_CONFIG_DIR = configDir
    setTrusted(true)
  })

  afterEach(() => {
    if (prevConfigDir === undefined) delete process.env.KODE_CONFIG_DIR
    else process.env.KODE_CONFIG_DIR = prevConfigDir
    rmSync(projectDir, { recursive: true, force: true })
    rmSync(homeDir, { recursive: true, force: true })
    rmSync(configDir, { recursive: true, force: true })
  })

  test('untrusted workspace: repo settings cannot grant, but can restrict', () => {
    setTrusted(false)
    writeJson(join(homeDir, '.kode', 'settings.json'), {
      permissions: { allow: ['Bash(ls:*)'] },
    })
    writeJson(join(projectDir, '.kode', 'settings.json'), {
      permissions: {
        allow: ['Bash(mkfifo:*)'],
        deny: ['Bash(rm:*)'],
        ask: ['Bash(curl:*)'],
        additionalDirectories: ['/'],
      },
    })
    writeJson(join(projectDir, '.kode', 'settings.local.json'), {
      permissions: { allow: ['Read(~/**)'], additionalDirectories: ['/etc'] },
    })

    const ctx = loadToolPermissionContextFromDisk({
      projectDir,
      homeDir,
      includeKodeProjectConfig: false,
    })

    expect(ctx.alwaysAllowRules.userSettings).toEqual(['Bash(ls:*)'])
    expect(ctx.alwaysAllowRules.projectSettings).toBeUndefined()
    expect(ctx.alwaysAllowRules.localSettings).toBeUndefined()
    expect(ctx.alwaysDenyRules.projectSettings).toEqual(['Bash(rm:*)'])
    expect(ctx.alwaysAskRules.projectSettings).toEqual(['Bash(curl:*)'])
    expect(ctx.additionalWorkingDirectories.size).toBe(0)
  })

  test('untrusted workspace: legacy .claude settings are not granted or migrated', () => {
    setTrusted(false)
    writeJson(join(projectDir, '.claude', 'settings.json'), {
      permissions: { allow: ['Bash(mkfifo:*)'] },
    })

    const ctx = loadToolPermissionContextFromDisk({
      projectDir,
      homeDir,
      includeKodeProjectConfig: false,
    })

    expect(ctx.alwaysAllowRules.projectSettings).toBeUndefined()
    expect(existsSync(join(projectDir, '.kode', 'settings.json'))).toBe(false)
  })

  test('trust is evaluated for projectDir, not process cwd', () => {
    // process cwd (the repo) is not trusted; projectDir is.
    writeJson(join(projectDir, '.kode', 'settings.json'), {
      permissions: { allow: ['Bash(git:*)'] },
    })
    const ctx = loadToolPermissionContextFromDisk({
      projectDir,
      homeDir,
      includeKodeProjectConfig: false,
    })
    expect(ctx.alwaysAllowRules.projectSettings).toEqual(['Bash(git:*)'])
  })

  test('loads .kode/settings.json + .kode/settings.local.json across sources', () => {
    writeJson(join(homeDir, '.kode', 'settings.json'), {
      permissions: { allow: ['Bash(ls:*)'] },
    })
    writeJson(join(projectDir, '.kode', 'settings.json'), {
      permissions: { allow: ['Bash(git:*)'] },
    })
    writeJson(join(projectDir, '.kode', 'settings.local.json'), {
      permissions: { allow: ['Read(~/**)'] },
    })

    const ctx = loadToolPermissionContextFromDisk({
      projectDir,
      homeDir,
      includeKodeProjectConfig: false,
    })

    expect(ctx.alwaysAllowRules.userSettings).toEqual(['Bash(ls:*)'])
    expect(ctx.alwaysAllowRules.projectSettings).toEqual(['Bash(git:*)'])
    expect(ctx.alwaysAllowRules.localSettings).toEqual(['Read(~/**)'])
  })

  test('merges same rule across multiple sources without dropping either', () => {
    writeJson(join(homeDir, '.kode', 'settings.json'), {
      permissions: { allow: ['Bash(ls:*)'] },
    })
    writeJson(join(projectDir, '.kode', 'settings.local.json'), {
      permissions: { allow: ['Bash(ls:*)'] },
    })

    const ctx = loadToolPermissionContextFromDisk({
      projectDir,
      homeDir,
      includeKodeProjectConfig: false,
    })

    expect(ctx.alwaysAllowRules.userSettings).toEqual(['Bash(ls:*)'])
    expect(ctx.alwaysAllowRules.localSettings).toEqual(['Bash(ls:*)'])
  })

  test('migrates legacy .claude settings to .kode when .kode is missing', () => {
    writeJson(join(projectDir, '.claude', 'settings.local.json'), {
      permissions: { allow: ['Bash(ls:*)'] },
    })

    const ctx = loadToolPermissionContextFromDisk({
      projectDir,
      homeDir,
      includeKodeProjectConfig: false,
    })
    expect(ctx.alwaysAllowRules.localSettings).toEqual(['Bash(ls:*)'])

    const migratedPath = join(projectDir, '.kode', 'settings.local.json')
    expect(existsSync(migratedPath)).toBe(true)
    const migrated = JSON.parse(readFileSync(migratedPath, 'utf-8'))
    expect(migrated.permissions.allow).toEqual(['Bash(ls:*)'])
  })

  test('session updates are not persisted; policySettings is never persisted', () => {
    const session = persistToolPermissionUpdateToDisk({
      update: {
        type: 'addRules',
        destination: 'session',
        behavior: 'allow',
        rules: ['Bash(ls:*)'],
      },
      projectDir,
      homeDir,
    })
    expect(session.persisted).toBe(false)
    expect(existsSync(join(projectDir, '.kode', 'settings.local.json'))).toBe(
      false,
    )

    const policy = persistToolPermissionUpdateToDisk({
      update: {
        type: 'replaceRules',
        destination: 'policySettings',
        behavior: 'allow',
        rules: ['Bash(ls:*)'],
      },
      projectDir,
      homeDir,
    })
    expect(policy.persisted).toBe(false)
  })

  test('persists allow rules to localSettings (.kode/settings.local.json)', () => {
    const added = persistToolPermissionUpdateToDisk({
      update: {
        type: 'addRules',
        destination: 'localSettings',
        behavior: 'allow',
        rules: ['Bash(ls:*)'],
      },
      projectDir,
      homeDir,
    })
    expect(added.persisted).toBe(true)

    const settingsPath = join(projectDir, '.kode', 'settings.local.json')
    expect(existsSync(settingsPath)).toBe(true)
    expect(existsSync(join(projectDir, '.claude', 'settings.local.json'))).toBe(
      false,
    )
    const parsed = JSON.parse(readFileSync(settingsPath, 'utf-8'))
    expect(parsed.permissions.allow).toContain('Bash(ls:*)')

    const removed = persistToolPermissionUpdateToDisk({
      update: {
        type: 'removeRules',
        destination: 'localSettings',
        behavior: 'allow',
        rules: ['Bash(ls:*)'],
      },
      projectDir,
      homeDir,
    })
    expect(removed.persisted).toBe(true)
    const parsedAfter = JSON.parse(readFileSync(settingsPath, 'utf-8'))
    expect(parsedAfter.permissions.allow).toEqual([])
  })

  test('persists MCP wildcard rules without rewriting', () => {
    const added = persistToolPermissionUpdateToDisk({
      update: {
        type: 'addRules',
        destination: 'localSettings',
        behavior: 'allow',
        rules: ['mcp__srv__*'],
      },
      projectDir,
      homeDir,
    })
    expect(added.persisted).toBe(true)

    const settingsPath = join(projectDir, '.kode', 'settings.local.json')
    const parsed = JSON.parse(readFileSync(settingsPath, 'utf-8'))
    expect(parsed.permissions.allow).toContain('mcp__srv__*')
  })
})
