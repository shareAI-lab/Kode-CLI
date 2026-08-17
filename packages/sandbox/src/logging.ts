/**
 * Lightweight logging for @kode/sandbox.
 *
 * @kode/sandbox must stay free of @kode/core dependencies (leaf package), so
 * it cannot use the core logging subsystem. These helpers keep the warning
 * and error surfaces explicit; swap for an injected logger if a host ever
 * needs structured capture.
 */

export function warnSandbox(
  event: string,
  data: Record<string, unknown>,
): void {
  console.warn(`[kode:sandbox] ${event}`, data)
}

export function logSandboxError(error: unknown): void {
  console.error('[kode:sandbox]', error)
}
