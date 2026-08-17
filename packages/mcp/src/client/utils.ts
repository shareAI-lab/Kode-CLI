import { LEGACY_ENV } from '#config/compat/legacyEnv'
import { KODE_HOOK_ENV } from '#core/compat/hookEnv'

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stripJsonComments(input: string): string {
  let out = ''
  let inString = false
  let escaped = false
  let inLineComment = false
  let inBlockComment = false

  for (let i = 0; i < input.length; i++) {
    const ch = input[i]!
    const next = i + 1 < input.length ? input[i + 1]! : ''

    if (inLineComment) {
      if (ch === '\n') {
        inLineComment = false
        out += ch
      }
      continue
    }

    if (inBlockComment) {
      if (ch === '*' && next === '/') {
        inBlockComment = false
        i++
      }
      continue
    }

    if (inString) {
      out += ch
      if (escaped) {
        escaped = false
        continue
      }
      if (ch === '\\') {
        escaped = true
        continue
      }
      if (ch === '"') inString = false
      continue
    }

    if (ch === '"') {
      inString = true
      out += ch
      continue
    }

    if (ch === '/' && next === '/') {
      inLineComment = true
      i++
      continue
    }

    if (ch === '/' && next === '*') {
      inBlockComment = true
      i++
      continue
    }

    out += ch
  }

  return out
}

export function parseJsonOrJsonc(text: string): unknown {
  const raw = String(text ?? '')
  if (!raw.trim()) return null
  try {
    return JSON.parse(raw)
  } catch {
    try {
      return JSON.parse(stripJsonComments(raw))
    } catch {
      return null
    }
  }
}

function expandTemplateString(value: string, pluginRoot: string): string {
  return value.replace(/\$\{([^}]+)\}/g, (match, key) => {
    const k = String(key ?? '').trim()
    if (!k) return match
    if (k === LEGACY_ENV.pluginRoot || k === KODE_HOOK_ENV.pluginRoot)
      return pluginRoot
    const env = process.env[k]
    return env !== undefined ? env : match
  })
}

export function expandTemplateDeep(
  value: unknown,
  pluginRoot: string,
): unknown {
  if (typeof value === 'string') return expandTemplateString(value, pluginRoot)
  if (Array.isArray(value))
    return value.map(v => expandTemplateDeep(v, pluginRoot))
  if (isRecord(value)) {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) {
      out[k] = expandTemplateDeep(v, pluginRoot)
    }
    return out
  }
  return value
}
