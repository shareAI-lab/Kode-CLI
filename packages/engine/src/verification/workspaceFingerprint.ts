import { createHash } from 'node:crypto'
import { lstatSync, readlinkSync } from 'node:fs'
import type { BigIntStats } from 'node:fs'
import { resolve, sep } from 'node:path'
import { spawnSync } from 'node:child_process'

const MAX_GIT_OUTPUT_BYTES = 64 * 1024 * 1024

function runGit(cwd: string, args: string[]): Buffer | null {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'buffer',
    windowsHide: true,
    maxBuffer: MAX_GIT_OUTPUT_BYTES,
  })
  return result.status === 0 ? Buffer.from(result.stdout ?? '') : null
}

function parseNullDelimited(value: Buffer): string[] {
  return value.toString('utf8').split('\0').filter(Boolean)
}

function isInsideRepository(repoRoot: string, target: string): boolean {
  const relativePath = target.slice(repoRoot.length)
  return (
    target === repoRoot ||
    (target.startsWith(repoRoot) && relativePath.startsWith(sep))
  )
}

/**
 * Captures source-visible file identity without including HEAD/index state.
 * Nanosecond mtime/ctime plus inode/size keeps this fast enough for each
 * write-capable tool while detecting edits to already-dirty and untracked
 * sources. Staging and committing an unchanged worktree stay stable.
 */
export function captureWorkspaceFingerprint(cwd: string): string | null {
  try {
    const rootOutput = runGit(cwd, ['rev-parse', '--show-toplevel'])
    if (!rootOutput) return null
    const repoRoot = resolve(rootOutput.toString('utf8').trim())
    if (!repoRoot) return null

    const workspacePaths = runGit(repoRoot, [
      'ls-files',
      '--cached',
      '--others',
      '--exclude-standard',
      '-z',
    ])
    if (!workspacePaths) return null

    const digest = createHash('sha256')
    for (const path of parseNullDelimited(workspacePaths).sort()) {
      const target = resolve(repoRoot, path)
      if (!isInsideRepository(repoRoot, target)) return null
      digest.update(path)
      digest.update('\0')
      let stat: BigIntStats
      try {
        stat = lstatSync(target, { bigint: true })
      } catch {
        digest.update('<missing>\0')
        continue
      }
      digest.update(
        `${stat.mode}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}:${stat.ino}`,
      )
      digest.update('\0')

      if (stat.isSymbolicLink()) {
        digest.update(readlinkSync(target))
      }
    }

    return digest.digest('hex')
  } catch {
    return null
  }
}
