import { existsSync } from 'fs'
import { join } from 'path'
import envPathsImport from 'env-paths'
import { PRODUCT_COMMAND } from '@kode/constants/product'
import { getKodeRoot as getKodeBaseDir } from '#config/dataRoots'

function resolveEnvPaths(): typeof envPathsImport {
  if (typeof envPathsImport === 'function') return envPathsImport
  const fallback = (envPathsImport as unknown as { default?: unknown }).default
  if (typeof fallback === 'function') {
    return fallback as typeof envPathsImport
  }
  throw new Error('env-paths did not resolve to a callable function')
}

const paths = resolveEnvPaths()(PRODUCT_COMMAND)

function getProjectDir(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-')
}

function getCwdForLogPath(): string {
  try {
    return process.cwd()
  } catch {
    return 'cwd-unavailable'
  }
}

function getLegacyCacheRoot(): string {
  return process.env.KODE_LEGACY_CACHE_ROOT ?? paths.cache
}

function getNewLogRoot(): string {
  return process.env.KODE_LOG_ROOT ?? getKodeBaseDir()
}

export const CACHE_PATHS = {
  errors: () =>
    join(getNewLogRoot(), getProjectDir(getCwdForLogPath()), 'errors'),
  messages: () =>
    join(getNewLogRoot(), getProjectDir(getCwdForLogPath()), 'messages'),
  mcpLogs: (serverName: string) =>
    join(
      getLegacyCacheRoot(),
      getProjectDir(getCwdForLogPath()),
      `mcp-logs-${serverName}`,
    ),
}

export const LEGACY_CACHE_PATHS = {
  errors: () =>
    join(getLegacyCacheRoot(), getProjectDir(getCwdForLogPath()), 'errors'),
  messages: () =>
    join(getLegacyCacheRoot(), getProjectDir(getCwdForLogPath()), 'messages'),
  mcpLogs: (serverName: string) =>
    join(
      getLegacyCacheRoot(),
      getProjectDir(getCwdForLogPath()),
      `mcp-logs-${serverName}`,
    ),
}

export function dateToFilename(date: Date): string {
  return date.toISOString().replace(/[:.]/g, '-')
}

export const DATE = dateToFilename(new Date())

export function getErrorsPath(): string {
  return join(CACHE_PATHS.errors(), DATE + '.jsonl')
}

export function getLegacyErrorsPath(): string {
  return join(CACHE_PATHS.errors(), DATE + '.txt')
}

export function getMessagesPath(
  messageLogName: string,
  forkNumber: number,
  sidechainNumber: number,
): string {
  return join(
    CACHE_PATHS.messages(),
    `${messageLogName}${forkNumber > 0 ? `-${forkNumber}` : ''}${
      sidechainNumber > 0 ? `-sidechain-${sidechainNumber}` : ''
    }.json`,
  )
}

export function parseLogFilename(filename: string): {
  date: string
  forkNumber: number | undefined
  sidechainNumber: number | undefined
} {
  const base = filename.split('.')[0]!
  // Default timestamp format has 6 segments: 2025-01-27T01-31-35-104Z
  const segments = base.split('-')
  const hasSidechain = base.includes('-sidechain-')

  let date = base
  let forkNumber: number | undefined = undefined
  let sidechainNumber: number | undefined = undefined

  if (hasSidechain) {
    const sidechainIndex = segments.indexOf('sidechain')
    sidechainNumber = Number(segments[sidechainIndex + 1])
    // Fork number is before sidechain if exists
    if (sidechainIndex > 6) {
      forkNumber = Number(segments[sidechainIndex - 1])
      date = segments.slice(0, 6).join('-')
    } else {
      date = segments.slice(0, 6).join('-')
    }
  } else if (segments.length > 6) {
    // Has fork number
    const lastSegment = Number(segments[segments.length - 1])
    forkNumber = lastSegment >= 0 ? lastSegment : undefined
    date = segments.slice(0, 6).join('-')
  } else {
    // Basic timestamp only
    date = base
  }

  return { date, forkNumber, sidechainNumber }
}

export function getNextAvailableLogForkNumber(
  date: string,
  forkNumber: number,
  // Main chain has sidechainNumber 0
  sidechainNumber: number,
): number {
  while (existsSync(getMessagesPath(date, forkNumber, sidechainNumber))) {
    forkNumber++
  }
  return forkNumber
}

export function getNextAvailableLogSidechainNumber(
  date: string,
  forkNumber: number,
): number {
  let sidechainNumber = 1
  while (existsSync(getMessagesPath(date, forkNumber, sidechainNumber))) {
    sidechainNumber++
  }
  return sidechainNumber
}

export function getForkNumberFromFilename(
  filename: string,
): number | undefined {
  const base = filename.split('.')[0]!
  const segments = base.split('-')
  const hasSidechain = base.includes('-sidechain-')

  if (hasSidechain) {
    const sidechainIndex = segments.indexOf('sidechain')
    if (sidechainIndex > 6) {
      return Number(segments[sidechainIndex - 1])
    }
    return undefined
  }

  if (segments.length > 6) {
    const lastNumber = Number(segments[segments.length - 1])
    return lastNumber >= 0 ? lastNumber : undefined
  }
  return undefined
}
