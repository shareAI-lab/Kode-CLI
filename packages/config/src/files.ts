import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'

import { getCwd } from './cwd'
import { resolveDataRoots } from './dataRoots'
import { legacyConfigPathInProject } from './compat/legacyPaths'
import { SettingsFileError } from './errors'

export type SettingsDestination =
  'localSettings' | 'projectSettings' | 'userSettings'

export type SettingsFile = {
  [key: string]: unknown
}

function logError(error: unknown): void {
  if (process.env.NODE_ENV === 'test') {
    // eslint-disable-next-line no-console
    console.error(error)
  }
}

export function getSettingsFileCandidates(options: {
  destination: SettingsDestination
  projectDir?: string
  homeDir?: string
}): { primary: string; legacy: string[] } | null {
  const projectDir = options.projectDir ?? getCwd()
  const respectEnvOverride = options.homeDir === undefined

  switch (options.destination) {
    case 'localSettings': {
      const primary = join(projectDir, '.kode', 'settings.local.json')
      const legacy = [
        legacyConfigPathInProject(projectDir, 'settings.local.json'),
      ]
      return { primary, legacy }
    }
    case 'projectSettings': {
      const primary = join(projectDir, '.kode', 'settings.json')
      const legacy = [legacyConfigPathInProject(projectDir, 'settings.json')]
      return { primary, legacy }
    }
    case 'userSettings': {
      const roots = resolveDataRoots({
        homeDir: options.homeDir,
        respectEnvOverride,
      })
      const primary = join(roots.kodeRoot, 'settings.json')
      const legacy = roots.claudeCompatRoots.map(root =>
        join(root, 'settings.json'),
      )
      return { primary, legacy }
    }
    default:
      return null
  }
}

// ENOENT also describes dangling symlinks. Only an absent entry beneath an
// accessible directory is an optional settings file, not a broken link.
function isMissingSettingsFile(filePath: string): boolean {
  let current = filePath
  for (;;) {
    let entry
    try {
      entry = lstatSync(current)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return false
      const parent = dirname(current)
      if (parent === current) return false
      current = parent
      continue
    }
    try {
      return (
        current !== filePath &&
        (entry.isDirectory() ||
          (entry.isSymbolicLink() && statSync(current).isDirectory()))
      )
    } catch {
      return false
    }
  }
}

function isSettingsObject(value: unknown): value is SettingsFile {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function readSettingsFile(filePath: string): SettingsFile | null {
  let raw: string
  try {
    raw = readFileSync(filePath, 'utf-8')
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' && isMissingSettingsFile(filePath)) return null
    const detail = code && /^E[A-Z0-9]+$/.test(code) ? ` (${code})` : ''
    throw new SettingsFileError(filePath, `unable to read file${detail}`)
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new SettingsFileError(filePath, 'invalid JSON')
  }
  if (!isSettingsObject(parsed)) {
    throw new SettingsFileError(filePath, 'expected a JSON object')
  }

  // Validate only the permission fields we consume; preserve other settings
  // and unknown keys for compatibility. Never silently discard policy rules.
  if ('permissions' in parsed) {
    const permissions = parsed.permissions
    if (!isSettingsObject(permissions)) {
      throw new SettingsFileError(filePath, 'permissions must be an object')
    }
    for (const key of ['allow', 'deny', 'ask', 'additionalDirectories']) {
      if (!(key in permissions)) continue
      const value = permissions[key]
      if (
        !Array.isArray(value) ||
        value.some(item => typeof item !== 'string')
      ) {
        throw new SettingsFileError(
          filePath,
          `permissions.${key} must be an array of strings`,
        )
      }
    }
  }
  return parsed
}

export function writeSettingsFile(
  filePath: string,
  settings: SettingsFile,
): void {
  mkdirSync(dirname(filePath), { recursive: true })
  const content = JSON.stringify(settings, null, 2) + '\n'
  writeFileAtomicThroughSymlink(filePath, content)
}

function resolveSymlinkTargetForWrite(filePath: string): string {
  try {
    const stat = lstatSync(filePath)
    if (!stat.isSymbolicLink()) return filePath
    const link = readlinkSync(filePath)
    return isAbsolute(link) ? link : resolve(dirname(filePath), link)
  } catch {
    return filePath
  }
}

function writeFileAtomicThroughSymlink(
  filePath: string,
  content: string,
  options?: { encoding?: BufferEncoding; mode?: number },
): void {
  const encoding = options?.encoding ?? 'utf-8'
  const targetPath = resolveSymlinkTargetForWrite(filePath)

  mkdirSync(dirname(targetPath), { recursive: true })

  const tmpPath = `${targetPath}.tmp.${process.pid}.${Date.now()}`
  let existingMode: number | undefined
  const targetExists = existsSync(targetPath)
  if (targetExists) {
    try {
      existingMode = statSync(targetPath).mode
    } catch {
      // ignore
    }
  } else if (options?.mode !== undefined) {
    existingMode = options.mode
  }

  try {
    writeFileSync(tmpPath, content, {
      encoding,
      ...(existingMode !== undefined && !targetExists
        ? { mode: existingMode }
        : {}),
    })

    if (targetExists && existingMode !== undefined) {
      try {
        chmodSync(tmpPath, existingMode)
      } catch {
        // ignore
      }
    }

    try {
      renameSync(tmpPath, targetPath)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | undefined)?.code
      if (
        code &&
        ['EEXIST', 'EPERM'].includes(code) &&
        existsSync(targetPath)
      ) {
        unlinkSync(targetPath)
        renameSync(tmpPath, targetPath)
      } else {
        throw error
      }
    }
  } catch (error) {
    try {
      if (existsSync(tmpPath)) unlinkSync(tmpPath)
    } catch {
      // ignore
    }
    writeFileSync(targetPath, content, {
      encoding,
      ...(options?.mode ? { mode: options.mode } : {}),
    })
  }
}

export function loadSettingsWithLegacyFallback(options: {
  destination: SettingsDestination
  projectDir?: string
  homeDir?: string
  migrateToPrimary?: boolean
}): { settings: SettingsFile | null; usedPath: string | null } {
  const candidates = getSettingsFileCandidates(options)
  if (!candidates) return { settings: null, usedPath: null }

  const primarySettings = readSettingsFile(candidates.primary)
  if (primarySettings)
    return { settings: primarySettings, usedPath: candidates.primary }

  for (const legacyPath of candidates.legacy) {
    const legacySettings = readSettingsFile(legacyPath)
    if (!legacySettings) continue

    if (options.migrateToPrimary && legacyPath !== candidates.primary) {
      try {
        if (!existsSync(candidates.primary)) {
          writeSettingsFile(candidates.primary, legacySettings)
        }
      } catch (error) {
        logError(error)
      }
    }

    return { settings: legacySettings, usedPath: legacyPath }
  }

  return { settings: null, usedPath: null }
}

export function saveSettingsToPrimaryAndSyncLegacy(options: {
  destination: SettingsDestination
  settings: SettingsFile
  projectDir?: string
  homeDir?: string
  syncLegacyIfExists?: boolean
}): void {
  const candidates = getSettingsFileCandidates(options)
  if (!candidates) return

  writeSettingsFile(candidates.primary, options.settings)
}
