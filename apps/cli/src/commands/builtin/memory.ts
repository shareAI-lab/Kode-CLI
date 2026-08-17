import type { Command } from '../types'

import {
  forgetMemory,
  getRelevantMemories,
  listMemories,
  rememberMemory,
} from '#core/memory'
import { getCwd } from '#core/utils/state'

const MAX_LIST_ITEMS = 20

type MemoryAction =
  | { kind: 'help' }
  | { kind: 'remember'; text: string }
  | { kind: 'list'; limit: number }
  | { kind: 'search'; query: string }
  | { kind: 'forget'; id: string }
  | { kind: 'invalid'; message: string }

function parseLimit(value: string | undefined): number | null {
  if (value === undefined) return MAX_LIST_ITEMS
  if (!/^\d+$/u.test(value)) return null
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > MAX_LIST_ITEMS) {
    return null
  }
  return parsed
}

export function parseMemoryCommandArgs(args: string): MemoryAction {
  const input = args.trim()
  if (!input || input === 'help' || input === '--help') return { kind: 'help' }

  const [verb = '', ...rest] = input.split(/\s+/u)
  const payload = rest.join(' ').trim()
  switch (verb.toLowerCase()) {
    case 'remember':
      return payload
        ? { kind: 'remember', text: payload }
        : { kind: 'invalid', message: 'Memory text is required.' }
    case 'list': {
      const limit = parseLimit(payload || undefined)
      return limit === null
        ? {
            kind: 'invalid',
            message: `List limit must be an integer from 1 to ${MAX_LIST_ITEMS}.`,
          }
        : { kind: 'list', limit }
    }
    case 'search':
      return payload
        ? { kind: 'search', query: payload }
        : { kind: 'invalid', message: 'Search query is required.' }
    case 'forget':
      return payload && !/\s/u.test(payload)
        ? { kind: 'forget', id: payload }
        : { kind: 'invalid', message: 'Memory ID is required.' }
    default:
      return { kind: 'invalid', message: `Unknown memory action: ${verb}` }
  }
}

function helpText(): string {
  return [
    'Memory commands:',
    '  /memory remember <fact or preference>',
    '  /memory list [1-20]',
    '  /memory search <query>',
    '  /memory forget <memory-id>',
    '',
    'Memories are project-scoped and credentials are redacted before storage.',
  ].join('\n')
}

function renderMemoryList(
  memories: Array<{
    id: string
    text: string
    tags: string[]
    score?: number
  }>,
  heading: string,
): string {
  if (memories.length === 0) return `${heading}\nNo memories found.`
  const lines = [heading]
  for (const memory of memories) {
    const tags = memory.tags.length > 0 ? ` [${memory.tags.join(', ')}]` : ''
    const score =
      typeof memory.score === 'number'
        ? ` (relevance ${memory.score.toFixed(2)})`
        : ''
    lines.push(`- ${memory.id}${tags}${score}: ${memory.text}`)
  }
  return lines.join('\n')
}

const memory = {
  type: 'local',
  name: 'memory',
  description: 'Manage project-scoped long-term memories',
  argumentHint: '<remember|list|search|forget> …',
  isEnabled: true,
  isHidden: true,
  disableNonInteractive: true,
  async call(args: string) {
    const action = parseMemoryCommandArgs(args)
    if (action.kind === 'help') return helpText()
    if (action.kind === 'invalid') return `${action.message}\n\n${helpText()}`

    const cwd = getCwd()
    if (action.kind === 'remember') {
      const saved = rememberMemory({
        cwd,
        text: action.text,
        source: { kind: 'manual-command' },
      })
      return saved
        ? `Remembered ${saved.id}: ${saved.text}`
        : 'Memory was not saved because it was empty or sensitive-only.'
    }
    if (action.kind === 'list') {
      return renderMemoryList(
        listMemories({ cwd, limit: action.limit }),
        'Project memories:',
      )
    }
    if (action.kind === 'search') {
      return renderMemoryList(
        getRelevantMemories({
          cwd,
          query: action.query,
          limit: MAX_LIST_ITEMS,
        }),
        `Relevant memories for: ${action.query}`,
      )
    }

    return forgetMemory({ cwd, id: action.id })
      ? `Forgot memory ${action.id}.`
      : `No memory found with ID ${action.id}.`
  },
  userFacingName() {
    return 'memory'
  },
} satisfies Command

export default memory
