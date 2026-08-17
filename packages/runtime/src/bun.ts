import { chmod, mkdir, readdir, realpath, rm, stat } from 'node:fs/promises'
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
      return await Bun.file(path).text()
    },
    readFileBytes: async (path: string) =>
      new Uint8Array(await Bun.file(path).arrayBuffer()),
    writeFile: async (path: string, data: string | Uint8Array) => {
      await Bun.write(path, data)
    },
    exists: async (path: string) => await Bun.file(path).exists(),
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

type SimpleStdio = 'inherit' | 'pipe' | 'ignore'

function normalizeStdioValue(v: SpawnStdio | undefined): SimpleStdio {
  if (!v) return 'inherit'
  if (Array.isArray(v)) return v[0] ?? 'inherit'
  return v
}

function resolveBunStdio(spec: SpawnSpec): {
  stdin: SimpleStdio
  stdout: SimpleStdio
  stderr: SimpleStdio
} {
  const triplet = Array.isArray(spec.stdin)
    ? spec.stdin
    : Array.isArray(spec.stdout)
      ? spec.stdout
      : Array.isArray(spec.stderr)
        ? spec.stderr
        : null

  if (triplet) {
    return {
      stdin: triplet[0] ?? 'inherit',
      stdout: triplet[1] ?? 'inherit',
      stderr: triplet[2] ?? 'inherit',
    }
  }

  return {
    stdin: normalizeStdioValue(spec.stdin),
    stdout: normalizeStdioValue(spec.stdout),
    stderr: normalizeStdioValue(spec.stderr),
  }
}

function createProcess(): RuntimeProcess {
  return {
    cwd: () => process.cwd(),
    chdir: (path: string) => process.chdir(path),
    spawn: (spec: SpawnSpec): RuntimeSubprocess => {
      const stdio = resolveBunStdio(spec)
      const proc = Bun.spawn(spec.cmd, {
        cwd: spec.cwd,
        env: spec.env,
        stdin: stdio.stdin,
        stdout: stdio.stdout,
        stderr: stdio.stderr,
      })

      const maybeKill = (signal?: string | number) => {
        try {
          if (typeof signal === 'number') {
            proc.kill(signal)
            return
          }
          if (typeof signal === 'string') {
            proc.kill(signal as NodeJS.Signals)
            return
          }
          proc.kill()
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
        void proc.exited.finally(() => clearTimeout(timer))
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

      const stdoutPromise =
        spec.stdout === 'pipe'
          ? typeof proc.stdout !== 'number'
            ? new Response(proc.stdout).text()
            : Promise.resolve('')
          : Promise.resolve(undefined)
      const stderrPromise =
        spec.stderr === 'pipe'
          ? typeof proc.stderr !== 'number'
            ? new Response(proc.stderr).text()
            : Promise.resolve('')
          : Promise.resolve(undefined)

      const exited: Promise<SpawnResult> = Promise.all([
        proc.exited,
        stdoutPromise,
        stderrPromise,
      ]).then(([exitCode, stdout, stderr]) => {
        const result: SpawnResult = { exitCode }
        if (stdout !== undefined) result.stdout = stdout
        if (stderr !== undefined) result.stderr = stderr
        return result
      })

      return {
        pid: proc.pid,
        kill: (signal?: string | number) => maybeKill(signal),
        exited,
      }
    },
  }
}

export function createBunRuntime(opts?: { log?: RuntimeLogger }): Runtime {
  return {
    fs: createFs(),
    env: createEnv(),
    os: createOs(),
    clock: createClock(),
    process: createProcess(),
    log: opts?.log ?? defaultLogger(),
  }
}
