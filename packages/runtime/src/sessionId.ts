import { LEGACY_ENV } from '#config/compat/legacyEnv'
import {
  getKodeAgentSessionId,
  setKodeAgentSessionId,
} from '#protocol/utils/kodeAgentSessionId'

export function getEffectiveSessionId(): string {
  const candidates = [
    process.env.KODE_SESSION_ID,
    process.env.ANYKODE_SESSION_ID,
    process.env[LEGACY_ENV.codeSessionId],
  ]

  for (const value of candidates) {
    if (typeof value !== 'string') continue
    const trimmed = value.trim()
    if (trimmed) return trimmed
  }

  return getKodeAgentSessionId()
}

export function syncSessionIdToProcessEnv(sessionId: string): void {
  process.env.KODE_SESSION_ID = sessionId
  process.env[LEGACY_ENV.codeSessionId] = sessionId
}

export function setSessionId(sessionId: string): void {
  setKodeAgentSessionId(sessionId)
  syncSessionIdToProcessEnv(sessionId)
}

export function refreshSessionIdEnv(): void {
  syncSessionIdToProcessEnv(getKodeAgentSessionId())
}
