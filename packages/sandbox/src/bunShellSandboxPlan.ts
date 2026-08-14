import { homedir } from 'os'
import { join } from 'path'
import { existsSync } from 'node:fs'
import which from 'which'
import type { ToolUseContext } from '@kode/tool-interface/Tool'
import type { BunShellSandboxOptions } from '#runtime/shell'
import { resolveSandboxTmpDir } from '#runtime/shell/sandboxEnv'
import { warnSandbox } from './logging'
import {
  loadMergedSettings,
  normalizeSandboxRuntimeConfigFromSettings,
  type SandboxRuntimeConfig,
} from './sandboxConfig'
import { getCwd } from '#runtime/cwd'
import { resolveLinuxSeccompAssets } from './linuxSeccomp'

type SandboxIoOverrides = {
  projectDir?: string
  homeDir?: string
  platform?: NodeJS.Platform
  bwrapPath?: string | null
  socatPath?: string | null
  applySeccompPath?: string | null
  seccompBpfPath?: string | null
}

function getSandboxIoOverridesFromContext(
  context?: ToolUseContext,
): SandboxIoOverrides {
  const opts: any = context?.options ?? {}
  return {
    projectDir:
      typeof opts.__sandboxProjectDir === 'string'
        ? opts.__sandboxProjectDir
        : undefined,
    homeDir:
      typeof opts.__sandboxHomeDir === 'string'
        ? opts.__sandboxHomeDir
        : undefined,
    platform:
      typeof opts.__sandboxPlatform === 'string'
        ? (opts.__sandboxPlatform as NodeJS.Platform)
        : undefined,
    bwrapPath:
      opts.__sandboxBwrapPath === undefined
        ? undefined
        : (opts.__sandboxBwrapPath as string | null),
    socatPath:
      opts.__sandboxSocatPath === undefined
        ? undefined
        : (opts.__sandboxSocatPath as string | null),
    applySeccompPath:
      opts.__sandboxApplySeccompPath === undefined
        ? undefined
        : (opts.__sandboxApplySeccompPath as string | null),
    seccompBpfPath:
      opts.__sandboxSeccompBpfPath === undefined
        ? undefined
        : (opts.__sandboxSeccompBpfPath as string | null),
  }
}

function uniqueStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const out: string[] = []
  const seen = new Set<string>()
  for (const item of value) {
    if (typeof item !== 'string') continue
    const trimmed = item.trim()
    if (!trimmed) continue
    if (seen.has(trimmed)) continue
    seen.add(trimmed)
    out.push(trimmed)
  }
  return out
}

function uniqueStringsUnion(...lists: string[][]): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const list of lists) {
    for (const item of list) {
      const trimmed = item.trim()
      if (!trimmed) continue
      if (seen.has(trimmed)) continue
      seen.add(trimmed)
      out.push(trimmed)
    }
  }
  return out
}

// Compatibility: allow-write paths for the sandbox runtime.
function getSandboxDefaultWriteAllowPaths(homeDir: string): string[] {
  const out: string[] = [
    '/dev/stdout',
    '/dev/stderr',
    '/dev/null',
    '/dev/tty',
    '/dev/dtracehelper',
    '/dev/autofs_nowait',
  ]

  const addTmpAliasPaths = (tmpDir: string) => {
    out.push(tmpDir)
    if (tmpDir.startsWith('/tmp/')) out.push('/private' + tmpDir)
    else if (tmpDir.startsWith('/var/')) out.push('/private' + tmpDir)
    else if (tmpDir.startsWith('/private/tmp/'))
      out.push(tmpDir.replace('/private', ''))
    else if (tmpDir.startsWith('/private/var/'))
      out.push(tmpDir.replace('/private', ''))
  }

  const tmpDir = resolveSandboxTmpDir()
  if (tmpDir) addTmpAliasPaths(tmpDir)

  out.push(join(homeDir, '.npm', '_logs'))
  out.push(join(homeDir, '.kode', 'debug'))
  return out
}

export type BunShellSandboxSettings = {
  enabled: boolean
  autoAllowBashIfSandboxed: boolean
  allowUnsandboxedCommands: boolean
  excludedCommands: string[]
}

export type BunShellSandboxPlan = {
  settings: BunShellSandboxSettings
  runtimeConfig: SandboxRuntimeConfig
  sandboxAvailable: boolean
  isExcluded: boolean
  willSandbox: boolean
  shouldAutoAllowBashPermissions: boolean
  shouldBlockUnsandboxedCommand: boolean
  bunShellSandboxOptions: BunShellSandboxOptions | undefined
}

function matchExcludedCommand(
  command: string,
  excludedCommands: string[],
): boolean {
  const trimmed = command.trim()
  if (!trimmed) return false
  for (const raw of excludedCommands) {
    const entry = raw.trim()
    if (!entry) continue
    if (entry.endsWith(':*')) {
      const prefix = entry.slice(0, -2).trim()
      if (!prefix) continue
      if (trimmed === prefix) return true
      if (trimmed.startsWith(prefix + ' ')) return true
      continue
    }
    if (trimmed === entry) return true
  }
  return false
}

function isSandboxAvailable(context?: ToolUseContext): boolean {
  const overrides = getSandboxIoOverridesFromContext(context)
  const platform = overrides.platform ?? process.platform
  if (platform === 'linux') {
    const bwrapPath =
      overrides.bwrapPath !== undefined
        ? overrides.bwrapPath
        : (which.sync('bwrap', { nothrow: true }) ??
          which.sync('bubblewrap', { nothrow: true }))
    const socatPath =
      overrides.socatPath !== undefined
        ? overrides.socatPath
        : which.sync('socat', { nothrow: true })
    return (
      typeof bwrapPath === 'string' &&
      bwrapPath.length > 0 &&
      typeof socatPath === 'string' &&
      socatPath.length > 0
    )
  }

  if (platform === 'darwin') {
    const sandboxExecPath = existsSync('/usr/bin/sandbox-exec')
      ? '/usr/bin/sandbox-exec'
      : which.sync('sandbox-exec', { nothrow: true })
    return typeof sandboxExecPath === 'string' && sandboxExecPath.length > 0
  }

  return false
}

function getSandboxDirs(context?: ToolUseContext): {
  projectDir: string
  homeDir: string
} {
  const overrides = getSandboxIoOverridesFromContext(context)
  return {
    projectDir: overrides.projectDir ?? getCwd(),
    homeDir: overrides.homeDir ?? homedir(),
  }
}

function getSandboxSettings(settingsFile: any): BunShellSandboxSettings {
  const sandbox = settingsFile?.sandbox ?? {}
  return {
    enabled: sandbox?.enabled === true,
    autoAllowBashIfSandboxed:
      typeof sandbox?.autoAllowBashIfSandboxed === 'boolean'
        ? sandbox.autoAllowBashIfSandboxed
        : true,
    allowUnsandboxedCommands:
      typeof sandbox?.allowUnsandboxedCommands === 'boolean'
        ? sandbox.allowUnsandboxedCommands
        : true,
    excludedCommands: uniqueStrings(sandbox?.excludedCommands),
  }
}

export function getBunShellSandboxPlan(args: {
  command: string
  dangerouslyDisableSandbox?: boolean
  toolUseContext?: ToolUseContext
}): BunShellSandboxPlan {
  const { projectDir, homeDir } = getSandboxDirs(args.toolUseContext)
  const ioOverrides = getSandboxIoOverridesFromContext(args.toolUseContext)
  const platform = ioOverrides.platform ?? process.platform

  const merged = loadMergedSettings({ projectDir, homeDir })
  const runtimeConfig = normalizeSandboxRuntimeConfigFromSettings(merged, {
    projectDir,
    homeDir,
  })

  const settings = getSandboxSettings(merged)
  const sandboxEnabled = settings.enabled === true

  const sandboxAvailable = isSandboxAvailable(args.toolUseContext)
  const isExcluded = matchExcludedCommand(
    args.command,
    settings.excludedCommands,
  )

  // Compatibility: dangerouslyDisableSandbox only disables sandboxing when unsandboxed commands are allowed.
  const dangerousDisableEffective =
    args.dangerouslyDisableSandbox === true &&
    settings.allowUnsandboxedCommands === true

  // Compatibility: only "enabled" when the sandbox runtime is available for this platform.
  const willSandbox =
    sandboxEnabled &&
    sandboxAvailable &&
    !dangerousDisableEffective &&
    !isExcluded
  const shouldAutoAllowBashPermissions =
    willSandbox && settings.autoAllowBashIfSandboxed
  const shouldBlockUnsandboxedCommand =
    sandboxEnabled &&
    !settings.allowUnsandboxedCommands &&
    !willSandbox &&
    !isExcluded

  // Compatibility: sandboxed commands run with network restrictions enabled by default.
  const needsNetworkRestriction = sandboxEnabled

  const wantsUnixSocketBlocking =
    platform === 'linux' &&
    willSandbox &&
    runtimeConfig.network.allowAllUnixSockets !== true

  const linuxSeccomp = wantsUnixSocketBlocking
    ? resolveLinuxSeccompAssets({
        applySeccompPathOverride: ioOverrides.applySeccompPath,
        bpfPathOverride: ioOverrides.seccompBpfPath,
      })
    : null

  const effectiveAllowAllUnixSockets =
    runtimeConfig.network.allowAllUnixSockets === true ||
    (wantsUnixSocketBlocking && !linuxSeccomp)

  if (wantsUnixSocketBlocking && !linuxSeccomp && sandboxAvailable) {
    warnSandbox('SANDBOX_LINUX_SECCOMP_UNAVAILABLE', {
      arch: process.arch,
      message:
        'Seccomp filtering not available. Sandbox will run without Unix socket blocking (allowAllUnixSockets effective).',
    })
  }

  const bunShellSandboxOptions: BunShellSandboxOptions | undefined = willSandbox
    ? {
        enabled: true,
        require: !settings.allowUnsandboxedCommands,
        needsNetworkRestriction,
        allowUnixSockets: runtimeConfig.network.allowUnixSockets,
        allowAllUnixSockets: effectiveAllowAllUnixSockets,
        allowLocalBinding: runtimeConfig.network.allowLocalBinding,
        httpProxyPort: runtimeConfig.network.httpProxyPort,
        socksProxyPort: runtimeConfig.network.socksProxyPort,
        ...(platform === 'linux' && linuxSeccomp ? { linuxSeccomp } : {}),
        readConfig: { denyOnly: runtimeConfig.filesystem.denyRead },
        writeConfig: {
          allowOnly: uniqueStringsUnion(
            runtimeConfig.filesystem.allowWrite,
            getSandboxDefaultWriteAllowPaths(homeDir),
          ),
          denyWithinAllow: runtimeConfig.filesystem.denyWrite,
        },
        enableWeakerNestedSandbox: runtimeConfig.enableWeakerNestedSandbox,
        chdir: projectDir,
      }
    : undefined

  return {
    settings,
    runtimeConfig,
    sandboxAvailable,
    isExcluded,
    willSandbox,
    shouldAutoAllowBashPermissions,
    shouldBlockUnsandboxedCommand,
    bunShellSandboxOptions,
  }
}
