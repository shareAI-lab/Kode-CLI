import { spawnSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'

export function runWorktreeGit(cwd: string, args: string[]): Buffer {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'buffer',
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
  })
  if (result.status === 0) return Buffer.from(result.stdout ?? '')
  const stderr = Buffer.from(result.stderr ?? '')
    .toString('utf8')
    .trim()
  throw new Error(
    `git ${args.join(' ')} failed: ${stderr || String(result.status)}`,
  )
}

export function getWorktreeRepositoryRoot(cwd: string): string {
  return resolve(
    runWorktreeGit(cwd, ['rev-parse', '--show-toplevel'])
      .toString('utf8')
      .trim(),
  )
}

export function isGitWorktreePath(repoRoot: string, target: string): boolean {
  const raw = runWorktreeGit(repoRoot, [
    'worktree',
    'list',
    '--porcelain',
  ]).toString('utf8')
  const canonical = (value: string): string => {
    const absolute = resolve(value)
    try {
      return realpathSync.native(absolute)
    } catch {
      return absolute
    }
  }
  const expected = canonical(target)
  return raw.split('\n').some(line => {
    if (!line.startsWith('worktree ')) return false
    return canonical(line.slice('worktree '.length).trim()) === expected
  })
}

export function isWorktreeDirty(cwd: string): boolean {
  return runWorktreeGit(cwd, ['status', '--porcelain=v1', '-z']).length > 0
}
