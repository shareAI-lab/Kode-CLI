import { existsSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import {
  getWorktreeRepositoryRoot,
  isGitWorktreePath,
  isWorktreeDirty,
  runWorktreeGit,
} from './git'
import {
  getManagedWorktreeRoot,
  getManagedWorktreeStorageRoot,
  isPathInside,
  listStoredManagedWorktrees,
  readManagedWorktree,
  writeManagedWorktree,
} from './storage'
import type {
  AllocateManagedWorktreeArgs,
  ManagedWorktree,
  ManagedWorktreePathValidation,
  ReleaseManagedWorktreeArgs,
  ReleaseManagedWorktreeResult,
} from './types'

function safeLabel(label: string): string {
  const normalized = label
    .trim()
    .replace(/[^A-Za-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
  if (!normalized)
    throw new Error('Managed worktree label must contain a letter or number.')
  return normalized.slice(0, 48)
}

function safeBranch(branch: string): string {
  if (
    !branch ||
    branch.startsWith('-') ||
    /[~^:?*\\[\s]|\.\.|\.$|\/$/.test(branch)
  ) {
    throw new Error('Invalid managed worktree branch name.')
  }
  return branch
}

export function validateManagedWorktreePath(args: {
  repoRoot: string
  path: string
  storageRoot?: string
}): ManagedWorktreePathValidation {
  try {
    if (!args.path || !isAbsolute(args.path))
      return { ok: false, reason: 'invalid_path' }
    const repoRoot = resolve(args.repoRoot)
    const target = resolve(args.path)
    if (target === repoRoot) return { ok: false, reason: 'repository_root' }
    const root = getManagedWorktreeRoot({
      repoRoot,
      storageRoot: args.storageRoot,
    })
    if (!isPathInside(root, target))
      return { ok: false, reason: 'outside_managed_root' }
    const rel = relative(root, target)
    if (!rel || rel === '..' || rel.startsWith(`..${sep}`)) {
      return { ok: false, reason: 'invalid_path' }
    }
    return { ok: true, path: target }
  } catch {
    return { ok: false, reason: 'invalid_path' }
  }
}

export function allocateManagedWorktree(
  args: AllocateManagedWorktreeArgs,
): ManagedWorktree {
  const repoRoot = getWorktreeRepositoryRoot(args.cwd)
  const storageRoot = getManagedWorktreeStorageRoot(args.storageRoot)
  if (isPathInside(repoRoot, storageRoot)) {
    throw new Error('Managed worktree storage must be outside the repository.')
  }
  const id = `wt-${randomUUID().replace(/-/g, '').slice(0, 16)}`
  const label = safeLabel(args.label)
  const branch = safeBranch(args.branch ?? `kode/${label}-${id.slice(-8)}`)
  const baseRef = args.baseRef?.trim() || 'HEAD'
  if (baseRef.startsWith('-'))
    throw new Error('Invalid managed worktree base ref.')
  const root = getManagedWorktreeRoot({ repoRoot, storageRoot })
  const path = join(root, id)
  const validation = validateManagedWorktreePath({
    repoRoot,
    path,
    storageRoot,
  })
  if ('reason' in validation) {
    throw new Error(`Unsafe managed worktree path: ${validation.reason}`)
  }
  if (existsSync(validation.path))
    throw new Error(`Managed worktree path already exists: ${validation.path}`)

  // Do not silently attach an existing branch to a second worktree.
  try {
    runWorktreeGit(repoRoot, [
      'show-ref',
      '--verify',
      '--quiet',
      `refs/heads/${branch}`,
    ])
    throw new Error(`Managed worktree branch already exists: ${branch}`)
  } catch (error) {
    if (error instanceof Error && error.message.includes('already exists'))
      throw error
  }

  runWorktreeGit(repoRoot, [
    'worktree',
    'add',
    '-b',
    branch,
    validation.path,
    baseRef,
  ])
  const record: ManagedWorktree = {
    version: 1,
    id,
    label,
    repoRoot,
    path: validation.path,
    branch,
    baseRef,
    createdAt: Date.now(),
    status: 'active',
  }
  try {
    writeManagedWorktree(record, storageRoot)
    return record
  } catch (error) {
    try {
      runWorktreeGit(repoRoot, [
        'worktree',
        'remove',
        '--force',
        validation.path,
      ])
    } catch {
      /* no-op */
    }
    throw error
  }
}

export function listManagedWorktrees(args: {
  cwd: string
  storageRoot?: string
}): ManagedWorktree[] {
  const repoRoot = getWorktreeRepositoryRoot(args.cwd)
  return listStoredManagedWorktrees({ repoRoot, storageRoot: args.storageRoot })
}

export function releaseManagedWorktree(
  args: ReleaseManagedWorktreeArgs,
): ReleaseManagedWorktreeResult {
  const repoRoot = getWorktreeRepositoryRoot(args.cwd)
  const record = readManagedWorktree({
    repoRoot,
    id: args.id,
    storageRoot: args.storageRoot,
  })
  if (!record) return { ok: false, reason: 'not_found' }
  if (record.status === 'released') return { ok: true, worktree: record }
  const validation = validateManagedWorktreePath({
    repoRoot,
    path: record.path,
    storageRoot: args.storageRoot,
  })
  if (!validation.ok)
    return { ok: false, reason: 'invalid_path', worktree: record }
  if (!isGitWorktreePath(repoRoot, validation.path)) {
    return { ok: false, reason: 'not_a_managed_worktree', worktree: record }
  }
  if (!args.force && isWorktreeDirty(validation.path)) {
    return { ok: false, reason: 'dirty_worktree', worktree: record }
  }
  runWorktreeGit(repoRoot, [
    'worktree',
    'remove',
    ...(args.force ? ['--force'] : []),
    validation.path,
  ])
  const released: ManagedWorktree = {
    ...record,
    status: 'released',
    releasedAt: Date.now(),
  }
  writeManagedWorktree(released, args.storageRoot)
  return { ok: true, worktree: released }
}
