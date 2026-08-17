import { existsSync, mkdirSync } from 'fs'
import which from 'which'
import { buildLinuxBwrapCommand } from './linuxSandbox'
import { buildMacosSandboxExecCommand } from './macosSandbox'
import { resolveSandboxTmpDir } from './sandboxEnv'
import type {
  BunShellSandboxOptions,
  BunShellSandboxReadConfig,
  BunShellSandboxWriteConfig,
} from './types'

export function maybeAnnotateMacosSandboxStderr(
  stderr: string,
  sandbox: BunShellSandboxOptions | undefined,
): string {
  return stderr
}

export function isSandboxInitFailure(stderr: string): boolean {
  const s = stderr.toLowerCase()
  return (
    s.includes('bwrap:') ||
    s.includes('bubblewrap') ||
    (s.includes('namespace') && s.includes('failed'))
  )
}

export function buildSandboxCommand(options: {
  command: string
  sandbox: BunShellSandboxOptions
  cwd: string
}): { cmd: string[] } | null {
  const sandbox = options.sandbox
  if (!sandbox.enabled) return null
  const platform = sandbox.__platformOverride ?? process.platform

  const needsNetworkRestriction =
    sandbox.needsNetworkRestriction !== undefined
      ? sandbox.needsNetworkRestriction
      : sandbox.allowNetwork === true
        ? false
        : true

  const writeConfig: BunShellSandboxWriteConfig | undefined =
    sandbox.writeConfig ??
    (sandbox.writableRoots && sandbox.writableRoots.length > 0
      ? { allowOnly: sandbox.writableRoots.filter(Boolean) }
      : undefined)

  const readConfig: BunShellSandboxReadConfig | undefined = sandbox.readConfig

  const hasReadRestrictions = (readConfig?.denyOnly?.length ?? 0) > 0
  const hasWriteRestrictions = writeConfig !== undefined
  const hasNetworkRestrictions = needsNetworkRestriction === true

  // Compatibility: if there are no restrictions, do not wrap.
  if (
    !hasReadRestrictions &&
    !hasWriteRestrictions &&
    !hasNetworkRestrictions
  ) {
    return null
  }

  const binShell =
    sandbox.binShell ?? (which.sync('bash', { nothrow: true }) ? 'bash' : 'sh')
  const binShellPath = which.sync(binShell, { nothrow: true }) ?? binShell

  const cwd = sandbox.chdir || options.cwd

  if (platform === 'linux') {
    const bwrapPath =
      sandbox.__bwrapPathOverride !== undefined
        ? sandbox.__bwrapPathOverride
        : (which.sync('bwrap', { nothrow: true }) ??
          which.sync('bubblewrap', { nothrow: true }))
    if (!bwrapPath) return null

    const tmpDir = resolveSandboxTmpDir({ platform })
    try {
      mkdirSync(tmpDir, { recursive: true })
    } catch {
      /* no-op */
    }

    const cmd = buildLinuxBwrapCommand({
      bwrapPath,
      command: options.command,
      needsNetworkRestriction,
      httpProxyPort: sandbox.httpProxyPort,
      socksProxyPort: sandbox.socksProxyPort,
      linuxBridge: sandbox.linuxBridge,
      linuxSeccomp: sandbox.linuxSeccomp,
      readConfig,
      writeConfig,
      enableWeakerNestedSandbox: sandbox.enableWeakerNestedSandbox,
      binShellPath,
      cwd,
    })

    return { cmd }
  }

  if (platform === 'darwin') {
    const sandboxExecPath =
      sandbox.__sandboxExecPathOverride !== undefined
        ? sandbox.__sandboxExecPathOverride
        : existsSync('/usr/bin/sandbox-exec')
          ? '/usr/bin/sandbox-exec'
          : which.sync('sandbox-exec', { nothrow: true })
    if (!sandboxExecPath) return null

    const tmpDir = resolveSandboxTmpDir({ platform })
    const candidates = new Set<string>([tmpDir])
    if (tmpDir.startsWith('/tmp/')) candidates.add('/private' + tmpDir)
    else if (tmpDir.startsWith('/var/')) candidates.add('/private' + tmpDir)
    else if (tmpDir.startsWith('/private/tmp/'))
      candidates.add(tmpDir.replace('/private', ''))
    else if (tmpDir.startsWith('/private/var/'))
      candidates.add(tmpDir.replace('/private', ''))

    for (const candidate of candidates) {
      try {
        mkdirSync(candidate, { recursive: true })
      } catch {
        /* no-op */
      }
    }

    return {
      cmd: buildMacosSandboxExecCommand({
        sandboxExecPath,
        binShellPath,
        command: options.command,
        needsNetworkRestriction,
        httpProxyPort: sandbox.httpProxyPort,
        socksProxyPort: sandbox.socksProxyPort,
        allowUnixSockets: sandbox.allowUnixSockets,
        allowAllUnixSockets: sandbox.allowAllUnixSockets,
        allowLocalBinding: sandbox.allowLocalBinding,
        readConfig,
        writeConfig,
      }),
    }
  }

  // Windows / unknown platforms: sandbox not supported.
  return null
}
