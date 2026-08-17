import { spawn } from 'node:child_process'
import { basename, resolve } from 'node:path'

export type WorkspaceInfo = {
  id: string
  path: string
  title: string
  branch: string | null
  isCurrent: boolean
}

type ExecResult = {
  stdout: string
  stderr: string
  code: number
  interrupted: boolean
}

function parseWorktreePorcelain(
  stdout: string,
): Array<{ path: string; branch: string | null }> {
  const entries: Array<{ path: string; branch: string | null }> = []
  let current: { path: string; branch: string | null } | null = null

  const lines = stdout.split(/\r?\n/)
  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (!line) {
      if (current?.path) entries.push(current)
      current = null
      continue
    }
    if (line.startsWith('worktree ')) {
      if (current?.path) entries.push(current)
      current = { path: line.slice('worktree '.length).trim(), branch: null }
      continue
    }
    if (!current) continue
    if (line.startsWith('branch ')) {
      const ref = line.slice('branch '.length).trim()
      const branch = ref.startsWith('refs/heads/')
        ? ref.slice('refs/heads/'.length)
        : ref
      current.branch = branch || null
    }
  }
  if (current?.path) entries.push(current)
  return entries
}

async function execArgs(
  cmd: string[],
  options: {
    cwd: string
    abortSignal?: AbortSignal
    timeoutMs?: number
    env?: Record<string, string | undefined>
  },
): Promise<ExecResult> {
  const timeoutMs = options.timeoutMs ?? 120_000
  const abortController = new AbortController()
  let wasAborted = false
  let proc: ReturnType<typeof spawn> | null = null

  const onAbort = () => {
    wasAborted = true
    try {
      abortController.abort()
    } catch {
      /* no-op */
    }
    try {
      proc?.kill()
    } catch {
      /* no-op */
    }
  }

  if (options.abortSignal) {
    options.abortSignal.addEventListener('abort', onAbort, { once: true })
  }

  try {
    proc = spawn(cmd[0] ?? '', cmd.slice(1), {
      cwd: options.cwd,
      env: { ...process.env, ...(options.env ?? {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let stdout = ''
    let stderr = ''

    proc.stdout?.setEncoding('utf8')
    proc.stdout?.on('data', chunk => {
      stdout += chunk
    })
    proc.stderr?.setEncoding('utf8')
    proc.stderr?.on('data', chunk => {
      stderr += chunk
    })

    const exitPromise = new Promise<
      { kind: 'exit'; code: number | null } | { kind: 'error'; error: Error }
    >(resolve => {
      proc?.once('exit', code => resolve({ kind: 'exit', code }))
      proc?.once('error', error => resolve({ kind: 'error', error }))
    })

    let timeoutHandle: ReturnType<typeof setTimeout> | null = null
    const timeoutPromise = new Promise<'timeout'>(resolveTimeout => {
      timeoutHandle = setTimeout(() => resolveTimeout('timeout'), timeoutMs)
    })

    const outcome = await Promise.race([
      exitPromise.then(() => 'completed' as const),
      timeoutPromise,
    ])

    if (timeoutHandle) clearTimeout(timeoutHandle)

    if (outcome === 'timeout') {
      onAbort()
      try {
        await exitPromise
      } catch {
        /* no-op */
      }

      return {
        stdout: '',
        stderr: 'Command timed out',
        code: 143,
        interrupted: true,
      }
    }

    const exitOutcome = await exitPromise
    if (exitOutcome.kind === 'error') {
      stderr = [stderr, exitOutcome.error.message].filter(Boolean).join('\n')
    }

    const interrupted =
      wasAborted ||
      options.abortSignal?.aborted === true ||
      abortController.signal.aborted === true

    const code =
      exitOutcome.kind === 'exit' && typeof exitOutcome.code === 'number'
        ? exitOutcome.code
        : exitOutcome.kind === 'error'
          ? 2
          : interrupted
            ? 143
            : 0

    return { stdout, stderr, code, interrupted }
  } finally {
    if (options.abortSignal) {
      options.abortSignal.removeEventListener('abort', onAbort)
    }
  }
}

export function createWorkspaceLister(args: {
  cwd: string
  cacheTtlMs?: number
}): {
  listWorkspaces: () => Promise<{
    workspaces: WorkspaceInfo[]
    currentId: string
  }>
} {
  const workspaceCacheTtlMs = args.cacheTtlMs ?? 2_000
  let workspaceCache: {
    at: number
    workspaces: WorkspaceInfo[]
    currentId: string
  } | null = null

  const listWorkspaces = async (): Promise<{
    workspaces: WorkspaceInfo[]
    currentId: string
  }> => {
    const now = Date.now()
    if (workspaceCache && now - workspaceCache.at < workspaceCacheTtlMs) {
      return {
        workspaces: workspaceCache.workspaces,
        currentId: workspaceCache.currentId,
      }
    }

    const absCwd = resolve(args.cwd)
    const repoRootRes = await execArgs(
      ['git', 'rev-parse', '--show-toplevel'],
      {
        cwd: absCwd,
        timeoutMs: 2000,
      },
    )
    const repoRoot = repoRootRes.code === 0 ? repoRootRes.stdout.trim() : ''

    if (!repoRoot) {
      const only: WorkspaceInfo = {
        id: absCwd,
        path: absCwd,
        title: basename(absCwd) || absCwd,
        branch: null,
        isCurrent: true,
      }
      workspaceCache = { at: now, workspaces: [only], currentId: only.id }
      return { workspaces: [only], currentId: only.id }
    }

    const porcelainRes = await execArgs(
      ['git', 'worktree', 'list', '--porcelain'],
      { cwd: repoRoot, timeoutMs: 3000 },
    )
    const worktreeEntries =
      porcelainRes.code === 0 ? parseWorktreePorcelain(porcelainRes.stdout) : []

    const normalized = worktreeEntries
      .map(e => ({
        path: resolve(e.path),
        branch: e.branch,
      }))
      .filter(e => e.path)

    const currentRoot = resolve(repoRoot)
    const unique = new Map<string, WorkspaceInfo>()
    for (const e of normalized) {
      unique.set(e.path, {
        id: e.path,
        path: e.path,
        title: e.branch || basename(e.path) || e.path,
        branch: e.branch,
        isCurrent: e.path === currentRoot,
      })
    }

    if (!unique.has(currentRoot)) {
      unique.set(currentRoot, {
        id: currentRoot,
        path: currentRoot,
        title: basename(currentRoot) || currentRoot,
        branch: null,
        isCurrent: true,
      })
    }

    const workspaces = Array.from(unique.values()).sort((a, b) => {
      if (a.isCurrent !== b.isCurrent) return a.isCurrent ? -1 : 1
      return a.title.localeCompare(b.title)
    })
    const currentId =
      workspaces.find(w => w.isCurrent)?.id ?? workspaces[0]?.id ?? currentRoot

    workspaceCache = { at: now, workspaces, currentId }
    return { workspaces, currentId }
  }

  return { listWorkspaces }
}
