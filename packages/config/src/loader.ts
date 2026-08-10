import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { cloneDeep } from 'lodash-es'

import { getGlobalConfigFilePath } from './paths'
import { ConfigParseError } from './errors'
import { safeParseJSON } from './json'
import { debug as debugLogger } from './debugLogger'
import { getCwd } from './cwd'

import type { GlobalConfig, ProjectConfig } from './schema'
import { DEFAULT_GLOBAL_CONFIG, defaultConfigForProject } from './schema'
import { migrateModelProfilesRemoveId } from './models/migrations'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(v => typeof v === 'string')
}

function normalizeStringArray(value: unknown): string[] | undefined {
  if (isStringArray(value)) return value
  if (typeof value === 'string') {
    const parsed = safeParseJSON(value)
    if (isStringArray(parsed)) return parsed
  }
  return undefined
}

function normalizeLegacyProjectConfig(
  projectConfig: ProjectConfig,
): ProjectConfig {
  const raw: unknown = projectConfig
  if (!isRecord(raw)) return projectConfig

  const allowedTools =
    normalizeStringArray(raw['allowedTools']) ?? projectConfig.allowedTools
  const deniedTools =
    normalizeStringArray(raw['deniedTools']) ?? projectConfig.deniedTools
  const askedTools =
    normalizeStringArray(raw['askedTools']) ?? projectConfig.askedTools

  return { ...projectConfig, allowedTools, deniedTools, askedTools }
}

function saveConfig<A extends object>(
  file: string,
  config: A,
  defaultConfig: A,
): void {
  const filteredConfig = Object.fromEntries(
    Object.entries(config).filter(
      ([key, value]) =>
        JSON.stringify(value) !== JSON.stringify(defaultConfig[key as keyof A]),
    ),
  )

  try {
    writeFileSync(file, JSON.stringify(filteredConfig, null, 2), 'utf-8')
  } catch (error) {
    const err = error as NodeJS.ErrnoException
    if (err.code === 'EACCES' || err.code === 'EPERM' || err.code === 'EROFS') {
      debugLogger.state('CONFIG_SAVE_SKIPPED', {
        file,
        reason: String(err.code),
      })
      return
    }
    throw error
  }
}

function getConfig<A>(
  file: string,
  defaultConfig: A,
  throwOnInvalid?: boolean,
): A {
  debugLogger.state('CONFIG_LOAD_START', {
    file,
    fileExists: String(existsSync(file)),
    throwOnInvalid: String(Boolean(throwOnInvalid)),
  })

  if (!existsSync(file)) {
    debugLogger.state('CONFIG_LOAD_DEFAULT', {
      file,
      reason: 'file_not_exists',
      defaultConfigKeys: Object.keys(defaultConfig as object).join(', '),
    })
    return cloneDeep(defaultConfig)
  }

  try {
    const fileContent = readFileSync(file, 'utf-8')
    debugLogger.state('CONFIG_FILE_READ', {
      file,
      contentLength: String(fileContent.length),
    })

    try {
      const parsedConfig = JSON.parse(fileContent) as unknown
      debugLogger.state('CONFIG_JSON_PARSED', {
        file,
        parsedKeys: isRecord(parsedConfig)
          ? Object.keys(parsedConfig).join(', ')
          : '',
      })

      const finalConfig = {
        ...cloneDeep(defaultConfig),
        ...(isRecord(parsedConfig) ? parsedConfig : {}),
      }

      debugLogger.state('CONFIG_LOAD_SUCCESS', {
        file,
        finalConfigKeys: Object.keys(finalConfig as object).join(', '),
      })

      return finalConfig as A
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      debugLogger.error('CONFIG_JSON_PARSE_ERROR', {
        file,
        errorMessage: message,
        errorType:
          error instanceof Error ? error.constructor.name : typeof error,
        contentLength: String(fileContent.length),
      })
      throw new ConfigParseError(message, file, defaultConfig)
    }
  } catch (error: unknown) {
    if (error instanceof ConfigParseError && throwOnInvalid) {
      debugLogger.error('CONFIG_PARSE_ERROR_RETHROWN', {
        file,
        throwOnInvalid: String(Boolean(throwOnInvalid)),
        errorMessage: error.message,
      })
      throw error
    }

    debugLogger.warn('CONFIG_FALLBACK_TO_DEFAULT', {
      file,
      errorType: error instanceof Error ? error.constructor.name : typeof error,
      errorMessage: error instanceof Error ? error.message : String(error),
      action: 'using_default_config',
    })

    return cloneDeep(defaultConfig)
  }
}

const TEST_GLOBAL_CONFIG_FOR_TESTING: GlobalConfig = {
  ...DEFAULT_GLOBAL_CONFIG,
  autoUpdaterStatus: 'disabled',
}
const TEST_PROJECT_CONFIG_FOR_TESTING: ProjectConfig = {
  ...defaultConfigForProject(getCwd()),
}

let CACHED_GLOBAL_CONFIG: GlobalConfig | null = null

export function enableConfigs(): void {
  CACHED_GLOBAL_CONFIG = migrateModelProfilesRemoveId(
    getConfig(getGlobalConfigFilePath(), DEFAULT_GLOBAL_CONFIG, true),
  )
}

export function clearConfigCacheForTesting(): void {
  CACHED_GLOBAL_CONFIG = null
}

export function saveGlobalConfig(config: GlobalConfig): void {
  if (process.env.NODE_ENV === 'test') {
    Object.assign(TEST_GLOBAL_CONFIG_FOR_TESTING, config)
    CACHED_GLOBAL_CONFIG = TEST_GLOBAL_CONFIG_FOR_TESTING
    return
  }

  const existingProjects =
    CACHED_GLOBAL_CONFIG?.projects ??
    getConfig(getGlobalConfigFilePath(), DEFAULT_GLOBAL_CONFIG).projects

  const nextConfig = {
    ...config,
    projects: existingProjects,
  }

  saveConfig(getGlobalConfigFilePath(), nextConfig, DEFAULT_GLOBAL_CONFIG)

  CACHED_GLOBAL_CONFIG = migrateModelProfilesRemoveId(nextConfig)
}

export function getGlobalConfig(): GlobalConfig {
  if (process.env.NODE_ENV === 'test') return TEST_GLOBAL_CONFIG_FOR_TESTING
  if (CACHED_GLOBAL_CONFIG) return CACHED_GLOBAL_CONFIG
  const config = getConfig(getGlobalConfigFilePath(), DEFAULT_GLOBAL_CONFIG)
  return migrateModelProfilesRemoveId(config)
}

export function getGlobalConfigCached(): GlobalConfig {
  if (process.env.NODE_ENV === 'test') return TEST_GLOBAL_CONFIG_FOR_TESTING
  if (!CACHED_GLOBAL_CONFIG) {
    CACHED_GLOBAL_CONFIG = getGlobalConfig()
  }
  return CACHED_GLOBAL_CONFIG
}

export function checkHasTrustDialogAccepted(): boolean {
  let currentPath = getCwd()
  const config = getConfig(getGlobalConfigFilePath(), DEFAULT_GLOBAL_CONFIG)

  while (true) {
    const projectConfig = config.projects?.[currentPath]
    if (projectConfig?.hasTrustDialogAccepted) return true

    const parentPath = resolve(currentPath, '..')
    if (parentPath === currentPath) break
    currentPath = parentPath
  }

  return false
}

export function getCurrentProjectConfig(): ProjectConfig {
  if (process.env.NODE_ENV === 'test') return TEST_PROJECT_CONFIG_FOR_TESTING

  const absolutePath = resolve(getCwd())
  const config = getConfig(getGlobalConfigFilePath(), DEFAULT_GLOBAL_CONFIG)
  if (!config.projects) return defaultConfigForProject(absolutePath)

  const projectConfig =
    config.projects[absolutePath] ?? defaultConfigForProject(absolutePath)
  return normalizeLegacyProjectConfig(projectConfig)
}

export function saveCurrentProjectConfig(projectConfig: ProjectConfig): void {
  if (process.env.NODE_ENV === 'test') {
    Object.assign(TEST_PROJECT_CONFIG_FOR_TESTING, projectConfig)
    return
  }

  const projectPath = resolve(getCwd())
  const config = getConfig(getGlobalConfigFilePath(), DEFAULT_GLOBAL_CONFIG)
  const nextConfig = {
    ...config,
    projects: {
      ...config.projects,
      [projectPath]: projectConfig,
    },
  }
  saveConfig(getGlobalConfigFilePath(), nextConfig, DEFAULT_GLOBAL_CONFIG)

  // Keep the cached global config in sync for UI reads.
  CACHED_GLOBAL_CONFIG = migrateModelProfilesRemoveId(nextConfig)
}

export async function isAutoUpdaterDisabled(): Promise<boolean> {
  const status = getGlobalConfig().autoUpdaterStatus
  return status !== 'enabled'
}

export function getOrCreateUserID(): string {
  const config = getGlobalConfig()
  if (config.userID) return config.userID

  const userID = randomBytes(32).toString('hex')
  saveGlobalConfig({ ...config, userID })
  return userID
}

export function normalizeApiKeyForConfig(apiKey: string): string {
  return apiKey.slice(-20)
}

export function getCustomApiKeyStatus(
  truncatedApiKey: string,
): 'approved' | 'rejected' | 'new' {
  const config = getGlobalConfig()
  if (config.customApiKeyResponses?.approved?.includes(truncatedApiKey)) {
    return 'approved'
  }
  if (config.customApiKeyResponses?.rejected?.includes(truncatedApiKey)) {
    return 'rejected'
  }
  return 'new'
}
