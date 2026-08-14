import { existsSync, mkdirSync, symlinkSync, unlinkSync } from 'fs'
import { dirname, join } from 'path'

import { LEGACY_ENV } from '#config/compat/legacyEnv'
import { getKodeRoot as getKodeBaseDir } from '#config/dataRoots'
import { appendJsonlAsync } from '@kode/runtime'
import { getKodeAgentSessionId } from '#protocol/utils/kodeAgentSessionId'

import { isDebugMode } from './mode'
import type { LogEntry } from './types'

export const STARTUP_TIMESTAMP = new Date().toISOString().replace(/[:.]/g, '-')
const REQUEST_START_TIME = Date.now()

export function getKodeDir(): string {
  return getKodeBaseDir()
}

export const KODE_DIR = getKodeDir()

function getProjectDir(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-')
}

function getDebugLogFileOverride(): string | null {
  const override =
    process.env.KODE_DEBUG_LOG_PATH ?? process.env[LEGACY_ENV.codeDebugLogsDir]

  if (!override) return null
  const trimmed = String(override).trim()
  return trimmed ? trimmed : null
}

export const DEBUG_PATHS = {
  base: () => join(getKodeDir(), getProjectDir(process.cwd()), 'debug'),
  detailed: () =>
    getDebugLogFileOverride() ??
    join(DEBUG_PATHS.base(), `${getKodeAgentSessionId()}.txt`),
  flow: () => join(DEBUG_PATHS.base(), `${STARTUP_TIMESTAMP}-flow.log`),
  api: () => join(DEBUG_PATHS.base(), `${STARTUP_TIMESTAMP}-api.log`),
  state: () => join(DEBUG_PATHS.base(), `${STARTUP_TIMESTAMP}-state.log`),
  latest: () => join(dirname(DEBUG_PATHS.detailed()), 'latest'),
}

type SymlinkState = { linkPath: string; targetPath: string }
let latestSymlinkState: SymlinkState | null = null

function createLatestSymlink(): void {
  if (process.argv[2] === '--ripgrep') return

  try {
    const latestPath = DEBUG_PATHS.latest()
    const detailedPath = DEBUG_PATHS.detailed()

    const logDir = dirname(detailedPath)
    if (!existsSync(logDir)) return

    if (
      latestSymlinkState?.linkPath === latestPath &&
      latestSymlinkState?.targetPath === detailedPath &&
      existsSync(latestPath)
    ) {
      return
    }

    if (existsSync(latestPath)) {
      try {
        unlinkSync(latestPath)
      } catch {
        // ignore: may fail on Windows or permission issues
      }
    }

    symlinkSync(detailedPath, latestPath)
    latestSymlinkState = { linkPath: latestPath, targetPath: detailedPath }
  } catch {
    // ignore: symlink creation may fail on Windows or certain filesystems
  }
}

export function ensureDebugDir(): void {
  const debugDir = DEBUG_PATHS.base()
  if (!existsSync(debugDir)) {
    mkdirSync(debugDir, { recursive: true })
  }

  const detailedDir = dirname(DEBUG_PATHS.detailed())
  if (detailedDir !== debugDir && !existsSync(detailedDir)) {
    mkdirSync(detailedDir, { recursive: true })
  }

  createLatestSymlink()
}

export function writeToFile(filePath: string, entry: LogEntry): void {
  if (!isDebugMode()) return

  try {
    ensureDebugDir()
    const logLine =
      JSON.stringify(
        {
          ...entry,
          sessionId: getKodeAgentSessionId(),
          pid: process.pid,
          uptime: Date.now() - REQUEST_START_TIME,
        },
        null,
        2,
      ) + ',\n'

    appendJsonlAsync({ filePath, entry: logLine })
  } catch {
    // ignore
  }
}
