import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
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
import { collectGitWorkspaceSnapshot } from './gitSnapshot'
import type {
  CaptureCheckpointArgs,
  CheckpointRecord,
  CheckpointUntrackedEntry,
} from './types'

function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child)
  return (
    rel === '' ||
    (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))
  )
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

function safeId(value: string): string {
  if (!/^[A-Za-z0-9_-]{1,120}$/.test(value)) {
    throw new Error('Checkpoint id must contain only letters, numbers, _ or -.')
  }
  return value
}

function repoKey(repoRoot: string): string {
  return createHash('sha256')
    .update(canonicalPath(repoRoot))
    .digest('hex')
    .slice(0, 24)
}

export function getCheckpointStorageRoot(storageRoot?: string): string {
  return resolve(storageRoot ?? join(getKodeRoot(), 'checkpoints'))
}

export function getCheckpointRepositoryDir(args: {
  repoRoot: string
  storageRoot?: string
}): string {
  return join(
    getCheckpointStorageRoot(args.storageRoot),
    repoKey(resolve(args.repoRoot)),
  )
}

export function getCheckpointDir(args: {
  repoRoot: string
  id: string
  storageRoot?: string
}): string {
  return join(getCheckpointRepositoryDir(args), safeId(args.id))
}

function atomicWriteJson(path: string, value: unknown): void {
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`
  writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8')
  renameSync(tmp, path)
}

export function captureCheckpoint(
  args: CaptureCheckpointArgs,
): CheckpointRecord {
  const snapshot = collectGitWorkspaceSnapshot(args.cwd)
  const storageRoot = getCheckpointStorageRoot(args.storageRoot)
  if (isInside(canonicalPath(snapshot.repoRoot), canonicalPath(storageRoot))) {
    throw new Error('Checkpoint storage must be outside the target repository.')
  }
  const id = safeId(
    args.id ?? `cp-${randomUUID().replace(/-/g, '').slice(0, 16)}`,
  )
  const finalDir = getCheckpointDir({
    repoRoot: snapshot.repoRoot,
    storageRoot,
    id,
  })
  if (existsSync(finalDir)) throw new Error(`Checkpoint already exists: ${id}`)

  const tempDir = `${finalDir}.tmp-${process.pid}-${Date.now()}`
  try {
    mkdirSync(join(tempDir, 'untracked'), { recursive: true })
    writeFileSync(join(tempDir, 'index.patch'), snapshot.indexPatch)
    writeFileSync(join(tempDir, 'worktree.patch'), snapshot.worktreePatch)
    const untracked: CheckpointUntrackedEntry[] = snapshot.untracked.map(
      entry => {
        const blob = join('untracked', `${entry.sha256}.blob`).replace(
          /\\/g,
          '/',
        )
        writeFileSync(join(tempDir, blob), entry.content)
        return {
          path: entry.path,
          kind: entry.kind,
          mode: entry.mode,
          blob,
          sha256: entry.sha256,
        }
      },
    )
    const record: CheckpointRecord = {
      version: 1,
      id,
      kind: args.kind ?? 'normal',
      ...(args.label ? { label: args.label } : {}),
      ...(args.reason ? { reason: args.reason } : {}),
      ...(args.emergencyOf ? { emergencyOf: args.emergencyOf } : {}),
      createdAt: Date.now(),
      repoRoot: snapshot.repoRoot,
      head: snapshot.head,
      branch: snapshot.branch,
      fingerprint: snapshot.fingerprint,
      indexPatch: 'index.patch',
      worktreePatch: 'worktree.patch',
      untracked,
    }
    atomicWriteJson(join(tempDir, 'checkpoint.json'), record)
    mkdirSync(
      getCheckpointRepositoryDir({ repoRoot: snapshot.repoRoot, storageRoot }),
      {
        recursive: true,
      },
    )
    renameSync(tempDir, finalDir)
    return record
  } catch (error) {
    rmSync(tempDir, { recursive: true, force: true })
    throw error
  }
}

export function loadCheckpoint(args: {
  cwd: string
  id: string
  storageRoot?: string
}): { record: CheckpointRecord; directory: string } {
  const snapshot = collectGitWorkspaceSnapshot(args.cwd)
  const directory = getCheckpointDir({
    repoRoot: snapshot.repoRoot,
    storageRoot: args.storageRoot,
    id: args.id,
  })
  const recordPath = join(directory, 'checkpoint.json')
  if (!existsSync(recordPath))
    throw new Error(`Checkpoint not found: ${args.id}`)
  const record = JSON.parse(
    readFileSync(recordPath, 'utf8'),
  ) as CheckpointRecord
  if (
    !record ||
    record.version !== 1 ||
    record.id !== args.id ||
    resolve(record.repoRoot) !== snapshot.repoRoot
  ) {
    throw new Error(`Invalid checkpoint record: ${args.id}`)
  }
  return { record, directory }
}

export function listCheckpoints(args: {
  cwd: string
  storageRoot?: string
}): CheckpointRecord[] {
  const snapshot = collectGitWorkspaceSnapshot(args.cwd)
  const directory = getCheckpointRepositoryDir({
    repoRoot: snapshot.repoRoot,
    storageRoot: args.storageRoot,
  })
  try {
    return readdirSync(directory, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .flatMap(entry => {
        const recordPath = join(directory, entry.name, 'checkpoint.json')
        try {
          const record = JSON.parse(
            readFileSync(recordPath, 'utf8'),
          ) as CheckpointRecord
          return record?.version === 1 && record.repoRoot === snapshot.repoRoot
            ? [record]
            : []
        } catch {
          return []
        }
      })
      .sort((a, b) => b.createdAt - a.createdAt)
  } catch {
    return []
  }
}

export function readCheckpointArtifact(
  directory: string,
  path: string,
): Buffer {
  const target = resolve(directory, path)
  if (!isInside(directory, target))
    throw new Error('Checkpoint artifact path escapes checkpoint directory.')
  return readFileSync(target)
}
