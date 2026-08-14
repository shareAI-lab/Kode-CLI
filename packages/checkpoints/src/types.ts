export type CheckpointKind = 'normal' | 'emergency'

export type CheckpointUntrackedEntry = {
  path: string
  kind: 'file' | 'symlink'
  mode: number
  blob: string
  sha256: string
}

export type CheckpointRecord = {
  version: 1
  id: string
  kind: CheckpointKind
  label?: string
  reason?: string
  emergencyOf?: string
  createdAt: number
  repoRoot: string
  head: string
  branch: string | null
  fingerprint: string
  indexPatch: string
  worktreePatch: string
  untracked: CheckpointUntrackedEntry[]
}

export type CaptureCheckpointArgs = {
  cwd: string
  /** Keep checkpoint data outside the repository. Defaults to Kode's data root. */
  storageRoot?: string
  id?: string
  label?: string
  kind?: CheckpointKind
  reason?: string
  emergencyOf?: string
}

export type RestoreCheckpointArgs = {
  cwd: string
  id: string
  storageRoot?: string
  /** Explicit user confirmation to overwrite a workspace that changed after capture. */
  force?: boolean
}

export type RestoreCheckpointResult =
  | {
      ok: true
      checkpoint: CheckpointRecord
      emergencyCheckpoint: CheckpointRecord
    }
  | {
      ok: false
      reason: 'workspace_drift' | 'head_mismatch' | 'restore_failed'
      checkpoint: CheckpointRecord
      emergencyCheckpoint?: CheckpointRecord
      error?: string
    }
