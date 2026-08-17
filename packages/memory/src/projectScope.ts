import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'

export type ProjectScope = {
  /** Stable only for this real project folder; worktrees intentionally differ. */
  id: string
  rootPath: string
  kind: 'git' | 'directory'
}

const scopeByCwd = new Map<string, ProjectScope>()

function realPathOrResolved(path: string): string {
  const resolved = resolve(path)
  try {
    return realpathSync.native(resolved)
  } catch {
    // A caller may be resolving a workspace before its directory is created.
    // It still gets a deterministic directory-scoped identity.
    return resolved
  }
}

function getGitTopLevel(cwd: string): string | null {
  try {
    const output = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 750,
    }).trim()
    return output || null
  } catch {
    return null
  }
}

function makeScopeId(rootPath: string): string {
  return createHash('sha256')
    .update('kode-project-scope-v1\0')
    .update(rootPath)
    .digest('hex')
    .slice(0, 24)
}

/**
 * Resolves a project to its real Git worktree root. Non-Git directories remain
 * isolated by their real path. We deliberately do not use a remote URL: a
 * copied repository or another worktree must not inherit private context.
 */
export function getProjectScope(cwd: string): ProjectScope {
  const cacheKey = realPathOrResolved(cwd)
  const cached = scopeByCwd.get(cacheKey)
  if (cached) return cached

  const gitRoot = getGitTopLevel(cacheKey)
  const rootPath = realPathOrResolved(gitRoot ?? cacheKey)
  const scope: ProjectScope = {
    id: makeScopeId(rootPath),
    rootPath,
    kind: gitRoot ? 'git' : 'directory',
  }
  scopeByCwd.set(cacheKey, scope)
  return scope
}

export function __resetProjectScopeCacheForTests(): void {
  scopeByCwd.clear()
}
