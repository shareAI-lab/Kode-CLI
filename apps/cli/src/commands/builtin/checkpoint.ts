import type { Command } from '../types'
import { captureCheckpoint, listCheckpoints } from '#core/checkpoints'
import { getCwd } from '#core/utils/state'

function usage(): string {
  return 'Usage: /checkpoint create [label] | /checkpoint list'
}

const checkpoint = {
  type: 'local',
  name: 'checkpoint',
  description: 'Create or list file-level Git checkpoints',
  argumentHint: 'create [label] | list',
  isEnabled: true,
  isHidden: true,
  disableNonInteractive: true,
  async call(args) {
    const [subcommand = '', ...rest] = args.trim().split(/\s+/).filter(Boolean)
    if (subcommand === 'create') {
      try {
        const checkpoint = captureCheckpoint({
          cwd: getCwd(),
          ...(rest.length ? { label: rest.join(' ') } : {}),
        })
        return `Created checkpoint ${checkpoint.id} at ${new Date(checkpoint.createdAt).toISOString()}.`
      } catch (error) {
        return `Checkpoint failed: ${error instanceof Error ? error.message : String(error)}`
      }
    }
    if (subcommand === 'list') {
      try {
        const checkpoints = listCheckpoints({ cwd: getCwd() })
        if (checkpoints.length === 0)
          return 'No checkpoints found for this repository.'
        return checkpoints
          .map(item => {
            const label = item.label ? ` ${item.label}` : ''
            return `${item.id}  ${item.kind}${label}  ${new Date(item.createdAt).toISOString()}`
          })
          .join('\n')
      } catch (error) {
        return `Checkpoint list failed: ${error instanceof Error ? error.message : String(error)}`
      }
    }
    return usage()
  },
  userFacingName() {
    return 'checkpoint'
  },
} satisfies Command

export default checkpoint
