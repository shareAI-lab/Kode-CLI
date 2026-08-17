import type { Command } from '../types'
import { restoreCheckpoint } from '#core/checkpoints'
import { getCwd } from '#core/utils/state'

const rollback = {
  type: 'local',
  name: 'rollback',
  description: 'Restore a file-level Git checkpoint',
  argumentHint: '<id> [--force]',
  isEnabled: true,
  isHidden: true,
  disableNonInteractive: true,
  async call(args) {
    const tokens = args.trim().split(/\s+/).filter(Boolean)
    const id = tokens[0]
    const force = tokens.includes('--force')
    if (!id || tokens.some(token => token !== id && token !== '--force')) {
      return 'Usage: /rollback <checkpoint-id> [--force]'
    }
    try {
      const result = restoreCheckpoint({ cwd: getCwd(), id, force })
      if (result.ok) {
        return `Restored checkpoint ${result.checkpoint.id}. Emergency checkpoint: ${result.emergencyCheckpoint.id}.`
      }
      if (!('reason' in result))
        return 'Rollback failed: invalid rollback result.'
      if (result.reason === 'workspace_drift') {
        return `Rollback refused: workspace drifted. Emergency checkpoint: ${result.emergencyCheckpoint?.id ?? 'unavailable'}. Re-run with --force only after review.`
      }
      return `Rollback failed (${result.reason}): ${result.error ?? 'workspace was not changed'}`
    } catch (error) {
      return `Rollback failed: ${error instanceof Error ? error.message : String(error)}`
    }
  },
  userFacingName() {
    return 'rollback'
  },
} satisfies Command

export default rollback
