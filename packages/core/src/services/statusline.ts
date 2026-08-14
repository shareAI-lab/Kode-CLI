import {
  getSettingsFileCandidates,
  loadSettingsWithLegacyFallback,
  saveSettingsToPrimaryAndSyncLegacy,
} from '#config'
import { getDisableAllHooksState } from '@kode/hooks/disableAllHooks'
import { getCwd } from '#runtime/cwd'

type UserSettings = {
  statusLine?: unknown
  [key: string]: unknown
}

function normalizeString(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed ? trimmed : null
}

function normalizePadding(value: unknown): number | null {
  if (typeof value !== 'number') return null
  if (!Number.isFinite(value)) return null
  const rounded = Math.floor(value)
  return rounded >= 0 ? rounded : null
}

export function getUserSettingsPath(): string {
  const candidates = getSettingsFileCandidates({ destination: 'userSettings' })
  return candidates?.primary ?? ''
}

export type StatusLineConfig = {
  type: 'command'
  command: string
  padding?: number
}

export function getStatusLineConfig(): StatusLineConfig | null {
  const hooksDisabled = getDisableAllHooksState({
    projectDir: getCwd(),
  }).disabled
  if (hooksDisabled) return null

  const loaded = loadSettingsWithLegacyFallback({
    destination: 'userSettings',
    migrateToPrimary: true,
  })
  const settings = (loaded.settings as UserSettings | null) ?? {}

  const raw = settings.statusLine
  if (typeof raw === 'string') {
    const command = normalizeString(raw)
    return command ? { type: 'command', command } : null
  }
  if (raw && typeof raw === 'object') {
    const record = raw as Record<string, unknown>
    const typeRaw = record.type
    if (typeRaw !== undefined && typeRaw !== 'command') return null

    const command = normalizeString(record.command)
    if (!command) return null

    const padding = normalizePadding(record.padding)
    return {
      type: 'command',
      command,
      ...(padding !== null ? { padding } : {}),
    }
  }
  return null
}

export function getStatusLineCommand(): string | null {
  return getStatusLineConfig()?.command ?? null
}

export function getStatusLinePadding(): number {
  return getStatusLineConfig()?.padding ?? 0
}

export function setStatusLineCommand(command: string | null): void {
  const loaded = loadSettingsWithLegacyFallback({
    destination: 'userSettings',
    migrateToPrimary: true,
  })
  const existing = (loaded.settings as UserSettings | null) ?? {}
  const next: UserSettings = { ...existing }
  if (command === null) {
    delete next.statusLine
  } else {
    const normalized = normalizeString(command)
    if (!normalized) {
      delete next.statusLine
    } else {
      const existingPadding =
        existing.statusLine &&
        typeof existing.statusLine === 'object' &&
        !Array.isArray(existing.statusLine)
          ? normalizePadding(
              (existing.statusLine as Record<string, unknown>).padding,
            )
          : null

      next.statusLine = {
        type: 'command',
        command: normalized,
        ...(existingPadding !== null ? { padding: existingPadding } : {}),
      }
    }
  }
  saveSettingsToPrimaryAndSyncLegacy({
    destination: 'userSettings',
    settings: next,
    syncLegacyIfExists: true,
  })
}
