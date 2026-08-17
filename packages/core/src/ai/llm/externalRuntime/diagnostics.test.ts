import { describe, expect, test } from 'bun:test'

import {
  appendExternalRuntimeStderr,
  formatExternalRuntimeCloseMessage,
  formatExternalRuntimeDiagnostic,
} from './diagnostics'

describe('external runtime diagnostics', () => {
  test('keeps the stderr tail and redacts credential-shaped values', () => {
    const stderr = appendExternalRuntimeStderr(
      'x'.repeat(5_000),
      '\napi_key=secret-value\nconnection refused\n',
    )
    const message = formatExternalRuntimeCloseMessage(
      'Codex app-server',
      stderr,
    )

    expect(stderr).toContain('connection refused')
    expect(stderr.length).toBeLessThanOrEqual(4_096)
    expect(message).toContain('connection refused')
    expect(message).toContain('[REDACTED]')
    expect(message).not.toContain('secret-value')
  })

  test('removes terminal control characters from diagnostics', () => {
    expect(formatExternalRuntimeDiagnostic('\u001b[31mfailed\u001b[0m')).toBe(
      'failed',
    )
  })
})
