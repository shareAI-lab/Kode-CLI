const REDACTED_VALUE = '[REDACTED]'

const SENSITIVE_PATTERNS: readonly RegExp[] = [
  /-----BEGIN(?: [A-Z0-9]+)? PRIVATE KEY-----[\s\S]*?-----END(?: [A-Z0-9]+)? PRIVATE KEY-----/gi,
  /\b(?:sk|rk|pk)[_-][A-Za-z0-9_-]{16,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/gi,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/gi,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{12,}\b/gi,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}\b/gi,
  /\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|secret|password|passwd)\s*[:=]\s*[^\s,;]+/gi,
  /\bhttps?:\/\/[^\s/:]+:[^\s@/]+@/gi,
]

const SENSITIVE_ONLY_LABELS = new Set([
  'api',
  'api key',
  'apikey',
  'access token',
  'auth token',
  'secret',
  'password',
  'passwd',
  'token',
])

export type RedactionResult = {
  text: string
  redactions: number
  containsSensitiveValue: boolean
}

/**
 * Redacts common credential forms before memory reaches disk or an LLM prompt.
 * It is defense in depth, not a credential scanner suitable for DLP.
 */
export function redactSensitiveMemoryText(value: string): RedactionResult {
  let text = String(value ?? '')
  let redactions = 0

  for (const pattern of SENSITIVE_PATTERNS) {
    text = text.replace(pattern, () => {
      redactions += 1
      return REDACTED_VALUE
    })
  }

  return {
    text,
    redactions,
    containsSensitiveValue: redactions > 0,
  }
}

export function isSensitiveOnlyMemory(value: string): boolean {
  const compact = value
    .replace(/\[REDACTED\]/g, '')
    .replace(/[\s:=_-]+/g, ' ')
    .trim()
    .toLowerCase()

  return compact.length === 0 || SENSITIVE_ONLY_LABELS.has(compact)
}

export function mayContainSensitiveTypedValue(value: string): boolean {
  return redactSensitiveMemoryText(value).containsSensitiveValue
}
