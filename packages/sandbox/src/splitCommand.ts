import { parse, type ParseEntry } from 'shell-quote'

/**
 * Inline copy of `splitCommand` (originally in `#core/utils/commands`),
 * so @kode/sandbox does not depend on core. Kept byte-identical to the
 * core implementation; if the core copy evolves, mirror the change here
 * or lift both into a shared low-level package.
 */

const SINGLE_QUOTE = '__SINGLE_QUOTE__'
const DOUBLE_QUOTE = '__DOUBLE_QUOTE__'
const NEW_LINE = '__NEW_LINE__'

const COMMAND_LIST_SEPARATORS = new Set<string>([
  '&&',
  '||',
  ';',
  ';;',
  '|',
  '|&',
  '&',
])

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object') return null
  if (Array.isArray(value)) return null
  return value as Record<string, unknown>
}

/**
 * Splits a command string into individual commands based on shell operators
 */
export function splitCommand(command: string): string[] {
  const tokens: ParseEntry[] = []

  const normalized = command.replace(/\r\n/g, '\n').replace(/\\\n/g, '')

  const parsed = parse(
    normalized
      .replaceAll('"', `"${DOUBLE_QUOTE}`) // parse() strips out quotes :P
      .replaceAll("'", `'${SINGLE_QUOTE}`) // parse() strips out quotes :P
      .replaceAll('\n', `\n${NEW_LINE}\n`),
    varName => `$${varName}`, // Preserve shell variables
  )

  function pushStringToken(part: string) {
    if (part === '') return
    if (part === NEW_LINE) {
      tokens.push(part)
      return
    }
    if (
      tokens.length > 0 &&
      typeof tokens[tokens.length - 1] === 'string' &&
      tokens[tokens.length - 1] !== NEW_LINE
    ) {
      tokens[tokens.length - 1] += ' ' + part
      return
    }
    tokens.push(part)
  }

  // 1) Collapse adjacent strings and globs.
  let pendingLineContinuation = false
  for (const part of parsed) {
    if (typeof part === 'string') {
      if (part === '') {
        pendingLineContinuation = true
        continue
      }

      // Backslash-newline ("line continuation") should not be treated as a
      // command separator. `shell-quote` yields an empty string token right
      // before the escaped newline; we use that to treat NEW_LINE as whitespace.
      if (part === NEW_LINE && pendingLineContinuation) {
        pendingLineContinuation = false
        continue
      }

      pendingLineContinuation = false
      pushStringToken(part)
      continue
    }

    pendingLineContinuation = false

    if (
      part &&
      typeof part === 'object' &&
      'op' in part &&
      part.op === 'glob'
    ) {
      const record = asRecord(part)
      const pattern =
        record && 'pattern' in record ? String(record.pattern) : ''
      pushStringToken(pattern)
      continue
    }

    tokens.push(part)
  }

  // 2) Convert tokens to split parts.
  const parts: Array<string | null> = tokens.map(part => {
    if (typeof part === 'string') {
      const restored = part
        .replaceAll(`${SINGLE_QUOTE}`, "'")
        .replaceAll(`${DOUBLE_QUOTE}`, '"')
      if (restored === NEW_LINE) return null
      return restored
    }
    if (!part || typeof part !== 'object') return null
    if ('comment' in part) return null // comments are unsafe; treat as split boundary
    if ('op' in part) {
      const record = asRecord(part)
      if (record && typeof record.op === 'string') return record.op
    }
    return null
  })

  // 3) Split on safe separators and newlines, keep other operators inside segment.
  const out: string[] = []
  let current = ''
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!
    const next = parts[i + 1]

    if (part === null) {
      const trimmed = current.trim()
      if (trimmed) out.push(trimmed)
      current = ''
      continue
    }

    // Bash `&>` / `&>>` redirects stdout+stderr. `shell-quote` tokenizes this
    // as `&` then `>`/`>>`, so treat it as a redirection operator, not a
    // command separator.
    if (part === '&' && (next === '>' || next === '>>')) {
      const combined = `${part}${next}`
      current = current ? `${current} ${combined}` : combined
      i++
      continue
    }

    if ((COMMAND_LIST_SEPARATORS as Set<string>).has(part)) {
      const trimmed = current.trim()
      if (trimmed) out.push(trimmed)
      current = ''
      continue
    }

    current = current ? `${current} ${part}` : part
  }
  const trimmed = current.trim()
  if (trimmed) out.push(trimmed)

  return out
}
