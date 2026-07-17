/**
 * Commands that are useful to people who are still learning the CLI.
 *
 * Everything remains available through command search and `/help all`; this
 * list only keeps the first help and palette view focused.
 */
export const PRIMARY_COMMAND_NAMES = new Set([
  'help',
  'login',
  'init',
  'resume',
  'goal',
  'loop',
  'work',
  'tasks',
  'review',
  'status',
  'plan',
])

export function isPrimaryCommandName(name: string): boolean {
  return PRIMARY_COMMAND_NAMES.has(name)
}
