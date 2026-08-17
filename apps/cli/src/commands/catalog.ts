import type { Command } from './types'
import { getPrimaryCommandRank } from './discovery'

/**
 * A stable, user-facing organization for the otherwise flat slash-command
 * registry. Command names and aliases remain the public execution API; this
 * catalog only controls discovery and presentation.
 */
export const COMMAND_CATEGORIES = [
  {
    id: 'getting-started',
    label: 'Getting started',
    shortLabel: 'Start',
    color: 'green',
    commandNames: [
      'help',
      'onboarding',
      'login',
      'logout',
      'init',
      'capabilities',
    ],
  },
  {
    id: 'work-and-automation',
    label: 'Work and automation',
    shortLabel: 'Work',
    color: 'blue',
    commandNames: ['work', 'plan', 'review'],
  },
  {
    id: 'conversation-and-context',
    label: 'Conversation and context',
    shortLabel: 'Context',
    color: 'yellow',
    commandNames: [
      'session',
      'clear',
      'compact',
      'resume',
      'rewind',
      'session-message',
      'voice',
    ],
  },
  {
    id: 'configure-and-extend',
    label: 'Configure and extend',
    shortLabel: 'Configure',
    color: 'purple',
    commandNames: [
      'settings',
      'extensions',
      'add-dir',
      'lsp',
      'mcp',
      'model',
      'effort',
      'permissions',
      'sandbox',
    ],
  },
  {
    id: 'inspect-and-diagnose',
    label: 'Inspect and diagnose',
    shortLabel: 'Inspect',
    color: 'orange',
    commandNames: ['inspect', 'status'],
  },
  {
    id: 'developer-tools',
    label: 'Developer tools',
    shortLabel: 'Tools',
    color: 'cyan',
    commandNames: ['bash', 'browser', 'gate-dump', 'migrate'],
  },
  {
    id: 'integrations',
    label: 'Integrations',
    shortLabel: 'Integration',
    color: 'pink',
    commandNames: [],
  },
  {
    id: 'custom-commands',
    label: 'Custom commands',
    shortLabel: 'Custom',
    color: 'red',
    commandNames: [],
  },
  {
    id: 'other-commands',
    label: 'Other commands',
    shortLabel: 'Other',
    color: 'gray',
    commandNames: ['exit'],
  },
] as const

export type CommandCategory = (typeof COMMAND_CATEGORIES)[number]
export type CommandCategoryId = CommandCategory['id']
const categoriesById = new Map<CommandCategoryId, CommandCategory>(
  COMMAND_CATEGORIES.map(category => [category.id, category]),
)

const categoryByCommandName = new Map<string, CommandCategoryId>(
  COMMAND_CATEGORIES.flatMap(category =>
    category.commandNames.map(name => [name, category.id] as const),
  ),
)

const otherCommandsCategory = categoriesById.get('other-commands')!

function getCustomCommandScope(command: Command): 'project' | 'user' | null {
  const scope = (command as Command & { scope?: unknown }).scope
  return scope === 'project' || scope === 'user' ? scope : null
}

/**
 * Resolve a presentation category without changing how the command runs.
 * Dynamic MCP prompts and local/project commands are intentionally detected
 * by their stable registry metadata instead of requiring every extension to
 * opt in to a new field.
 */
export function getCommandCategory(command: Command): CommandCategory {
  const name = command.userFacingName()
  const categoryId = categoryByCommandName.get(name)
  if (categoryId) return categoriesById.get(categoryId)!

  if (command.name.startsWith('mcp__')) {
    return categoriesById.get('integrations')!
  }

  if (getCustomCommandScope(command)) {
    return categoriesById.get('custom-commands')!
  }

  return otherCommandsCategory
}

/**
 * Order commands for an empty slash-completion list or command palette.
 * Primary commands are deliberately first; all remaining commands are grouped
 * by category and then alphabetically for predictable navigation.
 */
export function compareCommandsForDiscovery(a: Command, b: Command): number {
  const aName = a.userFacingName()
  const bName = b.userFacingName()
  const aPrimaryRank = getPrimaryCommandRank(aName)
  const bPrimaryRank = getPrimaryCommandRank(bName)

  if (aPrimaryRank !== undefined || bPrimaryRank !== undefined) {
    if (aPrimaryRank === undefined) return 1
    if (bPrimaryRank === undefined) return -1
    return aPrimaryRank - bPrimaryRank
  }

  const categoryOrder =
    COMMAND_CATEGORIES.indexOf(getCommandCategory(a)) -
    COMMAND_CATEGORIES.indexOf(getCommandCategory(b))
  if (categoryOrder !== 0) return categoryOrder

  return aName.localeCompare(bName)
}
