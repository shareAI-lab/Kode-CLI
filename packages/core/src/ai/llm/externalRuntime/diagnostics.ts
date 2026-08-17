import { redactSensitiveMemoryText } from '#core/memory/redaction'

const MAX_STDERR_TAIL_CHARS = 4_096
const MAX_DIAGNOSTIC_CHARS = 2_000

/**
 * Keep only a bounded stderr tail: external runtimes can be noisy, but their
 * final lines are normally the useful failure context.
 */
export function appendExternalRuntimeStderr(
  previous: string,
  chunk: string,
): string {
  return `${previous}${chunk}`.slice(-MAX_STDERR_TAIL_CHARS)
}

/**
 * Diagnostics are written to local error logs, never rendered directly in the
 * TUI. Redact likely credentials and remove control characters first.
 */
export function formatExternalRuntimeDiagnostic(value: string): string {
  const normalized = redactSensitiveMemoryText(value)
    .text.replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

  return normalized.length <= MAX_DIAGNOSTIC_CHARS
    ? normalized
    : `…${normalized.slice(-MAX_DIAGNOSTIC_CHARS)}`
}

export function formatExternalRuntimeCloseMessage(
  runtime: string,
  stderr: string,
): string {
  const diagnostic = formatExternalRuntimeDiagnostic(stderr)
  return diagnostic
    ? `${runtime} closed unexpectedly: ${diagnostic}`
    : `${runtime} closed unexpectedly`
}
