import type { LogLevel } from './levels'

const recentLogs = new Map<string, number>()
const LOG_DEDUPE_WINDOW_MS = 5000

function getFileForDedupe(data: unknown): string {
  if (!data || typeof data !== 'object') return ''
  const record = data as Record<string, unknown>
  const file = record.file
  return typeof file === 'string' ? file : ''
}

function getDedupeKey(level: LogLevel, phase: string, data: unknown): string {
  if (phase.startsWith('CONFIG_')) {
    return `${level}:${phase}:${getFileForDedupe(data)}`
  }
  return `${level}:${phase}`
}

export function shouldLogWithDedupe(
  level: LogLevel,
  phase: string,
  data: unknown,
): boolean {
  const key = getDedupeKey(level, phase, data)
  const now = Date.now()
  const lastLogTime = recentLogs.get(key)

  if (!lastLogTime || now - lastLogTime > LOG_DEDUPE_WINDOW_MS) {
    recentLogs.set(key, now)

    for (const [oldKey, oldTime] of recentLogs.entries()) {
      if (now - oldTime > LOG_DEDUPE_WINDOW_MS) {
        recentLogs.delete(oldKey)
      }
    }

    return true
  }

  return false
}
