import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { getBunShellSandboxPlan } from '#core/sandbox/bunShellSandboxPlan'
import type { ToolUseContext } from '#core/tooling/Tool'

function writeJson(filePath: string, value: unknown) {
  mkdirSync(dirname(filePath), { recursive: true })
  writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf-8')
}

function makeToolUseContext(args: {
  projectDir: string
  homeDir: string
  applySeccompPath?: string | null
  bpfPath?: string | null
}): ToolUseContext {
  return {
    abortController: new AbortController(),
    messageId: 'test',
    readFileTimestamps: {},
    options: {
      commands: [],
      tools: [],
      verbose: false,
      safeMode: false,
      forkNumber: 0,
      messageLogName: 'test',
      maxThinkingTokens: 0,
      permissionMode: 'cautious',
      __sandboxProjectDir: args.projectDir,
      __sandboxHomeDir: args.homeDir,
      __sandboxPlatform: 'linux',
      __sandboxBwrapPath: '/usr/bin/bwrap',
      __sandboxSocatPath: '/usr/bin/socat',
      ...(args.applySeccompPath !== undefined
        ? { __sandboxApplySeccompPath: args.applySeccompPath }
        : {}),
      ...(args.bpfPath !== undefined
        ? { __sandboxSeccompBpfPath: args.bpfPath }
        : {}),
    },
  }
}

describe('Linux seccomp asset resolution (compatibility)', () => {
  let projectDir: string
  let homeDir: string

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), 'kode-seccomp-project-'))
    homeDir = mkdtempSync(join(tmpdir(), 'kode-seccomp-home-'))
  })

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true })
    rmSync(homeDir, { recursive: true, force: true })
  })

  test('includes linuxSeccomp when overrides point to existing assets', () => {
    writeJson(join(projectDir, '.claude', 'settings.json'), {
      sandbox: { enabled: true },
    })

    const applySeccompPath = join(projectDir, 'apply-seccomp')
    const bpfPath = join(projectDir, 'unix-block.bpf')
    writeFileSync(applySeccompPath, '#!/bin/sh\nexit 0\n', 'utf-8')
    chmodSync(applySeccompPath, 0o755)
    writeFileSync(bpfPath, 'bpf', 'utf-8')

    const plan = getBunShellSandboxPlan({
      command: 'echo hi',
      toolUseContext: makeToolUseContext({
        projectDir,
        homeDir,
        applySeccompPath,
        bpfPath,
      }),
    })

    expect(plan.willSandbox).toBe(true)
    expect(plan.bunShellSandboxOptions?.linuxSeccomp).toEqual({
      applySeccompPath,
      bpfPath,
    })
  })

  test('does not include linuxSeccomp when allowAllUnixSockets=true', () => {
    writeJson(join(projectDir, '.claude', 'settings.json'), {
      sandbox: { enabled: true, network: { allowAllUnixSockets: true } },
    })

    const applySeccompPath = join(projectDir, 'apply-seccomp')
    const bpfPath = join(projectDir, 'unix-block.bpf')
    writeFileSync(applySeccompPath, '#!/bin/sh\nexit 0\n', 'utf-8')
    chmodSync(applySeccompPath, 0o755)
    writeFileSync(bpfPath, 'bpf', 'utf-8')

    const plan = getBunShellSandboxPlan({
      command: 'echo hi',
      toolUseContext: makeToolUseContext({
        projectDir,
        homeDir,
        applySeccompPath,
        bpfPath,
      }),
    })

    expect(plan.willSandbox).toBe(true)
    expect(plan.bunShellSandboxOptions?.linuxSeccomp).toBeUndefined()
  })

  test('treats allowAllUnixSockets as effectively true when seccomp is unavailable', () => {
    writeJson(join(projectDir, '.claude', 'settings.json'), {
      sandbox: { enabled: true },
    })

    const plan = getBunShellSandboxPlan({
      command: 'echo hi',
      toolUseContext: makeToolUseContext({
        projectDir,
        homeDir,
        applySeccompPath: null,
        bpfPath: null,
      }),
    })

    expect(plan.willSandbox).toBe(true)
    expect(plan.bunShellSandboxOptions?.linuxSeccomp).toBeUndefined()
    expect(plan.bunShellSandboxOptions?.allowAllUnixSockets).toBe(true)
  })
})
