import { tmpdir } from 'os'
import path from 'path'
import { LEGACY_ENV } from '#config/compat/legacyEnv'
import { getKodeRoot as getKodeBaseDir } from '#config/dataRoots'
import { getOriginalCwd } from '#runtime/cwd'
import {
  getTaskOutputsStoreDir,
  getTaskOutputsUserFacingDir,
} from '#runtime/taskOutputStore'
import { resolveSandboxTmpDir } from '#runtime/shell/sandboxEnv'

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values))
}

function toPosixPath(value: string): string {
  return value.replace(/\\/g, '/')
}

function normalizePathForComparison(value: string): string {
  return path.normalize(value)
}

function getProjectKeyFromCwd(): string {
  return getOriginalCwd().replace(/[^a-zA-Z0-9]/g, '-')
}

function getLegacyTmpBaseDir(): string {
  const override = process.env[LEGACY_ENV.codeTmpDir]
  if (typeof override === 'string') {
    const trimmed = override.trim()
    if (trimmed) return trimmed
  }
  if (process.platform === 'win32') {
    return process.env.TEMP?.trim() || tmpdir()
  }
  return '/tmp'
}

function getLegacyClaudeTmpDir(): string {
  const override = process.env[LEGACY_ENV.tmpDir]
  if (typeof override === 'string') {
    const trimmed = override.trim().replace(/[\\/]+$/, '')
    if (trimmed) return trimmed
  }
  return path.join(getLegacyTmpBaseDir(), 'claude')
}

export function getBackgroundTaskOutputDirCandidates(): string[] {
  const projectKey = getProjectKeyFromCwd()
  return uniqueStrings([
    getTaskOutputsStoreDir(),
    path.join(getKodeBaseDir(), projectKey, 'tasks'),
    getTaskOutputsUserFacingDir(),
    path.join(resolveSandboxTmpDir(), projectKey, 'tasks'),
    path.join(getLegacyClaudeTmpDir(), projectKey, 'tasks'),
  ])
}

export function extractBackgroundTaskOutputIdFromPath(
  filePath: string,
): string | null {
  const posix = toPosixPath(normalizePathForComparison(filePath))

  for (const dir of getBackgroundTaskOutputDirCandidates()) {
    const dirPosix = toPosixPath(normalizePathForComparison(dir))
    const prefix = `${dirPosix}/`
    if (!posix.startsWith(prefix)) continue
    if (!posix.endsWith('.output')) continue

    const id = posix.slice(prefix.length, -'.output'.length)
    if (id.length === 0 || id.length > 20) continue
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) continue
    return id
  }

  return null
}
