import { dump, load } from 'js-yaml'
import { z } from 'zod'

import {
  getSuggestedApiKeyEnvVar,
  providerUsesApiKey,
} from './models/credentials'
import type { GlobalConfig, ModelPointers, ModelProfile } from './schema'

const ApiKeySpecSchema = z
  .object({
    fromEnv: z.string().min(1),
  })
  .strict()

type ApiKeySpec = z.infer<typeof ApiKeySpecSchema>

const ModelProfileYamlSchema = z
  .object({
    name: z.string().min(1),
    provider: z.string().min(1),
    modelName: z.string().min(1),
    baseURL: z.string().min(1).optional(),
    maxTokens: z.number().int().positive(),
    contextLength: z.number().int().positive(),
    reasoningEffort: z.string().optional(),
    requestStrategy: z
      .enum([
        'auto',
        'kode',
        'compat_headers',
        'compat_headers_system',
        'compat_full',
        'claude_code_headers',
        'claude_code_headers_system',
        'claude_code_full',
      ])
      .optional(),
    isActive: z.boolean().optional(),

    apiKey: ApiKeySpecSchema.optional(),
    apiKeyEnv: z.string().min(1).optional(),

    createdAt: z.number().int().positive().optional(),
    lastUsed: z.number().int().positive().optional(),
  })
  .strict()

const ModelPointersYamlSchema = z
  .object({
    main: z.string().min(1).optional(),
    task: z.string().min(1).optional(),
    compact: z.string().min(1).optional(),
    quick: z.string().min(1).optional(),
  })
  .strict()
  .optional()

const ModelConfigYamlSchema = z
  .object({
    version: z.number().int().positive().default(1),
    profiles: z.array(ModelProfileYamlSchema).default([]),
    pointers: ModelPointersYamlSchema,
  })
  .strict()

export type ModelConfigYaml = z.infer<typeof ModelConfigYamlSchema>

function resolveApiKeyEnvFromYaml(
  input: {
    apiKey?: ApiKeySpec
    apiKeyEnv?: string
  },
  provider: string,
): { apiKeyEnv?: string; warnings: string[] } {
  const warnings: string[] = []
  const apiKeyEnv =
    input.apiKeyEnv ??
    input.apiKey?.fromEnv ??
    getSuggestedApiKeyEnvVar(provider)

  if (providerUsesApiKey(provider) && !apiKeyEnv) {
    warnings.push('Missing apiKey environment-variable reference')
  }

  return { apiKeyEnv, warnings }
}

function resolvePointerTarget(
  pointerValue: string,
  profiles: ModelProfile[],
): string | null {
  if (profiles.some(p => p.modelName === pointerValue)) return pointerValue
  const byName = profiles.find(p => p.name === pointerValue)
  return byName?.modelName ?? null
}

export function parseModelConfigYaml(yamlText: string): ModelConfigYaml {
  const parsed = load(yamlText)
  return ModelConfigYamlSchema.parse(parsed)
}

export function formatModelConfigYamlForSharing(config: GlobalConfig): string {
  const modelProfiles = config.modelProfiles ?? []
  const pointers = config.modelPointers

  const exported: ModelConfigYaml = {
    version: 1,
    profiles: modelProfiles.map(p => {
      const apiKeyEnv = p.apiKeyEnv ?? getSuggestedApiKeyEnvVar(p.provider)
      return {
        name: p.name,
        provider: p.provider,
        modelName: p.modelName,
        ...(p.baseURL ? { baseURL: p.baseURL } : {}),
        maxTokens: p.maxTokens,
        contextLength: p.contextLength,
        ...(p.reasoningEffort ? { reasoningEffort: p.reasoningEffort } : {}),
        ...(p.requestStrategy ? { requestStrategy: p.requestStrategy } : {}),
        isActive: p.isActive,
        createdAt: p.createdAt,
        ...(typeof p.lastUsed === 'number' ? { lastUsed: p.lastUsed } : {}),
        ...(apiKeyEnv ? { apiKey: { fromEnv: apiKeyEnv } } : {}),
      }
    }),
    ...(pointers ? { pointers } : {}),
  }

  return dump(exported, {
    noRefs: true,
    lineWidth: 120,
  })
}

export function applyModelConfigYamlImport(
  existingConfig: GlobalConfig,
  yamlText: string,
  options: { replace?: boolean } = {},
): { nextConfig: GlobalConfig; warnings: string[] } {
  const parsed = parseModelConfigYaml(yamlText)
  const warnings: string[] = []

  const existingProfiles = existingConfig.modelProfiles ?? []
  const existingByModelName = new Map<string, ModelProfile>(
    existingProfiles.map(p => [p.modelName, p]),
  )

  const now = Date.now()
  const importedProfiles: ModelProfile[] = parsed.profiles.map(profile => {
    const existing = existingByModelName.get(profile.modelName)
    const resolved = resolveApiKeyEnvFromYaml(
      { apiKey: profile.apiKey, apiKeyEnv: profile.apiKeyEnv },
      profile.provider,
    )
    warnings.push(...resolved.warnings.map(w => `[${profile.modelName}] ${w}`))

    // Preserve any legacy field only when the user explicitly imports over an
    // existing profile. It is not read or used; runtime requests require the
    // environment-variable reference below.
    const preservedExisting = existing ? { ...existing } : { apiKey: '' }

    return {
      ...preservedExisting,
      name: profile.name,
      provider: profile.provider,
      modelName: profile.modelName,
      ...(profile.baseURL ? { baseURL: profile.baseURL } : {}),
      ...(resolved.apiKeyEnv ? { apiKeyEnv: resolved.apiKeyEnv } : {}),
      maxTokens: profile.maxTokens,
      contextLength: profile.contextLength,
      ...(profile.reasoningEffort
        ? { reasoningEffort: profile.reasoningEffort }
        : {}),
      ...(profile.requestStrategy
        ? { requestStrategy: profile.requestStrategy }
        : {}),
      isActive: profile.isActive ?? true,
      createdAt: profile.createdAt ?? existing?.createdAt ?? now,
      ...(profile.lastUsed
        ? { lastUsed: profile.lastUsed }
        : existing?.lastUsed
          ? { lastUsed: existing.lastUsed }
          : {}),
      ...(existing?.isGPT5 ? { isGPT5: existing.isGPT5 } : {}),
      ...(existing?.validationStatus
        ? { validationStatus: existing.validationStatus }
        : {}),
      ...(existing?.lastValidation
        ? { lastValidation: existing.lastValidation }
        : {}),
    }
  })

  const mergedProfiles = options.replace
    ? importedProfiles
    : [...existingProfiles, ...importedProfiles].reduce((acc, p) => {
        const i = acc.findIndex(x => x.modelName === p.modelName)
        if (i >= 0) acc[i] = p
        else acc.push(p)
        return acc
      }, [] as ModelProfile[])

  let nextPointers: ModelPointers | undefined = existingConfig.modelPointers
  if (parsed.pointers) {
    const mapped = {
      main: parsed.pointers.main,
      task: parsed.pointers.task,
      compact: parsed.pointers.compact,
      quick: parsed.pointers.quick,
    }
    nextPointers = {
      main:
        (mapped.main
          ? resolvePointerTarget(mapped.main, mergedProfiles)
          : null) ??
        existingConfig.modelPointers?.main ??
        '',
      task:
        (mapped.task
          ? resolvePointerTarget(mapped.task, mergedProfiles)
          : null) ??
        existingConfig.modelPointers?.task ??
        '',
      compact:
        (mapped.compact
          ? resolvePointerTarget(mapped.compact, mergedProfiles)
          : null) ??
        existingConfig.modelPointers?.compact ??
        '',
      quick:
        (mapped.quick
          ? resolvePointerTarget(mapped.quick, mergedProfiles)
          : null) ??
        existingConfig.modelPointers?.quick ??
        '',
    }
  }

  return {
    nextConfig: {
      ...existingConfig,
      modelProfiles: mergedProfiles,
      modelPointers: nextPointers,
    },
    warnings,
  }
}
