import type { Command } from '../types'

import {
  listProjectContextSnapshots,
  listProjectLearnings,
  retireProjectLearning,
} from '#core/projectLearning'
import { getOriginalCwd } from '#core/utils/state'

type LearningAction =
  | { kind: 'help' }
  | { kind: 'list'; includeRetired: boolean }
  | { kind: 'snapshots' }
  | { kind: 'reject'; id: string; reason: string }
  | { kind: 'invalid'; message: string }

function parseLearningCommandArgs(args: string): LearningAction {
  const input = args.trim()
  if (!input || input === 'help' || input === '--help') return { kind: 'help' }
  const [verb = '', ...rest] = input.split(/\s+/u)
  const payload = rest.join(' ').trim()
  switch (verb.toLowerCase()) {
    case 'list':
      return payload === '' || payload === 'all'
        ? { kind: 'list', includeRetired: payload === 'all' }
        : { kind: 'invalid', message: 'Usage: /learning list [all]' }
    case 'snapshots':
      return payload
        ? { kind: 'invalid', message: 'Usage: /learning snapshots' }
        : { kind: 'snapshots' }
    case 'reject': {
      const [id = '', ...reasonParts] = payload.split(/\s+/u)
      return id
        ? { kind: 'reject', id, reason: reasonParts.join(' ') }
        : { kind: 'invalid', message: 'A learning ID is required.' }
    }
    default:
      return { kind: 'invalid', message: `Unknown learning action: ${verb}` }
  }
}

function helpText(): string {
  return [
    'Project learning commands:',
    '  /learning list [all]',
    '  /learning snapshots',
    '  /learning reject <learning-id> [reason]',
    '',
    'Lessons are project-folder scoped. Candidates need evidence from two sessions before they become active.',
  ].join('\n')
}

const learning = {
  type: 'local',
  name: 'learning',
  description: 'Inspect or reject project-scoped learned workflow hints',
  argumentHint: '<list|snapshots|reject> …',
  isEnabled: true,
  isHidden: true,
  disableNonInteractive: true,
  async call(args: string) {
    const action = parseLearningCommandArgs(args)
    if (action.kind === 'help') return helpText()
    if (action.kind === 'invalid') return `${action.message}\n\n${helpText()}`

    const cwd = getOriginalCwd()
    if (action.kind === 'list') {
      const records = listProjectLearnings({
        cwd,
        includeRetired: action.includeRetired,
        limit: 50,
      })
      if (records.length === 0) return 'No project learning records found.'
      return records
        .map(record => {
          const paths =
            record.pathPrefixes.length > 0
              ? ` [${record.pathPrefixes.join(', ')}]`
              : ''
          return `${record.id}  ${record.status}/${record.kind} evidence=${record.evidence.length}${paths}\n  ${record.text}`
        })
        .join('\n')
    }

    if (action.kind === 'snapshots') {
      const snapshots = listProjectContextSnapshots({ cwd, limit: 20 })
      if (snapshots.length === 0) return 'No project context snapshots found.'
      return snapshots
        .map(
          snapshot =>
            `${snapshot.id}  ${new Date(snapshot.createdAt).toISOString()}  ${snapshot.sessionId}  ${snapshot.workspace.gitHead ?? 'non-git'}`,
        )
        .join('\n')
    }

    return retireProjectLearning({
      cwd,
      id: action.id,
      reason: action.reason,
    })
      ? `Retired project learning ${action.id}.`
      : `No active project learning found with ID ${action.id}.`
  },
  userFacingName() {
    return 'learning'
  },
} satisfies Command

export { parseLearningCommandArgs }
export default learning
