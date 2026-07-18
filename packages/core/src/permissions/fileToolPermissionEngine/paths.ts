import { existsSync, realpathSync, statSync } from 'fs'
import { homedir } from 'os'
import path from 'path'

import type { SettingsDestination } from '#config'
import { getSettingsFileCandidates } from '#config'
import type { ToolPermissionContext } from '#core/types/toolPermissionContext'
import { getCwd, getOriginalCwd } from '#core/utils/state'
import { LEGACY_CONFIG_DIRNAME } from '#core/compat/legacyPaths'

const POSIX = path.posix
const POSIX_SEP = POSIX.sep

const SENSITIVE_DIR_NAMES = new Set([
  '.git',
  '.vscode',
  '.idea',
  LEGACY_CONFIG_DIRNAME,
  '.kode',
  '.ssh',
])
const SENSITIVE_FILE_NAMES = new Set([
  '.gitconfig',
  '.gitmodules',
  '.bashrc',
  '.bash_profile',
  '.zshrc',
  '.zprofile',
  '.profile',
  '.ripgreprc',
  '.mcp.json',
])

export function resolveLikeCliPath(
  inputPath: string,
  baseDir?: string,
): string {
  const base = baseDir ?? getCwd()
  if (typeof inputPath !== 'string') {
    throw new TypeError(`Path must be a string, received ${typeof inputPath}`)
  }
  if (typeof base !== 'string') {
    throw new TypeError(
      `Base directory must be a string, received ${typeof base}`,
    )
  }
  if (inputPath.includes('\0') || base.includes('\0')) {
    throw new Error('Path contains null bytes')
  }

  const trimmed = inputPath.trim()
  if (!trimmed) return path.resolve(base)

  if (trimmed === '~') return path.resolve(homedir())
  if (trimmed.startsWith('~/') || trimmed.startsWith('~\\')) {
    return path.resolve(homedir(), trimmed.slice(2))
  }

  if (process.platform === 'win32' && /^\/[a-z]\//i.test(trimmed)) {
    const driveLetter = trimmed[1]?.toUpperCase() ?? 'C'
    const rest = trimmed.slice(2)
    return path.resolve(`${driveLetter}:\\`, rest.replace(/\//g, '\\'))
  }

  return path.isAbsolute(trimmed)
    ? path.resolve(trimmed)
    : path.resolve(base, trimmed)
}

export function toPosixPath(value: string): string {
  if (process.platform !== 'win32') return value

  const withSlashes = value.replace(/\\/g, '/')
  const driveMatch = withSlashes.match(/^([A-Za-z]):\/?(.*)$/)
  if (driveMatch) {
    const drive = driveMatch[1]!.toLowerCase()
    const rest = driveMatch[2] ?? ''
    return `/${drive}/${rest}`.replace(/\/+$/, '/')
  }

  if (withSlashes.startsWith('//')) return withSlashes
  return withSlashes
}

function toLower(value: string): string {
  return value.toLowerCase()
}

export function posixRelative(fromPath: string, toPath: string): string {
  if (process.platform === 'win32') {
    return POSIX.relative(toPosixPath(fromPath), toPosixPath(toPath))
  }
  return POSIX.relative(fromPath, toPath)
}

export function expandSymlinkPaths(inputPath: string): string[] {
  const out = [inputPath]
  if (!existsSync(inputPath)) return out
  try {
    const resolved = realpathSync(inputPath)
    if (resolved && resolved !== inputPath) out.push(resolved)
  } catch {
    // ignore
  }
  return out
}

function matchesSuspiciousWindowsNetworkPathPatterns(
  inputPath: string,
): boolean {
  if (process.platform !== 'win32') return false
  const p = String(inputPath)

  // UNC paths: \\host\share or //host/share
  if (/^\\\\[^\\\\/]+[\\\\/]/.test(p)) return true
  if (/^\/\/[^\\\\/]+[\\\\/]/.test(p)) return true

  if (/@SSL@\d+/i.test(p) || /@\d+@SSL/i.test(p)) return true
  if (/DavWWWRoot/i.test(p)) return true
  if (/^\\\\(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})[\\\\/]/.test(p)) return true
  if (/^\/\/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})[\\\\/]/.test(p)) return true
  if (/^\\\\(\[[\da-fA-F:]+\])[\\\\/]/.test(p)) return true
  if (/^\/\/(\[[\da-fA-F:]+\])[\\\\/]/.test(p)) return true
  return false
}

export function hasSuspiciousWindowsPathPattern(inputPath: string): boolean {
  const p = String(inputPath)

  if (p.indexOf(':', 2) !== -1) return true
  // Windows commonly exposes legitimate 8.3 short paths (for example,
  // ADMINI~1). Treat them as suspicious only when they appear off Windows.
  if (process.platform !== 'win32' && /~\d/.test(p)) return true
  if (
    p.startsWith('\\\\?\\') ||
    p.startsWith('\\\\.\\') ||
    p.startsWith('//?/') ||
    p.startsWith('//./')
  ) {
    return true
  }
  if (/[.\s]+$/.test(p)) return true
  if (/\.(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i.test(p)) return true
  if (/(^|[\\\\/])\.{3,}([\\\\/]|$)/.test(p)) return true
  if (matchesSuspiciousWindowsNetworkPathPatterns(p)) return true

  return false
}

export function isSensitiveFilePath(inputPath: string): boolean {
  const p = String(inputPath)
  if (p.startsWith('\\\\') || p.startsWith('//')) return true

  const absolutePath = resolveLikeCliPath(p)
  const parts = toPosixPath(absolutePath).split(POSIX_SEP)
  const base = parts[parts.length - 1] ?? ''

  for (const part of parts) {
    if (SENSITIVE_DIR_NAMES.has(toLower(part))) return true
  }
  if (base && SENSITIVE_FILE_NAMES.has(toLower(base))) return true
  return false
}

function getSettingsPathsForWriteProtection(options?: {
  projectDir?: string
  homeDir?: string
}): string[] {
  const projectDir = options?.projectDir ?? getOriginalCwd()
  const homeDir = options?.homeDir ?? homedir()
  const destinations: SettingsDestination[] = [
    'userSettings',
    'projectSettings',
    'localSettings',
  ]
  const out: string[] = []
  for (const destination of destinations) {
    const candidates = getSettingsFileCandidates({
      destination,
      projectDir,
      homeDir,
    })
    if (!candidates) continue
    out.push(candidates.primary)
    out.push(...candidates.legacy)
  }
  return Array.from(new Set(out))
}

function hasParentTraversalSegment(relativePath: string): boolean {
  return /(?:^|[\\\\/])\.\.(?:[\\\\/]|$)/.test(relativePath)
}

function normalizeMacPrivatePrefix(input: string): string {
  if (input.startsWith('/private/var/')) {
    return `/var/${input.slice('/private/var/'.length)}`
  }

  if (input === '/private/tmp') return '/tmp'
  if (input.startsWith('/private/tmp/')) {
    return `/tmp/${input.slice('/private/tmp/'.length)}`
  }

  return input
}

function isPosixSubpath(base: string, target: string): boolean {
  const rel = POSIX.relative(base, target)
  if (rel === '') return true
  if (hasParentTraversalSegment(rel)) return false
  if (POSIX.isAbsolute(rel)) return false
  return true
}

export function isWriteProtectedPath(
  inputPath: string,
  options?: {
    projectDir?: string
    homeDir?: string
  },
): boolean {
  const absolutePath = resolveLikeCliPath(inputPath)
  const normalized = toLower(toPosixPath(absolutePath))

  const settingsPaths = new Set(
    getSettingsPathsForWriteProtection(options).map(p =>
      toLower(toPosixPath(resolveLikeCliPath(p))),
    ),
  )

  if (normalized.endsWith(`/${LEGACY_CONFIG_DIRNAME}/settings.json`))
    return true
  if (normalized.endsWith(`/${LEGACY_CONFIG_DIRNAME}/settings.local.json`))
    return true
  if (normalized.endsWith('/.kode/settings.json')) return true
  if (normalized.endsWith('/.kode/settings.local.json')) return true
  if (settingsPaths.has(normalized)) return true

  const projectRoot = options?.projectDir ?? getOriginalCwd()
  const projectRootPosix = toPosixPath(resolveLikeCliPath(projectRoot))
  const protectedDirs = [
    POSIX.join(projectRootPosix, LEGACY_CONFIG_DIRNAME, 'commands'),
    POSIX.join(projectRootPosix, LEGACY_CONFIG_DIRNAME, 'agents'),
    POSIX.join(projectRootPosix, LEGACY_CONFIG_DIRNAME, 'skills'),
    POSIX.join(projectRootPosix, '.kode', 'commands'),
    POSIX.join(projectRootPosix, '.kode', 'agents'),
    POSIX.join(projectRootPosix, '.kode', 'skills'),
  ]

  for (const dir of protectedDirs) {
    if (isPosixSubpath(dir, toPosixPath(absolutePath))) return true
  }

  return false
}

export function isPathInWorkingDirectories(
  inputPath: string,
  context: ToolPermissionContext,
): boolean {
  const roots = new Set<string>([
    getOriginalCwd(),
    ...Array.from(context.additionalWorkingDirectories.keys()),
  ])

  return expandSymlinkPaths(inputPath).every(candidate => {
    return Array.from(roots).some(root => {
      const resolvedCandidate = resolveLikeCliPath(candidate)
      const resolvedRoot = resolveLikeCliPath(root)
      const candidatePosix = normalizeMacPrivatePrefix(
        toPosixPath(resolvedCandidate),
      )
      const rootPosix = normalizeMacPrivatePrefix(toPosixPath(resolvedRoot))
      const relative = posixRelative(
        toLower(rootPosix),
        toLower(candidatePosix),
      )
      if (relative === '') return true
      if (hasParentTraversalSegment(relative)) return false
      if (POSIX.isAbsolute(relative)) return false
      return true
    })
  })
}
