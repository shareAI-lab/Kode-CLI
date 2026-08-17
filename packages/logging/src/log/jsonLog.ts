import { existsSync, readFileSync } from 'fs'
import { dirname } from 'path'
import { MACRO } from '@kode/constants/macros'
import { getKodeAgentSessionId } from '#protocol/utils/kodeAgentSessionId'

import { safeAppendFile, safeMkdir, safeWriteFile } from './filesystem'

function stripBom(content: string): string {
  return content.charCodeAt(0) === 0xfeff ? content.slice(1) : content
}

function isWhitespace(code: number): boolean {
  return code === 0x09 || code === 0x0a || code === 0x0d || code === 0x20
}

function getCwdForLogEntry(): string {
  try {
    return process.cwd()
  } catch {
    return 'cwd-unavailable'
  }
}

function findJsonValueEnd(input: string, start: number): number | null {
  const first = input[start]
  if (!first) return null

  if (first === '{' || first === '[') {
    const stack: string[] = [first === '{' ? '}' : ']']
    let inString = false
    let escaped = false
    for (let i = start + 1; i < input.length; i++) {
      const ch = input[i]
      if (!ch) break

      if (inString) {
        if (escaped) {
          escaped = false
          continue
        }
        if (ch === '\\') {
          escaped = true
          continue
        }
        if (ch === '"') {
          inString = false
        }
        continue
      }

      if (ch === '"') {
        inString = true
        continue
      }

      if (ch === '{') {
        stack.push('}')
        continue
      }
      if (ch === '[') {
        stack.push(']')
        continue
      }

      if (ch === '}' || ch === ']') {
        const expected = stack[stack.length - 1]
        if (expected !== ch) return null
        stack.pop()
        if (stack.length === 0) return i + 1
      }
    }
    return null
  }

  if (first === '"') {
    let escaped = false
    for (let i = start + 1; i < input.length; i++) {
      const ch = input[i]
      if (!ch) break
      if (escaped) {
        escaped = false
        continue
      }
      if (ch === '\\') {
        escaped = true
        continue
      }
      if (ch === '"') {
        return i + 1
      }
    }
    return null
  }

  for (let i = start; i < input.length; i++) {
    const ch = input[i]
    if (!ch) break
    if (ch === ',' || ch === ']') return i
    if (isWhitespace(ch.charCodeAt(0))) return i
  }

  return input.length
}

function recoverJsonArrayPrefix(content: string): unknown[] {
  const input = stripBom(content)
  let i = 0
  while (i < input.length && isWhitespace(input.charCodeAt(i))) i++
  if (input[i] !== '[') return []

  i++
  const values: unknown[] = []

  while (i < input.length) {
    while (i < input.length) {
      const ch = input[i]
      if (!ch) break
      const code = ch.charCodeAt(0)
      if (isWhitespace(code) || ch === ',') {
        i++
        continue
      }
      break
    }

    if (i >= input.length) break
    if (input[i] === ']') break

    const end = findJsonValueEnd(input, i)
    if (!end) break
    const slice = input.slice(i, end)
    try {
      values.push(JSON.parse(slice))
    } catch {
      break
    }
    i = end
  }

  return values
}

function recoverJsonlObjects(content: string): unknown[] {
  const values: unknown[] = []
  for (const rawLine of stripBom(content).split('\n')) {
    const line = rawLine.trim()
    if (!line) continue
    try {
      values.push(JSON.parse(line))
    } catch {
      // ignore invalid line
    }
  }
  return values
}

export function readJsonLog(path: string): object[] {
  if (!existsSync(path)) {
    return []
  }
  let content: string
  try {
    content = readFileSync(path, 'utf8')
  } catch {
    return []
  }

  try {
    const parsed = JSON.parse(content)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    const recovered = recoverJsonArrayPrefix(content)
    if (recovered.length) return recovered as object[]
    const recoveredJsonl = recoverJsonlObjects(content)
    if (recoveredJsonl.length) return recoveredJsonl as object[]
    return []
  }
}

export function appendToJsonLog(
  path: string,
  message: object,
  options?: { userType?: string },
): void {
  const userType = options?.userType ?? process.env.USER_TYPE
  if (userType === 'external') {
    return
  }

  const dir = dirname(path)
  if (!safeMkdir(dir)) {
    return
  }

  const messageWithTimestamp = {
    ...message,
    cwd: getCwdForLogEntry(),
    userType,
    sessionId: getKodeAgentSessionId(),
    timestamp: new Date().toISOString(),
    version: MACRO.VERSION,
  }

  if (path.endsWith('.jsonl')) {
    const line = JSON.stringify(messageWithTimestamp) + '\n'
    safeAppendFile(path, line)
    return
  }

  // Create messages file with empty array if it doesn't exist
  if (!existsSync(path) && !safeWriteFile(path, '[]')) {
    return
  }

  const messages = readJsonLog(path)
  messages.push(messageWithTimestamp)

  safeWriteFile(path, JSON.stringify(messages, null, 2))
}
