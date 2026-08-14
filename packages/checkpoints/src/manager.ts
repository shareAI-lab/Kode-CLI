import {
  chmodSync,
  existsSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import {
  captureCheckpoint,
  loadCheckpoint,
  readCheckpointArtifact,
} from './storage'
import {
  assertSafeRepositoryRelativePath,
  collectGitWorkspaceSnapshot,
  removeCurrentUntrackedFiles,
  runGitForCheckpoint,
} from './gitSnapshot'
import type {
  CheckpointRecord,
  CheckpointUntrackedEntry,
  RestoreCheckpointArgs,
  RestoreCheckpointResult,
} from './types'

type RestoreArtifacts = {
  indexPatch: Buffer
  worktreePatch: Buffer
  untracked: Map<string, Buffer>
}

function readRestoreArtifacts(args: {
  directory: string
  record: CheckpointRecord
}): RestoreArtifacts {
  const untracked = new Map<string, Buffer>()
  for (const entry of args.record.untracked) {
    untracked.set(
      entry.path,
      readCheckpointArtifact(args.directory, entry.blob),
    )
  }
  return {
    indexPatch: readCheckpointArtifact(args.directory, args.record.indexPatch),
    worktreePatch: readCheckpointArtifact(
      args.directory,
      args.record.worktreePatch,
    ),
    untracked,
  }
}

function restoreUntracked(args: {
  repoRoot: string
  entries: CheckpointUntrackedEntry[]
  blobs: ReadonlyMap<string, Buffer>
}): void {
  for (const entry of args.entries) {
    const target = assertSafeRepositoryRelativePath(args.repoRoot, entry.path)
    const blob = args.blobs.get(entry.path)
    if (!blob) throw new Error(`Checkpoint blob is missing: ${entry.path}`)
    mkdirSync(dirname(target), { recursive: true })
    rmSync(target, { recursive: true, force: true })
    if (entry.kind === 'symlink') {
      symlinkSync(blob.toString('utf8'), target, 'file')
    } else {
      writeFileSync(target, blob)
      chmodSync(target, entry.mode)
    }
  }
}

function applyCheckpoint(args: {
  repoRoot: string
  directory: string
  record: CheckpointRecord
}): void {
  // Read every artifact before changing the workspace. This catches corrupt or
  // missing checkpoint files before reset --hard can discard user changes.
  const artifacts = readRestoreArtifacts({
    directory: args.directory,
    record: args.record,
  })
  removeCurrentUntrackedFiles(args.repoRoot)
  runGitForCheckpoint(args.repoRoot, ['reset', '--hard', args.record.head])
  const indexPatchPath = join(args.directory, args.record.indexPatch)
  const worktreePatchPath = join(args.directory, args.record.worktreePatch)
  if (artifacts.indexPatch.length > 0) {
    runGitForCheckpoint(args.repoRoot, [
      'apply',
      '--index',
      '--binary',
      '--whitespace=nowarn',
      indexPatchPath,
    ])
  }
  if (artifacts.worktreePatch.length > 0) {
    runGitForCheckpoint(args.repoRoot, [
      'apply',
      '--binary',
      '--whitespace=nowarn',
      worktreePatchPath,
    ])
  }
  restoreUntracked({
    repoRoot: args.repoRoot,
    entries: args.record.untracked,
    blobs: artifacts.untracked,
  })
  const restored = collectGitWorkspaceSnapshot(args.repoRoot)
  if (restored.fingerprint !== args.record.fingerprint) {
    throw new Error('Restored workspace does not match checkpoint fingerprint.')
  }
}

/**
 * Restores a complete repository working-tree and index snapshot. The normal
 * path refuses drift. `force` is an explicit escape hatch and always creates
 * an emergency checkpoint before the destructive reset/apply sequence.
 */
export function restoreCheckpoint(
  args: RestoreCheckpointArgs,
): RestoreCheckpointResult {
  const loaded = loadCheckpoint(args)
  const { record, directory } = loaded
  const current = collectGitWorkspaceSnapshot(args.cwd)
  if (current.head !== record.head || current.branch !== record.branch) {
    return { ok: false, reason: 'head_mismatch', checkpoint: record }
  }

  const hasDrift = current.fingerprint !== record.fingerprint
  const emergency = captureCheckpoint({
    cwd: args.cwd,
    storageRoot: args.storageRoot,
    kind: 'emergency',
    reason: hasDrift ? 'pre-restore-drift' : 'pre-restore',
    emergencyOf: record.id,
  })
  if (hasDrift && !args.force) {
    return {
      ok: false,
      reason: 'workspace_drift',
      checkpoint: record,
      emergencyCheckpoint: emergency,
    }
  }

  try {
    applyCheckpoint({ repoRoot: current.repoRoot, directory, record })
    return { ok: true, checkpoint: record, emergencyCheckpoint: emergency }
  } catch (error) {
    const restoreError = error instanceof Error ? error.message : String(error)
    try {
      const emergencyLoaded = loadCheckpoint({
        cwd: current.repoRoot,
        storageRoot: args.storageRoot,
        id: emergency.id,
      })
      applyCheckpoint({
        repoRoot: current.repoRoot,
        directory: emergencyLoaded.directory,
        record: emergencyLoaded.record,
      })
      return {
        ok: false,
        reason: 'restore_failed',
        checkpoint: record,
        emergencyCheckpoint: emergency,
        error: `${restoreError} Emergency checkpoint ${emergency.id} was restored.`,
      }
    } catch (recoveryError) {
      const recoveryMessage =
        recoveryError instanceof Error
          ? recoveryError.message
          : String(recoveryError)
      return {
        ok: false,
        reason: 'restore_failed',
        checkpoint: record,
        emergencyCheckpoint: emergency,
        error: `${restoreError} Emergency recovery failed: ${recoveryMessage}`,
      }
    }
  }
}
