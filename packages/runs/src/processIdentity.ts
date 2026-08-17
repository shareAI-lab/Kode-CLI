import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

import type { DurableRunProcessIdentity } from './types'

function validPid(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0
}

function linuxStartToken(pid: number): string | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    const endOfCommand = stat.lastIndexOf(')')
    if (endOfCommand < 0) return null
    // Field 3 starts immediately after ") "; process start time is field 22.
    const fields = stat
      .slice(endOfCommand + 2)
      .trim()
      .split(/\s+/)
    const startTime = fields[19]
    return startTime ? `linux:${startTime}` : null
  } catch {
    return null
  }
}

function darwinStartToken(pid: number): string | null {
  try {
    const value = execFileSync(
      '/bin/ps',
      ['-o', 'lstart=', '-p', String(pid)],
      {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      },
    ).trim()
    return value ? `darwin:${value}` : null
  } catch {
    return null
  }
}

function windowsStartToken(pid: number): string | null {
  try {
    const command =
      `$process = Get-Process -Id ${pid} -ErrorAction Stop; ` +
      '[Console]::Out.Write($process.StartTime.ToUniversalTime().Ticks)'
    const value = execFileSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', command],
      {
        encoding: 'utf8',
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore'],
      },
    ).trim()
    return value ? `win:${value}` : null
  } catch {
    return null
  }
}

function processStartToken(
  pid: number,
  platform: NodeJS.Platform,
): string | null {
  if (platform === 'linux') return linuxStartToken(pid)
  if (platform === 'darwin') return darwinStartToken(pid)
  if (platform === 'win32') return windowsStartToken(pid)
  return null
}

/**
 * Captures an OS process identity that is safe against PID reuse. Unsupported
 * platforms intentionally return null rather than treating a PID as identity.
 */
export function getDurableRunProcessIdentity(
  pid: number | undefined,
  platform: NodeJS.Platform = process.platform,
): DurableRunProcessIdentity | null {
  if (pid === undefined || !validPid(pid)) return null
  const startToken = processStartToken(pid, platform)
  return startToken ? { pid, startToken } : null
}

export function probeDurableRunProcess(
  identity: DurableRunProcessIdentity,
  platform: NodeJS.Platform = process.platform,
): { alive: boolean; startToken?: string } {
  const startToken = getDurableRunProcessIdentity(
    identity.pid,
    platform,
  )?.startToken
  return startToken ? { alive: true, startToken } : { alive: false }
}
