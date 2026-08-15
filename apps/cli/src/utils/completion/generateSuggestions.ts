import type { Command } from '#cli-commands'
import type { CompletionContext, UnifiedSuggestion } from './types'
import { generateFileSuggestions } from './fileSuggestions'
import { generateMentionSuggestions } from './mentionSuggestions'
import { generateSlashCommandSuggestions } from './slashCommandSuggestions'
import { generateUnixCommandSuggestions } from './unixCommandSuggestions'
import { existsSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { LEGACY_CONFIG_DIRNAME } from '#core/compat/legacyPaths'

function suggestionBaseName(value: string): string {
  const trimmed = value.replace(/[\\/]+$/, '')
  const sep = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  return sep === -1 ? trimmed : trimmed.slice(sep + 1)
}

function isPrefixHit(value: string, prefix: string): boolean {
  const lower = prefix.toLowerCase()
  if (!lower) return true
  return (
    value.toLowerCase().startsWith(lower) ||
    suggestionBaseName(value).toLowerCase().startsWith(lower)
  )
}

function isMentionPrefixHit(
  suggestion: UnifiedSuggestion,
  prefix: string,
): boolean {
  if (isPrefixHit(suggestion.value, prefix)) return true
  return suggestion.value
    .toLowerCase()
    .startsWith(`run-agent-${prefix.toLowerCase()}`)
}

// @src with a cwd file/dir prefix, and no agent/model prefix, should surface
// the file first. @run-agent-* and empty @ stay mention-first.
export function __preferFilesOverMentionsForTests(args: {
  prefix: string
  mentionSuggestions: UnifiedSuggestion[]
  fileSuggestions: UnifiedSuggestion[]
}): boolean {
  if (!args.prefix) return false
  if (
    args.mentionSuggestions.some(item =>
      isMentionPrefixHit(item, args.prefix),
    )
  ) {
    return false
  }
  return args.fileSuggestions.some(item => isPrefixHit(item.value, args.prefix))
}

function generateSpecialFileRootSuggestions(args: {
  prefix: string
  cwd: string
}): UnifiedSuggestion[] {
  const prefix = args.prefix ?? ''
  const shouldSuggestRoots =
    prefix === '' || prefix.startsWith('.') || prefix.startsWith('~')
  if (!shouldSuggestRoots) return []

  const candidates: Array<{
    value: string
    displayValue: string
    existsAt: string
  }> = [
    {
      value: '.kode/',
      displayValue: '📁 .kode/',
      existsAt: join(args.cwd, '.kode'),
    },
    {
      value: `${LEGACY_CONFIG_DIRNAME}/`,
      displayValue: `📁 ${LEGACY_CONFIG_DIRNAME}/`,
      existsAt: join(args.cwd, LEGACY_CONFIG_DIRNAME),
    },
    {
      value: '~/.kode/',
      displayValue: '📁 ~/.kode/',
      existsAt: join(homedir(), '.kode'),
    },
    {
      value: `~/${LEGACY_CONFIG_DIRNAME}/`,
      displayValue: `📁 ~/${LEGACY_CONFIG_DIRNAME}/`,
      existsAt: join(homedir(), LEGACY_CONFIG_DIRNAME),
    },
  ]

  const out: UnifiedSuggestion[] = []
  for (const c of candidates) {
    if (!c.value.toLowerCase().startsWith(prefix.toLowerCase())) continue
    if (!existsSync(c.existsAt)) continue
    out.push({
      value: c.value,
      displayValue: c.displayValue,
      type: 'file',
      score: 120,
      metadata: c.value.includes(LEGACY_CONFIG_DIRNAME)
        ? { color: 'dim' }
        : undefined,
    })
  }

  return out
}

export function generateSuggestionsForContext(args: {
  context: CompletionContext
  commands: Command[]
  agentSuggestions: UnifiedSuggestion[]
  modelSuggestions: UnifiedSuggestion[]
  isLoadingMentionSuggestions?: boolean
  systemCommands: string[]
  isLoadingCommands: boolean
  cwd: string
}): UnifiedSuggestion[] {
  const {
    context,
    commands,
    agentSuggestions,
    modelSuggestions,
    isLoadingMentionSuggestions = false,
    systemCommands,
    isLoadingCommands,
    cwd,
  } = args

  switch (context.type) {
    case 'command':
      return generateSlashCommandSuggestions({
        commands,
        prefix: context.prefix,
      })
    case 'agent': {
      const mentionSuggestions = generateMentionSuggestions({
        prefix: context.prefix,
        agentSuggestions,
        modelSuggestions,
      })
      const mentionLoadingSuggestions: UnifiedSuggestion[] =
        isLoadingMentionSuggestions
          ? [
              {
                value: context.prefix || 'loading',
                displayValue: 'Loading agents and models...',
                type: 'agent',
                score: 0,
                metadata: { isLoading: true },
              },
            ]
          : []
      const fileSuggestions = generateFileSuggestions({
        prefix: context.prefix,
        cwd,
      })
      const preferFiles = __preferFilesOverMentionsForTests({
        prefix: context.prefix,
        mentionSuggestions,
        fileSuggestions,
      })

      const weightedSuggestions = [
        ...mentionLoadingSuggestions.map(s => ({
          ...s,
          weightedScore: 1000,
        })),
        ...mentionSuggestions.map(s => ({
          ...s,
          weightedScore: s.score + (preferFiles ? 10 : 150),
        })),
        ...fileSuggestions.map(s => ({
          ...s,
          weightedScore: s.score + (preferFiles ? 150 : 10),
        })),
      ]

      return weightedSuggestions
        .sort((a, b) => b.weightedScore - a.weightedScore)
        .map(({ weightedScore, ...suggestion }) => suggestion)
    }
    case 'file': {
      const isAtFilePath = context.trigger === '@'
      const specialRootSuggestions = isAtFilePath
        ? generateSpecialFileRootSuggestions({
            prefix: context.prefix,
            cwd,
          })
        : []
      const fileSuggestions = generateFileSuggestions({
        prefix: context.prefix,
        cwd,
      })
      const unixSuggestions = isAtFilePath
        ? []
        : generateUnixCommandSuggestions({
            prefix: context.prefix,
            systemCommands,
            isLoadingCommands,
          })

      const mentionMatches = generateMentionSuggestions({
        prefix: context.prefix,
        agentSuggestions,
        modelSuggestions,
      }).map(s => ({
        ...s,
        isSmartMatch: true,
        displayValue: `\u2192 ${s.displayValue}`,
      }))

      const weightedSuggestions = [
        ...unixSuggestions.map(s => ({
          ...s,
          sourceWeight: s.score >= 10000 ? 5000 : 200,
          weightedScore: s.score >= 10000 ? s.score + 5000 : s.score + 200,
        })),
        ...mentionMatches.map(s => ({
          ...s,
          sourceWeight: isAtFilePath ? 5 : 50,
          weightedScore: s.score + (isAtFilePath ? 5 : 50),
        })),
        ...fileSuggestions.map(s => ({
          ...s,
          sourceWeight: isAtFilePath ? 150 : 0,
          weightedScore: s.score + (isAtFilePath ? 150 : 0),
        })),
        ...specialRootSuggestions.map(s => ({
          ...s,
          sourceWeight: isAtFilePath ? 250 : 0,
          weightedScore: s.score + (isAtFilePath ? 250 : 0),
        })),
      ]

      const seen = new Set<string>()
      const deduplicatedResults = weightedSuggestions
        .sort((a, b) => b.weightedScore - a.weightedScore)
        .filter(item => {
          if (seen.has(item.value)) return false
          seen.add(item.value)
          return true
        })
        .map(({ weightedScore, sourceWeight, ...suggestion }) => suggestion)

      return deduplicatedResults
    }
    default:
      return []
  }
}
