import type { ImageBlockParam } from '@anthropic-ai/sdk/resources/index.mjs'

type AnthropicImageMediaType = Extract<
  ImageBlockParam['source'],
  { type: 'base64' }
>['media_type']

const ALLOWED_IMAGE_MEDIA_TYPES = new Set<AnthropicImageMediaType>([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
])

export function coerceImageMediaType(value: string): AnthropicImageMediaType {
  return ALLOWED_IMAGE_MEDIA_TYPES.has(value as AnthropicImageMediaType)
    ? (value as AnthropicImageMediaType)
    : 'image/png'
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object') return null
  return value as Record<string, unknown>
}

export function collectCommandNames(
  commands: ReadonlyArray<{
    userFacingName(): string
    aliases?: string[]
  }>,
): string[] {
  const names = new Set<string>()
  for (const command of commands) {
    const name = command.userFacingName().trim()
    if (name) names.add(name)
    for (const alias of command.aliases ?? []) {
      const trimmed = alias.trim()
      if (trimmed) names.add(trimmed)
    }
  }
  return [...names]
}

export function levenshteinDistance(a: string, b: string): number {
  if (a === b) return 0
  if (a.length === 0) return b.length
  if (b.length === 0) return a.length

  const prev = new Array<number>(b.length + 1)
  const curr = new Array<number>(b.length + 1)
  for (let j = 0; j <= b.length; j += 1) prev[j] = j

  for (let i = 1; i <= a.length; i += 1) {
    curr[0] = i
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      curr[j] = Math.min(
        (prev[j] ?? 0) + 1,
        (curr[j - 1] ?? 0) + 1,
        (prev[j - 1] ?? 0) + cost,
      )
    }
    for (let j = 0; j <= b.length; j += 1) prev[j] = curr[j] ?? 0
  }

  return prev[b.length] ?? b.length
}

export function suggestUnknownSlashCommands(
  typed: string,
  names: readonly string[],
  limit = 3,
): string[] {
  const query = typed.trim().toLowerCase()
  if (!query || names.length === 0) return []

  const maxDistance =
    query.length < 3 ? -1 : Math.max(1, Math.floor(query.length / 2))
  const ranked = names
    .map(name => {
      const lower = name.toLowerCase()
      if (lower === query) return { name, score: -1 }
      if (lower.startsWith(query)) return { name, score: 0 }
      if (lower.includes(query)) return { name, score: 1 }
      if (maxDistance < 0) return { name, score: Number.POSITIVE_INFINITY }
      return { name, score: levenshteinDistance(query, lower) }
    })
    .filter(item => item.score <= Math.max(1, maxDistance))
    .sort(
      (left, right) =>
        left.score - right.score || left.name.localeCompare(right.name),
    )

  const suggestions: string[] = []
  const seen = new Set<string>()
  for (const item of ranked) {
    if (seen.has(item.name)) continue
    seen.add(item.name)
    suggestions.push(item.name)
    if (suggestions.length >= limit) break
  }
  return suggestions
}

export function formatUnknownSlashCommandMessage(
  typed: string,
  names: readonly string[],
): string {
  const command = typed.trim().replace(/^\//, '')
  const suggestions = suggestUnknownSlashCommands(command, names)
  const lines = [`Unknown command: /${command}`]
  if (suggestions.length > 0) {
    lines.push(
      `Did you mean: ${suggestions.map(name => `/${name}`).join(', ')}`,
    )
  }
  lines.push(
    'Type /help or press F1 for commands. Start a line with // to send a literal slash.',
  )
  return lines.join('\n')
}

export function extractAssistantText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    const record = asRecord(block)
    if (!record || record.type !== 'text') continue
    parts.push(String(record.text ?? ''))
  }
  return parts.join('')
}
