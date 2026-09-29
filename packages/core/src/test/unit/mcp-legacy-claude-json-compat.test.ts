import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { getProjectMcpServerDefinitions } from '#config'
import { getCwd, setCwd } from '#core/utils/state'
import { getMcprcServerStatus, listMCPServers } from '#core/mcp/client'
import { __resetMcpListChangedForTests } from '#core/mcp/client/listChanged'

describe('MCP legacy .claude.json compatibility', () => {
  let previousHome: string | undefined
  let previousKodeConfigDir: string | undefined
  let previousNodeEnv: string | undefined
  let runnerCwd: string

  let homeDir: string
  let configDir: string
  let projectDir: string

  beforeEach(async () => {
    previousHome = process.env.HOME
    previousKodeConfigDir = process.env.KODE_CONFIG_DIR
    previousNodeEnv = process.env.NODE_ENV
    runnerCwd = getCwd()

    homeDir = mkdtempSync(join(tmpdir(), 'kode-home-'))
    configDir = mkdtempSync(join(tmpdir(), 'kode-config-'))
    projectDir = mkdtempSync(join(tmpdir(), 'kode-project-'))

    process.env.HOME = homeDir
    process.env.KODE_CONFIG_DIR = configDir
    // This test exercises the real legacy-config -> .mcp.json approval path,
    // which `getProjectMcpServerDefinitions` short-circuits under NODE_ENV=test.
    process.env.NODE_ENV = 'production'
    // `getProjectMcpServerDefinitions` is memoized and the memo is NOT
    // NODE_ENV-aware (verified: a value cached under NODE_ENV=test is still
    // returned after switching to 'production'). Clear it so this suite's
    // result cannot depend on whether an earlier suite already called it.
    ;(
      getProjectMcpServerDefinitions as unknown as { cache?: { clear(): void } }
    ).cache?.clear()

    await setCwd(projectDir)
    __resetMcpListChangedForTests()

    writeFileSync(
      join(projectDir, '.mcp.json'),
      JSON.stringify(
        {
          mcpServers: {
            compatShared: {
              command: 'npx',
              args: ['shared-mcp@latest'],
            },
          },
        },
        null,
        2,
      ),
      'utf-8',
    )

    writeFileSync(
      join(homeDir, '.claude.json'),
      JSON.stringify(
        {
          mcpServers: {
            legacyUser: {
              command: 'npx',
              args: ['legacy-user-mcp@latest'],
            },
          },
          projects: {
            [projectDir]: {
              mcpServers: {
                legacyLocal: {
                  command: 'npx',
                  args: ['legacy-local-mcp@latest'],
                },
              },
              enabledMcpjsonServers: ['compatShared'],
              disabledMcpjsonServers: [],
            },
          },
        },
        null,
        2,
      ),
      'utf-8',
    )
  })

  afterEach(async () => {
    await setCwd(runnerCwd)

    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome

    if (previousKodeConfigDir === undefined) delete process.env.KODE_CONFIG_DIR
    else process.env.KODE_CONFIG_DIR = previousKodeConfigDir

    if (previousNodeEnv === undefined) delete process.env.NODE_ENV
    else process.env.NODE_ENV = previousNodeEnv

    rmSync(homeDir, { recursive: true, force: true })
    rmSync(configDir, { recursive: true, force: true })
    rmSync(projectDir, { recursive: true, force: true })
  })

  test('imports user + local MCP servers from legacy config', () => {
    const servers = listMCPServers()
    expect(Object.keys(servers)).toContain('legacyUser')
    expect(Object.keys(servers)).toContain('legacyLocal')
  })

  test('respects enabledMcpjsonServers from legacy project config', () => {
    expect(getMcprcServerStatus('compatShared')).toBe('approved')
  })
})
