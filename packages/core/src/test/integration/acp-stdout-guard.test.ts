import { describe, expect, test } from 'bun:test'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

type JsonRpcMessage = {
  jsonrpc?: string
  id?: string | number | null
  method?: string
  params?: any
  result?: any
  error?: any
}

function createAcpProcess(options: { configDir: string }) {
  const repoRoot = process.cwd()

  const proc = spawn(process.execPath, ['apps/cli/src/dispatch.ts', '--acp'], {
    cwd: repoRoot,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      NODE_ENV: 'test',
      KODE_CONFIG_DIR: options.configDir,
      KODE_ACP_ECHO: '1',
    },
  })

  const stdoutBuffer: string[] = []
  const stderrBuffer: string[] = []
  const messages: JsonRpcMessage[] = []
  const nonJsonLines: string[] = []

  let stdoutPartial = ''
  let waiters: Array<() => void> = []

  const notify = () => {
    const current = waiters
    waiters = []
    for (const w of current) w()
  }

  proc.stdout?.on('data', chunk => {
    const text = chunk.toString('utf8')
    stdoutBuffer.push(text)
    stdoutPartial += text
    while (true) {
      const idx = stdoutPartial.indexOf('\n')
      if (idx < 0) break
      const line = stdoutPartial.slice(0, idx).trim()
      stdoutPartial = stdoutPartial.slice(idx + 1)
      if (!line) continue
      try {
        messages.push(JSON.parse(line))
      } catch {
        nonJsonLines.push(line)
      } finally {
        notify()
      }
    }
  })

  proc.stderr?.on('data', chunk => {
    stderrBuffer.push(chunk.toString('utf8'))
  })

  const send = (msg: JsonRpcMessage) => {
    proc.stdin?.write(`${JSON.stringify(msg)}\n`)
  }

  const waitFor = async (
    predicate: (msg: JsonRpcMessage) => boolean,
    timeoutMs: number,
  ) => {
    const deadline = Date.now() + timeoutMs
    while (true) {
      const idx = messages.findIndex(predicate)
      if (idx >= 0) return messages.splice(idx, 1)[0]!

      const remaining = deadline - Date.now()
      if (remaining <= 0) {
        throw new Error(
          `ACP waitFor timeout after ${timeoutMs}ms\n\nnonJson:\n${nonJsonLines.join(
            '\n',
          )}\n\nstderr:\n${stderrBuffer.join('')}\n\nstdout:\n${stdoutBuffer.join('')}`,
        )
      }

      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          cleanup()
          reject(new Error('timeout'))
        }, remaining)
        const cleanup = () => {
          clearTimeout(timer)
          waiters = waiters.filter(w => w !== resolve)
        }
        waiters.push(resolve)
      })
    }
  }

  const stop = async () => {
    try {
      proc.stdin?.end()
    } catch {
      /* no-op */
    }
    try {
      proc.kill('SIGTERM')
    } catch {
      /* no-op */
    }
  }

  return { proc, send, waitFor, stop, nonJsonLines }
}

describe('ACP stdout guard', () => {
  test('stdout contains only JSON-RPC lines', async () => {
    const repoRoot = process.cwd()
    const configDir = mkdtempSync(join(tmpdir(), 'kode-acp-stdout-guard-'))

    try {
      const acp = createAcpProcess({ configDir })
      try {
        acp.send({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: 1,
            clientCapabilities: { terminal: true },
            clientInfo: { name: 'test', version: '0.0.0' },
          },
        })

        const initRes = await acp.waitFor(m => m.id === 1, 10_000)
        expect(initRes.error).toBeUndefined()
        expect(initRes.result?.protocolVersion).toBe(1)

        expect(acp.nonJsonLines).toEqual([])
      } finally {
        await acp.stop()
      }
    } finally {
      rmSync(configDir, { recursive: true, force: true })
    }
  })
})
