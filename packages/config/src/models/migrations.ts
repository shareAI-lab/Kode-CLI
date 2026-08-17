import type { GlobalConfig, ModelPointers, ModelProfile } from '../schema'
import { debug as debugLogger } from '../debugLogger'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readString(
  record: Record<string, unknown> | null,
  key: string,
): string {
  if (!record) return ''
  const value = record[key]
  return typeof value === 'string' ? value : ''
}

function trimConfigString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function isPositiveFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

/**
 * Model identifiers are sent to providers verbatim. Normalize the persisted
 * configuration boundary so accidental whitespace neither changes the model
 * identity nor causes a remote request to fail.
 */
function normalizeModelProfile(profile: Record<string, unknown>): ModelProfile {
  const modelName = trimConfigString(profile['modelName'])
  const name = trimConfigString(profile['name'])
  const provider = trimConfigString(profile['provider'])
  const baseURL = trimConfigString(profile['baseURL']) || undefined
  const apiKeyEnv = trimConfigString(profile['apiKeyEnv']) || undefined
  const hasRuntimeIdentity = Boolean(modelName && name && provider)
  const hasRuntimeLimits =
    isPositiveFiniteNumber(profile['maxTokens']) &&
    isPositiveFiniteNumber(profile['contextLength'])
  const isActive =
    profile['isActive'] === true && hasRuntimeIdentity && hasRuntimeLimits

  if (profile['isActive'] === true && !isActive) {
    // Failing closed here is intentional, but silent deactivation hides why the
    // user's main model was swapped; surface the reason for diagnosis.
    debugLogger.warn('MODEL_PROFILE_DEACTIVATED', {
      name: name || undefined,
      modelName: modelName || undefined,
      missingIdentity: !hasRuntimeIdentity,
      missingLimits: !hasRuntimeLimits,
    })
  }

  const {
    id: _id,
    baseURL: _baseURL,
    apiKeyEnv: _apiKeyEnv,
    isActive: _isActive,
    ...rest
  } = profile

  return {
    ...rest,
    modelName,
    name,
    provider,
    isActive,
    ...(baseURL ? { baseURL } : {}),
    ...(apiKeyEnv ? { apiKeyEnv } : {}),
  } as unknown as ModelProfile
}

export function migrateModelProfilesRemoveId(
  config: GlobalConfig,
): GlobalConfig {
  const profilesRaw: unknown = config.modelProfiles
  if (profilesRaw === undefined) return config
  if (!Array.isArray(profilesRaw)) {
    debugLogger.warn('MODEL_PROFILES_CLEARED', {
      reason: 'modelProfiles is not an array',
    })
    return { ...config, modelProfiles: [] }
  }
  if (profilesRaw.length === 0) return config

  const idToModelNameMap = new Map<string, string>()
  const migratedProfiles: ModelProfile[] = profilesRaw.flatMap(profile => {
    const raw: unknown = profile
    if (!isRecord(raw)) return []

    const normalizedProfile = normalizeModelProfile(raw)

    const maybeId = raw['id']
    if (typeof maybeId === 'string' && normalizedProfile.modelName) {
      idToModelNameMap.set(maybeId, normalizedProfile.modelName)
    }

    return [normalizedProfile]
  })

  const migratedPointers: ModelPointers = {
    main: '',
    task: '',
    compact: '',
    quick: '',
  }

  const pointersRaw: unknown = config.modelPointers
  const pointers = isRecord(pointersRaw) ? pointersRaw : null
  if (pointersRaw !== undefined && pointers === null) {
    debugLogger.warn('MODEL_POINTERS_CLEARED', {
      reason: 'modelPointers is not a record',
    })
  }

  const rawMain = trimConfigString(readString(pointers, 'main'))
  const rawTask = trimConfigString(readString(pointers, 'task'))
  const rawQuick = trimConfigString(readString(pointers, 'quick'))
  const rawCompact =
    trimConfigString(readString(pointers, 'compact')) ||
    trimConfigString(readString(pointers, 'reasoning'))

  if (rawMain) migratedPointers.main = idToModelNameMap.get(rawMain) ?? rawMain
  if (rawTask) migratedPointers.task = idToModelNameMap.get(rawTask) ?? rawTask
  if (rawCompact)
    migratedPointers.compact = idToModelNameMap.get(rawCompact) ?? rawCompact
  if (rawQuick)
    migratedPointers.quick = idToModelNameMap.get(rawQuick) ?? rawQuick

  const configRaw: unknown = config
  const configRecord = isRecord(configRaw) ? configRaw : null

  const legacyDefaultModelId = trimConfigString(
    readString(configRecord, 'defaultModelId'),
  )
  const legacyDefaultModelName = trimConfigString(
    readString(configRecord, 'defaultModelName'),
  )

  let defaultModelName: string | undefined = config.defaultModelName
    ? trimConfigString(config.defaultModelName)
    : undefined
  if (legacyDefaultModelId) {
    defaultModelName =
      idToModelNameMap.get(legacyDefaultModelId) ?? legacyDefaultModelId
  } else if (legacyDefaultModelName) {
    defaultModelName = legacyDefaultModelName
  }

  if (!configRecord) {
    return {
      ...config,
      modelProfiles: migratedProfiles,
      modelPointers: migratedPointers,
      defaultModelName,
    }
  }

  const migratedConfig: Record<string, unknown> = { ...configRecord }
  delete migratedConfig['defaultModelId']
  delete migratedConfig['currentSelectedModelId']
  delete migratedConfig['mainAgentModelId']
  delete migratedConfig['taskToolModelId']

  return {
    ...(migratedConfig as unknown as GlobalConfig),
    modelProfiles: migratedProfiles,
    modelPointers: migratedPointers,
    defaultModelName,
  }
}
