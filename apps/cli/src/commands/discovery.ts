/**
 * Commands that are useful to people who are still learning the CLI.
 *
 * Everything remains available through command search and `/help all`; this
 * list only keeps the first help and palette view focused.
 */
const PRIMARY_COMMAND_ORDER = [
  'help',
  'login',
  'init',
  'resume',
  'model',
  'plan',
  'work',
  'session',
  'review',
  'status',
  'inspect',
  'settings',
  'extensions',
] as const

export const PRIMARY_COMMAND_NAMES = new Set<string>(PRIMARY_COMMAND_ORDER)

export function isPrimaryCommandName(name: string): boolean {
  return PRIMARY_COMMAND_NAMES.has(name)
}

/**
 * Returns the position of a command in the curated discovery list.
 *
 * Keep this separate from the Set above: Sets are convenient for membership,
 * while completion and the command palette need a stable, intentional order.
 */
export function getPrimaryCommandRank(name: string): number | undefined {
  const rank = PRIMARY_COMMAND_ORDER.indexOf(
    name as (typeof PRIMARY_COMMAND_ORDER)[number],
  )
  return rank === -1 ? undefined : rank
}
