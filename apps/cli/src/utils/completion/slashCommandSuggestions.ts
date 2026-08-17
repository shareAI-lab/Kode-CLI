import type { Command } from '#cli-commands'
import {
  compareCommandsForDiscovery,
  getCommandCategory,
} from '#cli-commands/catalog'
import { matchAdvanced } from './advancedFuzzyMatcher'
import type { UnifiedSuggestion } from './types'

// An empty "/" prefix shows a curated subset instead of every command so the
// panel stays scannable; typing filters the full registry.
const EMPTY_PREFIX_MAX_COMMANDS = 12

function buildCommandDescription(cmd: Command): string {
  const parts: string[] = []
  if (cmd.description) parts.push(cmd.description)
  if (cmd.argumentHint) parts.push(`Args: ${cmd.argumentHint}`)
  return parts.join('\n')
}

function buildCommandDisplayValue(cmd: Command): string {
  const category = getCommandCategory(cmd)
  return `/${cmd.userFacingName()} · ${category.shortLabel}`
}

function getCommandMatchRank(command: Command, prefix: string): number | null {
  const normalizedPrefix = prefix.toLowerCase()
  const name = command.userFacingName().toLowerCase()

  if (name === normalizedPrefix) return 0
  if (name.startsWith(normalizedPrefix)) return 1
  if (
    command.aliases?.some(alias =>
      alias.toLowerCase().startsWith(normalizedPrefix),
    )
  ) {
    return 2
  }
  // Fuzzy fallback over the command name and its aliases, so abbreviations
  // and subsequences (e.g. "aprv" -> "approved-tools") still match. Skipped
  // for single-character prefixes to avoid flooding the panel with matches.
  if (
    normalizedPrefix.length >= 2 &&
    (matchAdvanced(name, normalizedPrefix).matched ||
      command.aliases?.some(
        alias => matchAdvanced(alias, normalizedPrefix).matched,
      ))
  ) {
    return 3
  }
  return null
}

export function generateSlashCommandSuggestions(args: {
  commands: Command[]
  prefix: string
}): UnifiedSuggestion[] {
  const { commands, prefix } = args
  const filteredCommands = commands.filter(cmd => !cmd.isHidden)

  if (!prefix) {
    const sorted = [...filteredCommands].sort(compareCommandsForDiscovery)
    const visible = sorted.slice(0, EMPTY_PREFIX_MAX_COMMANDS)
    const moreCount = Math.max(0, sorted.length - EMPTY_PREFIX_MAX_COMMANDS)
    return visible.map(cmd => ({
      value: cmd.userFacingName(),
      displayValue: buildCommandDisplayValue(cmd),
      description: buildCommandDescription(cmd),
      type: 'command' as const,
      score: 100,
      metadata: {
        color: getCommandCategory(cmd).color,
        moreCount,
      },
    }))
  }

  return filteredCommands
    .map(command => ({
      command,
      matchRank: getCommandMatchRank(command, prefix),
    }))
    .filter(
      (match): match is { command: Command; matchRank: number } =>
        match.matchRank !== null,
    )
    .sort((a, b) => {
      const matchOrder = a.matchRank - b.matchRank
      return matchOrder !== 0
        ? matchOrder
        : compareCommandsForDiscovery(a.command, b.command)
    })
    .map(({ command, matchRank }) => ({
      value: command.userFacingName(),
      displayValue: buildCommandDisplayValue(command),
      description: buildCommandDescription(command),
      type: 'command' as const,
      score: 300 - matchRank * 100 - prefix.length,
      metadata: {
        color: getCommandCategory(command).color,
      },
    }))
}
