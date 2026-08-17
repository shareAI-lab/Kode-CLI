export type ParsedSlashCommand = { commandName: string; args: string }

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object') return null
  return value as Record<string, unknown>
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string')
}

export function normalizeCommandModelName(model: unknown): string | undefined {
  if (typeof model !== 'string') return undefined
  const trimmed = model.trim()
  if (!trimmed || trimmed === 'inherit') return undefined
  if (trimmed === 'haiku') return 'quick'
  if (trimmed === 'sonnet') return 'task'
  if (trimmed === 'opus') return 'main'
  return trimmed
}

export function parseSlashCommand(command: string): ParsedSlashCommand | null {
  const trimmed = command.trim()
  if (!trimmed.startsWith('/')) return null
  const withoutSlash = trimmed.slice(1)
  const spaceIdx = withoutSlash.indexOf(' ')
  const commandName =
    spaceIdx === -1
      ? withoutSlash.trim()
      : withoutSlash.slice(0, spaceIdx).trim()
  if (!commandName) return null
  const args = spaceIdx === -1 ? '' : withoutSlash.slice(spaceIdx + 1).trim()
  return { commandName, args }
}

export function findCommand(
  commandName: string,
  commands: unknown[],
): unknown | null {
  for (const c of commands) {
    const record = asRecord(c)
    if (!record) continue

    if (record.name === commandName) return c

    const userFacingName = record.userFacingName
    if (typeof userFacingName === 'function') {
      try {
        if (userFacingName.call(c) === commandName) return c
      } catch {
        /* no-op */
      }
    }

    if (Array.isArray(record.aliases) && record.aliases.includes(commandName)) {
      return c
    }
  }
  return null
}

export function getCommandFlags(cmd: unknown): {
  disableModelInvocation: boolean
  disableNonInteractive: boolean
} {
  const record = asRecord(cmd)
  return {
    disableModelInvocation: record?.disableModelInvocation === true,
    disableNonInteractive: record?.disableNonInteractive === true,
  }
}

export function getCommandOverrides(cmd: unknown): {
  progressMessage: string
  allowedTools: string[]
  model: string | undefined
  maxThinkingTokens: number | undefined
} {
  const record = asRecord(cmd)
  const progressMessage =
    typeof record?.progressMessage === 'string' && record.progressMessage.trim()
      ? record.progressMessage.trim()
      : 'running'

  const allowedTools = stringArray(record?.allowedTools)
  const model = normalizeCommandModelName(record?.model)
  const maxThinkingTokens =
    typeof record?.maxThinkingTokens === 'number'
      ? record.maxThinkingTokens
      : undefined

  return { progressMessage, allowedTools, model, maxThinkingTokens }
}

export function getCommandAllowedToolsFromContext(ctx: unknown): string[] {
  const record = asRecord(ctx)
  const options = asRecord(record?.options)
  return stringArray(options?.commandAllowedTools)
}
