import type { CompletionContext } from './types'

function isAtMentionBoundary(input: string, atIndex: number): boolean {
  return atIndex === 0 || /\s/.test(input[atIndex - 1]!)
}

function isAtPathPrefix(content: string): boolean {
  return (
    content.startsWith('.') ||
    content.startsWith('~') ||
    content.includes('/') ||
    content.includes('\\')
  )
}

export function getCompletionContext(args: {
  input: string
  cursorOffset: number
  disableSlashCommands?: boolean
}): CompletionContext | null {
  const { input, cursorOffset } = args
  const disableSlashCommands = args.disableSlashCommands === true
  if (!input) return null

  let start = cursorOffset

  while (start > 0) {
    const char = input[start - 1]!
    if (/\s/.test(char)) break

    // Only treat @ as a mention trigger at a token boundary. Mid-token
    // addresses (user@host, emails) stay part of the current word.
    if (char === '@' && start < cursorOffset) {
      if (isAtMentionBoundary(input, start - 1)) {
        start--
        break
      }
    }

    if (char === '/') {
      const collectedSoFar = input.slice(start, cursorOffset)

      if (collectedSoFar.includes('/') || collectedSoFar.includes('.')) {
        start--
        continue
      }

      if (start > 1) {
        const prevChar = input[start - 2]
        if (prevChar === '.' || prevChar === '~') {
          start--
          continue
        }
      }

      if (start === 1 || (start > 1 && /\s/.test(input[start - 2]!))) {
        start--
        break
      }

      start--
      continue
    }

    if (char === '.' && start > 0) {
      const nextChar = start < input.length ? input[start] : ''
      if (nextChar === '/' || nextChar === '.') {
        start--
        continue
      }
    }

    start--
  }

  const word = input.slice(start, cursorOffset)
  if (!word) return null

  if (word.startsWith('/')) {
    const isCommand = !word.includes('/', 1) && !disableSlashCommands
    return {
      type: isCommand ? 'command' : 'file',
      prefix: isCommand ? word.slice(1) : word,
      startPos: start,
      endPos: cursorOffset,
      trigger: '/',
    }
  }

  if (word.startsWith('@')) {
    const content = word.slice(1)
    if (word.includes('@', 1)) return null
    // @src/ and @~/foo are file mentions; @agent stays an agent mention.
    const type = isAtPathPrefix(content) ? 'file' : 'agent'
    return {
      type,
      prefix: content,
      startPos: start,
      endPos: cursorOffset,
      trigger: '@',
    }
  }

  return {
    type: 'file',
    prefix: word,
    startPos: start,
    endPos: cursorOffset,
    trigger: null,
  }
}
