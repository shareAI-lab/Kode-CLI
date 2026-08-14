import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ChildProcess } from 'node:child_process'

export type LinuxSandboxBridge = {
  httpSocketPath: string
  socksSocketPath: string
}

export type LinuxSandboxBridgeState = LinuxSandboxBridge & {
  httpBridgeProcess: ChildProcess
  socksBridgeProcess: ChildProcess
}

function safeUnlink(path: string): void {
  try {
    rmSync(path, { force: true })
  } catch {
    // ignore
  }
}

function safeKill(
  proc: ChildProcess,
  signal: NodeJS.Signals = 'SIGTERM',
): void {
  try {
    if (proc.pid) process.kill(proc.pid, signal)
  } catch {
    // ignore
  }
}

export async function startLinuxSandboxBridge(args: {
  hostHttpProxyPort: number
  hostSocksProxyPort: number
}): Promise<LinuxSandboxBridgeState> {
  const suffix = randomBytes(8).toString('hex')
  const base = tmpdir()
  const httpSocketPath = join(base, `kode-http-${suffix}.sock`)
  const socksSocketPath = join(base, `kode-socks-${suffix}.sock`)

  safeUnlink(httpSocketPath)
  safeUnlink(socksSocketPath)

  const httpArgs = [
    `UNIX-LISTEN:${httpSocketPath},fork,reuseaddr`,
    `TCP:localhost:${args.hostHttpProxyPort},keepalive,keepidle=10,keepintvl=5,keepcnt=3`,
  ]
  const httpBridgeProcess = spawn('socat', httpArgs, { stdio: 'ignore' })
  if (!httpBridgeProcess.pid) {
    throw new Error('Failed to start Linux HTTP bridge process (socat)')
  }

  const socksArgs = [
    `UNIX-LISTEN:${socksSocketPath},fork,reuseaddr`,
    `TCP:localhost:${args.hostSocksProxyPort},keepalive,keepidle=10,keepintvl=5,keepcnt=3`,
  ]
  const socksBridgeProcess = spawn('socat', socksArgs, { stdio: 'ignore' })
  if (!socksBridgeProcess.pid) {
    safeKill(httpBridgeProcess)
    throw new Error('Failed to start Linux SOCKS bridge process (socat)')
  }

  const attempts = 5
  for (let i = 0; i < attempts; i++) {
    if (!httpBridgeProcess.pid || httpBridgeProcess.killed) break
    if (!socksBridgeProcess.pid || socksBridgeProcess.killed) break

    if (existsSync(httpSocketPath) && existsSync(socksSocketPath)) {
      return {
        httpSocketPath,
        socksSocketPath,
        httpBridgeProcess,
        socksBridgeProcess,
      }
    }

    await new Promise(resolve => setTimeout(resolve, i * 100))
  }

  safeKill(httpBridgeProcess)
  safeKill(socksBridgeProcess)
  safeUnlink(httpSocketPath)
  safeUnlink(socksSocketPath)
  throw new Error('Failed to create Linux sandbox bridge sockets (socat)')
}

export function stopLinuxSandboxBridge(state: LinuxSandboxBridgeState): void {
  safeKill(state.httpBridgeProcess)
  safeKill(state.socksBridgeProcess)
  safeUnlink(state.httpSocketPath)
  safeUnlink(state.socksSocketPath)
}
