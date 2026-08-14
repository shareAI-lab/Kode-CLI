export type ManagedWorktreeStatus = 'active' | 'released'

export type ManagedWorktree = {
  version: 1
  id: string
  label: string
  repoRoot: string
  path: string
  branch: string
  baseRef: string
  createdAt: number
  releasedAt?: number
  status: ManagedWorktreeStatus
}

export type AllocateManagedWorktreeArgs = {
  cwd: string
  label: string
  branch?: string
  baseRef?: string
  /** Optional external storage root; must not live under the target repo. */
  storageRoot?: string
}

export type ReleaseManagedWorktreeArgs = {
  id: string
  cwd: string
  storageRoot?: string
  /** Explicitly permits removal of a dirty managed worktree. */
  force?: boolean
}

export type ReleaseManagedWorktreeResult =
  | { ok: true; worktree: ManagedWorktree }
  | {
      ok: false
      reason:
        | 'not_found'
        | 'invalid_path'
        | 'not_a_managed_worktree'
        | 'dirty_worktree'
      worktree?: ManagedWorktree
    }

export type ManagedWorktreePathValidation =
  | { ok: true; path: string }
  | {
      ok: false
      reason: 'outside_managed_root' | 'repository_root' | 'invalid_path'
    }
