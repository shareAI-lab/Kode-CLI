import {
  access,
  chmod,
  mkdir,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { constants as fsConstants } from 'node:fs'
import { spawn } from 'node:child_process'
import type { StdioOptions } from 'node:child_process'
import { homedir, tmpdir } from 'node:os'

import type {
  FileStat,
  Runtime,
  RuntimeClock,
  RuntimeEnv,
  RuntimeFS,
  RuntimeLogger,
  RuntimeOS,
  RuntimeProcess,
  RuntimeSubprocess,
  SpawnResult,
  SpawnSpec,
  SpawnStdio,
} from '#runtime'

function defaultLogger(): RuntimeLogger {
  return {
    debug: (m: string) => console.debug(m),
    info: (m: string) => console.info(m),
    warn: (m: string) => console.warn(m),
    error: (m: string) => console.error(m),
  }
}

function toAbortError(reason?: unknown): Error {
  if (reason instanceof Error) return reason
  return new DOMException(
    typeof reason === 'string' && reason.trim() ? reason : 'Aborted',
    'AbortError',
  )
}

function createClock(): RuntimeClock {
  return {
    now: () => Date.now(),
    sleep: (ms: number, signal?: AbortSignal) =>
      new Promise<void>((resolve, reject) => {
        if (signal?.aborted) {
          reject(toAbortError(signal.reason))
          return
        }

        const timer = setTimeout(
          () => {
            cleanup()
            resolve()
          },
          Math.max(0, ms),
        )

        const onAbort = (_ev: Event) => {
          cleanup()
          reject(toAbortError(signal?.reason))
        }

        const cleanup = () => {
          clearTimeout(timer)
          signal?.removeEventListener('abort', onAbort)
        }

        signal?.addEventListener('abort', onAbort, { once: true })
      }),
  }
}

function createEnv(): RuntimeEnv {
  return {
    get: (name: string) => process.env[name],
    set: (name: string, value: string) => {
      process.env[name] = value
    },
    has: (name: string) =>
      Object.prototype.hasOwnProperty.call(process.env, name),
    delete: (name: string) => {
      delete process.env[name]
    },
    toObject: () => ({ ...process.env }),
  }
}

function createOs(): RuntimeOS {
  return {
    platform: () => process.platform,
    arch: () => process.arch,
    homedir: () => homedir(),
    tmpdir: () => tmpdir(),
  }
}

function createFs(): RuntimeFS {
  return {
    readFile: async (path: string, encoding?: 'utf8') => {
      if (encoding && encoding !== 'utf8') {
        throw new Error(`Unsupported encoding: ${encoding}`)
      }
      return await readFile(path, 'utf8')
    },
    readFileBytes: async (path: string) => new Uint8Array(await readFile(path)),
    writeFile: async (path: string, data: string | Uint8Array) => {
      await writeFile(path, data)
    },
    exists: async (path: string) => {
      try {
        await access(path, fsConstants.F_OK)
        return true
      } catch {
        return false
      }
    },
    mkdir: async (path: string, options?: { recursive?: boolean }) => {
      await mkdir(path, { recursive: options?.recursive ?? false })
    },
    rm: async (
      path: string,
      options?: { recursive?: boolean; force?: boolean },
    ) => {
      await rm(path, {
        recursive: options?.recursive ?? false,
        force: options?.force ?? false,
      })
    },
    readdir: async (path: string) => await readdir(path),
    stat: async (path: string): Promise<FileStat> => {
      const s = await stat(path)
      return {
        isFile: s.isFile(),
        isDirectory: s.isDirectory(),
        size: s.size,
        mtimeMs: s.mtimeMs,
      }
    },
    realpath: async (path: string) => await realpath(path),
    chmod: async (path: string, mode: number) => {
      await chmod(path, mode)
    },
  }
}

function normalizeStdioValue(v: SpawnStdio | undefined): SpawnStdio {
  return v ?? 'inherit'
}

function resolveNodeStdio(spec: SpawnSpec): StdioOptions {
  const stdin = normalizeStdioValue(spec.stdin)
  const stdout = normalizeStdioValue(spec.stdout)
  const stderr = normalizeStdioValue(spec.stderr)

  if (Array.isArray(stdin)) return stdin
  if (Array.isArray(stdout)) return stdout
  if (Array.isArray(stderr)) return stderr

  return [stdin, stdout, stderr]
}

function createProcess(): RuntimeProcess {
  return {
    cwd: () => process.cwd(),
    chdir: (path: string) => process.chdir(path),
    spawn: (spec: SpawnSpec): RuntimeSubprocess => {
      const child = spawn(spec.cmd[0]!, spec.cmd.slice(1), {
        cwd: spec.cwd,
        env: spec.env,
        stdio: resolveNodeStdio(spec),
        windowsHide: true,
      })

      const maybeKill = (signal?: string | number) => {
        try {
          if (typeof signal === 'number') {
            child.kill(signal)
            return
          }
          if (typeof signal === 'string') {
            child.kill(signal as NodeJS.Signals)
            return
          }
          child.kill()
        } catch {
          /* no-op */
        }
      }

      if (
        spec.timeoutMs &&
        Number.isFinite(spec.timeoutMs) &&
        spec.timeoutMs > 0
      ) {
        const timer = setTimeout(() => maybeKill('SIGTERM'), spec.timeoutMs)
        child.once('exit', () => clearTimeout(timer))
        child.once('error', () => clearTimeout(timer))
      }

      if (spec.signal) {
        if (spec.signal.aborted) {
          maybeKill('SIGTERM')
        } else {
          spec.signal.addEventListener('abort', () => maybeKill('SIGTERM'), {
            once: true,
          })
        }
      }

      const wantStdout = spec.stdout === 'pipe'
      const wantStderr = spec.stderr === 'pipe'

      let stdout = ''
      let stderr = ''

      if (wantStdout && child.stdout) {
        child.stdout.setEncoding('utf8')
        child.stdout.on('data', chunk => {
          stdout += String(chunk)
        })
      }
      if (wantStderr && child.stderr) {
        child.stderr.setEncoding('utf8')
        child.stderr.on('data', chunk => {
          stderr += String(chunk)
        })
      }

      const exited: Promise<SpawnResult> = new Promise((resolve, reject) => {
        child.once('error', reject)
        child.once('close', (code: number | null) => {
          const result: SpawnResult = {
            exitCode: typeof code === 'number' ? code : 1,
          }
          if (wantStdout) result.stdout = stdout
          if (wantStderr) result.stderr = stderr
          resolve(result)
        })
      })

      return {
        pid: child.pid,
        kill: (signal?: string | number) => maybeKill(signal),
        exited,
      }
    },
  }
}

export function createNodeRuntime(opts?: { log?: RuntimeLogger }): Runtime {
  return {
    fs: createFs(),
    env: createEnv(),
    os: createOs(),
    clock: createClock(),
    process: createProcess(),
    log: opts?.log ?? defaultLogger(),
  }
}
