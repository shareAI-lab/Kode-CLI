import yaml from 'js-yaml'
import { z } from 'zod'

import type { GlobalConfig, ModelPointers, ModelProfile } from './schema'

const ApiKeySpecSchema = z.union([
  z
    .object({
      fromEnv: z.string().min(1),
    })
    .strict(),
  z
    .object({
      value: z.string(),
    })
    .strict(),
])

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

function suggestedApiKeyEnvForProvider(provider: string): string | undefined {
  switch (provider) {
    case 'anthropic':
      return 'ANTHROPIC_API_KEY'
    case 'openai':
    case 'custom-openai':
      return 'OPENAI_API_KEY'
    case 'openrouter':
      return 'OPENROUTER_API_KEY'
    case 'requesty':
      return 'REQUESTY_API_KEY'
    case 'azure':
      return 'AZURE_OPENAI_API_KEY'
    case 'gemini':
      return 'GEMINI_API_KEY'
    default:
      return undefined
  }
}

function resolveApiKeyFromYaml(
  input: {
    apiKey?: ApiKeySpec
    apiKeyEnv?: string
  },
  existingApiKey: string | undefined,
): { apiKey: string; warnings: string[] } {
  const warnings: string[] = []

  if (input.apiKeyEnv) {
    const envValue = process.env[input.apiKeyEnv]
    if (envValue) return { apiKey: envValue, warnings }
    if (existingApiKey) return { apiKey: existingApiKey, warnings }
    warnings.push(`Missing env var '${input.apiKeyEnv}' for apiKey`)
    return { apiKey: '', warnings }
  }

  if (input.apiKey && 'fromEnv' in input.apiKey) {
    const envValue = process.env[input.apiKey.fromEnv]
    if (envValue) return { apiKey: envValue, warnings }
    if (existingApiKey) return { apiKey: existingApiKey, warnings }
    warnings.push(`Missing env var '${input.apiKey.fromEnv}' for apiKey`)
    return { apiKey: '', warnings }
  }

  if (input.apiKey && 'value' in input.apiKey) {
    return { apiKey: input.apiKey.value, warnings }
  }

  if (existingApiKey) return { apiKey: existingApiKey, warnings }

  warnings.push(
    'Missing apiKey (set apiKey.fromEnv, apiKeyEnv, or apiKey.value)',
  )
  return { apiKey: '', warnings }
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
  const parsed = yaml.load(yamlText)
  return ModelConfigYamlSchema.parse(parsed)
}

export function formatModelConfigYamlForSharing(config: GlobalConfig): string {
  const modelProfiles = config.modelProfiles ?? []
  const pointers = config.modelPointers

  const exported: ModelConfigYaml = {
    version: 1,
    profiles: modelProfiles.map(p => {
      const suggestedEnv = suggestedApiKeyEnvForProvider(p.provider)
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
        apiKey: { fromEnv: suggestedEnv ?? 'API_KEY' },
      }
    }),
    ...(pointers ? { pointers } : {}),
  }

  return yaml.dump(exported, {
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
    const resolved = resolveApiKeyFromYaml(
      { apiKey: profile.apiKey, apiKeyEnv: profile.apiKeyEnv },
      existing?.apiKey,
    )
    warnings.push(...resolved.warnings.map(w => `[${profile.modelName}] ${w}`))

    return {
      name: profile.name,
      provider: profile.provider,
      modelName: profile.modelName,
      ...(profile.baseURL ? { baseURL: profile.baseURL } : {}),
      apiKey: resolved.apiKey,
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
