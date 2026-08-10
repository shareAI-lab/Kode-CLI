import {
  getModelCredentialStatus,
  type ModelPointerType,
  type ModelProfile,
  type ModelPointers,
} from '#config'

import type { ModelParam, ResolvedModelInfo } from './types'

type ModelResolutionConfig = {
  modelPointers?: Partial<ModelPointers>
  defaultModelName?: string
  defaultModelId?: string
}

const POINTERS: ModelPointerType[] = ['main', 'task', 'compact', 'quick']

function getDefaultModelProfile(
  config: ModelResolutionConfig,
  modelProfiles: ModelProfile[],
): ModelProfile | null {
  if (config.defaultModelId) {
    const profile =
      modelProfiles.find(p => p.modelName === config.defaultModelId) || null
    if (profile && profile.isActive) return profile
  }
  return modelProfiles.find(p => p.isActive) || null
}

function resolveProviderQualifiedModel(
  modelProfiles: ModelProfile[],
  input: string,
): ModelProfile | null {
  const trimmed = input.trim()
  const colonIndex = trimmed.indexOf(':')
  if (colonIndex <= 0 || colonIndex >= trimmed.length - 1) return null

  const provider = trimmed.slice(0, colonIndex).trim().toLowerCase()
  const modelOrName = trimmed.slice(colonIndex + 1).trim()
  if (!provider || !modelOrName) return null

  const providerProfiles = modelProfiles.filter(
    p => String(p.provider).trim().toLowerCase() === provider,
  )
  if (providerProfiles.length === 0) return null

  const byModelName = providerProfiles.find(p => p.modelName === modelOrName)
  if (byModelName) return byModelName

  const byName = providerProfiles.find(p => p.name === modelOrName)
  if (byName) return byName

  return null
}

function findByModelName(
  modelProfiles: ModelProfile[],
  modelName: string,
): ModelProfile | null {
  return modelProfiles.find(p => p.modelName === modelName) || null
}

function findByName(
  modelProfiles: ModelProfile[],
  name: string,
): ModelProfile | null {
  return modelProfiles.find(p => p.name === name) || null
}

function resolveRuntimeProfile(profile: ModelProfile): ModelProfile | null {
  const credential = getModelCredentialStatus(profile)
  if (!credential.success) return null
  return { ...profile, apiKey: credential.apiKey }
}

function resolveRuntimeProfileWithInfo(
  profile: ModelProfile,
): ResolvedModelInfo {
  const credential = getModelCredentialStatus(profile)
  if (!credential.success) {
    return { success: false, profile: null, error: credential.error }
  }
  return {
    success: true,
    profile: { ...profile, apiKey: credential.apiKey },
  }
}

export function resolveModel(
  config: ModelResolutionConfig,
  modelProfiles: ModelProfile[],
  modelParam: ModelParam,
): ModelProfile | null {
  if (
    typeof modelParam === 'string' &&
    POINTERS.includes(modelParam as ModelPointerType)
  ) {
    const pointerId = config.modelPointers?.[modelParam as ModelPointerType]
    if (pointerId) {
      const profile = findByModelName(modelProfiles, pointerId)
      if (profile && profile.isActive) return resolveRuntimeProfile(profile)
    }
    const defaultProfile = getDefaultModelProfile(config, modelProfiles)
    return defaultProfile ? resolveRuntimeProfile(defaultProfile) : null
  }

  const raw = String(modelParam)

  let profile = findByModelName(modelProfiles, raw)
  if (profile && profile.isActive) return resolveRuntimeProfile(profile)

  profile = findByName(modelProfiles, raw)
  if (profile && profile.isActive) return resolveRuntimeProfile(profile)

  const qualified = resolveProviderQualifiedModel(modelProfiles, raw)
  if (qualified && qualified.isActive) return resolveRuntimeProfile(qualified)

  const defaultProfile = getDefaultModelProfile(config, modelProfiles)
  return defaultProfile ? resolveRuntimeProfile(defaultProfile) : null
}

export function resolveModelWithInfo(
  config: ModelResolutionConfig,
  modelProfiles: ModelProfile[],
  modelParam: ModelParam,
): ResolvedModelInfo {
  const isPointer =
    typeof modelParam === 'string' &&
    POINTERS.includes(modelParam as ModelPointerType)

  if (isPointer) {
    const pointerId = config.modelPointers?.[modelParam as ModelPointerType]
    if (!pointerId) {
      return {
        success: false,
        profile: null,
        error: `Model pointer '${modelParam}' is not configured. Use /model to set up models.`,
      }
    }

    const profile = findByModelName(modelProfiles, pointerId)
    if (!profile) {
      return {
        success: false,
        profile: null,
        error: `Model pointer '${modelParam}' points to invalid model '${pointerId}'. Use /model to reconfigure.`,
      }
    }

    if (!profile.isActive) {
      return {
        success: false,
        profile: null,
        error: `Model '${profile.name}' (pointed by '${modelParam}') is inactive. Use /model to activate it.`,
      }
    }

    return resolveRuntimeProfileWithInfo(profile)
  }

  const raw = String(modelParam)
  let profile = findByModelName(modelProfiles, raw)
  if (!profile) profile = findByName(modelProfiles, raw)
  if (!profile && typeof modelParam === 'string') {
    profile = resolveProviderQualifiedModel(modelProfiles, modelParam)
  }

  if (!profile) {
    return {
      success: false,
      profile: null,
      error: `Model '${raw}' not found. Use /model to add models, or run 'kode models list' to see configured profiles.`,
    }
  }

  if (!profile.isActive) {
    return {
      success: false,
      profile: null,
      error: `Model '${profile.name}' is inactive. Use /model to activate it.`,
    }
  }

  return resolveRuntimeProfileWithInfo(profile)
}
