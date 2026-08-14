import {
  existsSync,
  lstatSync,
  readFileSync,
  readlinkSync,
  rmSync,
} from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { spawnSync } from 'node:child_process'

export type SnapshotUntrackedEntry = {
  path: string
  kind: 'file' | 'symlink'
  mode: number
  content: Buffer
  sha256: string
}

export type GitWorkspaceSnapshot = {
  repoRoot: string
  head: string
  branch: string | null
  status: Buffer
  indexPatch: Buffer
  worktreePatch: Buffer
  untracked: SnapshotUntrackedEntry[]
  fingerprint: string
}

const MAX_UNTRACKED_BYTES = 256 * 1024 * 1024

function git(cwd: string, args: string[]): Buffer {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'buffer',
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
  })
  if (result.status === 0) return Buffer.from(result.stdout ?? '')
  const stderr = Buffer.from(result.stderr ?? '')
    .toString('utf8')
    .trim()
  const detail = stderr || `exit ${String(result.status)}`
  throw new Error(`git ${args.join(' ')} failed: ${detail}`)
}

function gitBestEffort(cwd: string, args: string[]): string | null {
  try {
    const value = git(cwd, args).toString('utf8').trim()
    return value || null
  } catch {
    return null
  }
}

function hash(value: Buffer | string): string {
  return createHash('sha256').update(value).digest('hex')
}

export function assertSafeRepositoryRelativePath(
  repoRoot: string,
  repoRelativePath: string,
): string {
  if (!repoRelativePath || isAbsolute(repoRelativePath)) {
    throw new Error(
      'Checkpoint path must be a non-empty repository-relative path.',
    )
  }
  const target = resolve(repoRoot, repoRelativePath)
  const rel = relative(repoRoot, target)
  if (
    rel === '' ||
    rel === '..' ||
    rel.startsWith(`..${sep}`) ||
    isAbsolute(rel)
  ) {
    throw new Error(`Checkpoint path escapes repository: ${repoRelativePath}`)
  }
  return target
}

function parseNullDelimited(value: Buffer): string[] {
  return value.toString('utf8').split('\0').filter(Boolean)
}

function collectUntracked(repoRoot: string): SnapshotUntrackedEntry[] {
  const paths = parseNullDelimited(
    git(repoRoot, ['ls-files', '--others', '--exclude-standard', '-z']),
  ).sort()
  let total = 0
  return paths.map(path => {
    const target = assertSafeRepositoryRelativePath(repoRoot, path)
    const st = lstatSync(target)
    if (!st.isFile() && !st.isSymbolicLink()) {
      throw new Error(`Unsupported untracked checkpoint entry: ${path}`)
    }
    const content = st.isSymbolicLink()
      ? Buffer.from(readlinkSync(target), 'utf8')
      : readFileSync(target)
    total += content.length
    if (total > MAX_UNTRACKED_BYTES) {
      throw new Error(
        'Checkpoint untracked data exceeds the 256 MiB safety limit.',
      )
    }
    return {
      path,
      kind: st.isSymbolicLink() ? 'symlink' : 'file',
      mode: st.mode & 0o777,
      content,
      sha256: hash(content),
    }
  })
}

function getFingerprint(args: {
  head: string
  branch: string | null
  status: Buffer
  indexPatch: Buffer
  worktreePatch: Buffer
  untracked: SnapshotUntrackedEntry[]
}): string {
  const digest = createHash('sha256')
  digest.update(args.head)
  digest.update('\0')
  digest.update(args.branch ?? '<detached>')
  digest.update('\0')
  digest.update(args.status)
  digest.update('\0')
  digest.update(args.indexPatch)
  digest.update('\0')
  digest.update(args.worktreePatch)
  digest.update('\0')
  for (const entry of args.untracked) {
    digest.update(
      `${entry.path}\0${entry.kind}\0${entry.mode}\0${entry.sha256}\0`,
    )
  }
  return digest.digest('hex')
}

export function collectGitWorkspaceSnapshot(cwd: string): GitWorkspaceSnapshot {
  const repoRoot = resolve(
    git(cwd, ['rev-parse', '--show-toplevel']).toString('utf8').trim(),
  )
  const head = git(repoRoot, ['rev-parse', '--verify', 'HEAD'])
    .toString('utf8')
    .trim()
  const branch = gitBestEffort(repoRoot, [
    'symbolic-ref',
    '--quiet',
    '--short',
    'HEAD',
  ])
  const status = git(repoRoot, [
    'status',
    '--porcelain=v1',
    '-z',
    '--untracked-files=all',
  ])
  const indexPatch = git(repoRoot, [
    'diff',
    '--binary',
    '--cached',
    '--no-ext-diff',
    'HEAD',
  ])
  const worktreePatch = git(repoRoot, ['diff', '--binary', '--no-ext-diff'])
  const untracked = collectUntracked(repoRoot)
  return {
    repoRoot,
    head,
    branch,
    status,
    indexPatch,
    worktreePatch,
    untracked,
    fingerprint: getFingerprint({
      head,
      branch,
      status,
      indexPatch,
      worktreePatch,
      untracked,
    }),
  }
}

export function removeCurrentUntrackedFiles(repoRoot: string): void {
  const paths = parseNullDelimited(
    git(repoRoot, ['ls-files', '--others', '--exclude-standard', '-z']),
  )
  for (const path of paths.sort((a, b) => b.length - a.length)) {
    const target = assertSafeRepositoryRelativePath(repoRoot, path)
    if (!existsSync(target)) continue
    rmSync(target, { force: true, recursive: lstatSync(target).isDirectory() })
    // Empty parent directories are harmless and intentionally left alone.
    void dirname(target)
  }
}

export function runGitForCheckpoint(cwd: string, args: string[]): Buffer {
  return git(cwd, args)
}
