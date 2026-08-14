import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from 'node:fs'
import { createHash } from 'node:crypto'
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path'
import { getKodeRoot } from '#config/dataRoots'
import type { ManagedWorktree } from './types'

function safeId(id: string): string {
  if (!/^[A-Za-z0-9_-]{1,120}$/.test(id))
    throw new Error('Invalid managed worktree id.')
  return id
}

function repoKey(repoRoot: string): string {
  return createHash('sha256')
    .update(canonicalPath(repoRoot))
    .digest('hex')
    .slice(0, 24)
}

function canonicalPath(path: string): string {
  let ancestor = resolve(path)
  const suffix: string[] = []
  while (!existsSync(ancestor)) {
    const parent = dirname(ancestor)
    if (parent === ancestor) return resolve(path)
    suffix.unshift(basename(ancestor))
    ancestor = parent
  }
  try {
    return resolve(realpathSync.native(ancestor), ...suffix)
  } catch {
    return resolve(path)
  }
}

export function getManagedWorktreeStorageRoot(storageRoot?: string): string {
  return resolve(storageRoot ?? join(getKodeRoot(), 'managed-worktrees'))
}

export function getManagedWorktreeRepositoryDir(args: {
  repoRoot: string
  storageRoot?: string
}): string {
  return join(
    getManagedWorktreeStorageRoot(args.storageRoot),
    repoKey(args.repoRoot),
  )
}

export function getManagedWorktreeRecordPath(args: {
  repoRoot: string
  id: string
  storageRoot?: string
}): string {
  return join(getManagedWorktreeRepositoryDir(args), `${safeId(args.id)}.json`)
}

export function getManagedWorktreeRoot(args: {
  repoRoot: string
  storageRoot?: string
}): string {
  return join(getManagedWorktreeRepositoryDir(args), 'worktrees')
}

function atomicWriteJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`
  writeFileSync(temp, JSON.stringify(value, null, 2), 'utf8')
  renameSync(temp, path)
}

export function writeManagedWorktree(
  worktree: ManagedWorktree,
  storageRoot?: string,
): void {
  atomicWriteJson(
    getManagedWorktreeRecordPath({
      repoRoot: worktree.repoRoot,
      id: worktree.id,
      storageRoot,
    }),
    worktree,
  )
}

export function readManagedWorktree(args: {
  repoRoot: string
  id: string
  storageRoot?: string
}): ManagedWorktree | null {
  const path = getManagedWorktreeRecordPath(args)
  if (!existsSync(path)) return null
  try {
    const record = JSON.parse(readFileSync(path, 'utf8')) as ManagedWorktree
    if (!record || record.version !== 1 || record.id !== args.id) return null
    if (resolve(record.repoRoot) !== resolve(args.repoRoot)) return null
    return record
  } catch {
    return null
  }
}

export function listStoredManagedWorktrees(args: {
  repoRoot: string
  storageRoot?: string
}): ManagedWorktree[] {
  const dir = getManagedWorktreeRepositoryDir(args)
  try {
    return readdirSync(dir)
      .filter(name => name.endsWith('.json'))
      .flatMap(name => {
        const id = name.slice(0, -'.json'.length)
        const record = readManagedWorktree({ ...args, id })
        return record ? [record] : []
      })
      .sort((a, b) => a.createdAt - b.createdAt)
  } catch {
    return []
  }
}

export function isPathInside(parent: string, child: string): boolean {
  const rel = relative(canonicalPath(parent), canonicalPath(child))
  return (
    rel === '' ||
    (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))
  )
}
