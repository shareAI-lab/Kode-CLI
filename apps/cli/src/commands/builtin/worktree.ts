import type { Command } from '../types'
import {
  allocateManagedWorktree,
  listManagedWorktrees,
  releaseManagedWorktree,
} from '#core/worktrees'
import { getCwd } from '#core/utils/state'

function usage(): string {
  return 'Usage: /worktree create <label> [--branch <branch>] | list | release <id> [--force]'
}

const worktree = {
  type: 'local',
  name: 'worktree',
  description: 'Create, inspect, and release managed agent worktrees',
  argumentHint: 'create|list|release ...',
  isEnabled: true,
  isHidden: true,
  disableNonInteractive: true,
  async call(args) {
    const tokens = args.trim().split(/\s+/).filter(Boolean)
    const subcommand = tokens[0]
    if (subcommand === 'create') {
      const label = tokens[1]
      const branchIndex = tokens.indexOf('--branch')
      const branch = branchIndex >= 0 ? tokens[branchIndex + 1] : undefined
      if (
        !label ||
        (branchIndex >= 0 && !branch) ||
        tokens.some(
          (token, index) =>
            index > 1 && index !== branchIndex && index !== branchIndex + 1,
        )
      ) {
        return usage()
      }
      try {
        const allocated = allocateManagedWorktree({
          cwd: getCwd(),
          label,
          branch,
        })
        return `Created managed worktree ${allocated.id}\n${allocated.path}\nbranch: ${allocated.branch}`
      } catch (error) {
        return `Worktree creation failed: ${error instanceof Error ? error.message : String(error)}`
      }
    }
    if (subcommand === 'list' && tokens.length === 1) {
      try {
        const worktrees = listManagedWorktrees({ cwd: getCwd() })
        if (worktrees.length === 0)
          return 'No managed worktrees found for this repository.'
        return worktrees
          .map(
            item => `${item.id}  ${item.status}  ${item.branch}  ${item.path}`,
          )
          .join('\n')
      } catch (error) {
        return `Worktree list failed: ${error instanceof Error ? error.message : String(error)}`
      }
    }
    if (subcommand === 'release') {
      const id = tokens[1]
      const force = tokens.includes('--force')
      if (
        !id ||
        tokens.some((token, index) => index > 1 && token !== '--force')
      )
        return usage()
      try {
        const released = releaseManagedWorktree({ cwd: getCwd(), id, force })
        if (released.ok)
          return `Released managed worktree ${released.worktree.id}.`
        if (!('reason' in released))
          return 'Worktree release failed: invalid result.'
        return `Worktree release refused (${released.reason}).`
      } catch (error) {
        return `Worktree release failed: ${error instanceof Error ? error.message : String(error)}`
      }
    }
    return usage()
  },
  userFacingName() {
    return 'worktree'
  },
} satisfies Command

export default worktree
