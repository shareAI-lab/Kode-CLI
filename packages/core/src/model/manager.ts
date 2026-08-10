import {
  getModelCredentialStatus,
  redactModelProfileCredential,
  saveGlobalConfig,
  type GlobalConfig,
  type ModelPointerType,
  type ModelProfile,
  type ModelPointers,
} from '#config'

import { getModelConfig } from './defaults'
import { isBedrockRuntimeEnabled, isVertexRuntimeEnabled } from './flags'
import {
  analyzeContextCompatibility,
  canModelHandleContext,
  findModelWithSufficientContext,
} from './capabilities'
import { resolveModel, resolveModelWithInfo } from './resolution'
import {
  chooseNextModelWithContextCheck,
  formatSwitchResult,
} from './switching'
import type {
  ModelParam,
  SwitchResult,
  SwitchWithAnalysisResult,
  SwitchWithContextCheckResult,
} from './types'

const POINTERS: ModelPointerType[] = ['main', 'task', 'compact', 'quick']

const DEFAULT_MODEL_POINTERS: ModelPointers = {
  main: '',
  task: '',
  compact: '',
  quick: '',
}

export class ModelManager {
  private config: GlobalConfig & { defaultModelId?: string }
  private modelProfiles: ModelProfile[]

  constructor(config: GlobalConfig & { defaultModelId?: string }) {
    this.config = config
    this.modelProfiles = config.modelProfiles || []
  }

  getCurrentModel(): string | null {
    return this.getModel('main')?.modelName ?? null
  }

  getMainAgentModel(): string | null {
    return this.getModel('main')?.modelName ?? null
  }

  getTaskToolModel(): string | null {
    return this.getModel('task')?.modelName ?? null
  }

  switchToNextModelWithContextCheck(
    currentContextTokens: number = 0,
  ): SwitchWithContextCheckResult {
    const { selected, result } = chooseNextModelWithContextCheck({
      modelProfiles: this.getRuntimeReadyModelProfiles(),
      currentMainModelName: this.config.modelPointers?.main,
      currentContextTokens,
    })

    if (!selected) return result

    if (!selected.isActive) selected.isActive = true
    this.setPointer('main', selected.modelName)
    this.updateLastUsed(selected.modelName)

    return result
  }

  switchToNextModel(currentContextTokens: number = 0): SwitchResult {
    const detailed =
      this.switchToNextModelWithContextCheck(currentContextTokens)
    return formatSwitchResult({
      detailed,
      modelProfiles: this.getRuntimeReadyModelProfiles(),
      currentMainModelName: this.config.modelPointers?.main,
    })
  }

  analyzeContextCompatibility = analyzeContextCompatibility

  switchToNextModelWithAnalysis(
    currentContextTokens: number = 0,
  ): SwitchWithAnalysisResult {
    const result = this.switchToNextModel(currentContextTokens)

    if (!result.success || !result.modelName) {
      return {
        modelName: null,
        contextAnalysis: null,
        requiresCompression: false,
        estimatedTokensAfterSwitch: 0,
      }
    }

    const newModel = this.getModel('main')
    if (!newModel) {
      return {
        modelName: result.modelName,
        contextAnalysis: null,
        requiresCompression: false,
        estimatedTokensAfterSwitch: currentContextTokens,
      }
    }

    const analysis = analyzeContextCompatibility(newModel, currentContextTokens)
    return {
      modelName: result.modelName,
      contextAnalysis: analysis,
      requiresCompression: analysis.severity === 'critical',
      estimatedTokensAfterSwitch: currentContextTokens,
    }
  }

  canModelHandleContext(model: ModelProfile, contextTokens: number): boolean {
    return canModelHandleContext(model, contextTokens)
  }

  findModelWithSufficientContext(
    models: ModelProfile[],
    contextTokens: number,
  ): ModelProfile | null {
    return findModelWithSufficientContext(models, contextTokens)
  }

  getModelForContext(
    contextType: 'terminal' | 'main-agent' | 'task-tool',
  ): string | null {
    switch (contextType) {
      case 'terminal':
        return this.getCurrentModel()
      case 'main-agent':
        return this.getMainAgentModel()
      case 'task-tool':
        return this.getTaskToolModel()
      default:
        return this.getMainAgentModel()
    }
  }

  getActiveModelProfiles(): ModelProfile[] {
    return this.modelProfiles
      .filter(p => p.isActive)
      .map(redactModelProfileCredential)
  }

  hasConfiguredModels(): boolean {
    return this.modelProfiles.some(
      profile => profile.isActive && getModelCredentialStatus(profile).success,
    )
  }

  getModel(pointer: ModelPointerType): ModelProfile | null {
    return resolveModel(this.config, this.modelProfiles, pointer)
  }

  getModelName(pointer: ModelPointerType): string | null {
    const profile = this.getModel(pointer)
    return profile ? profile.modelName : null
  }

  getCompactModel(): string | null {
    return this.getModelName('compact') || this.getModelName('main')
  }

  getQuickModel(): string | null {
    return (
      this.getModelName('quick') ||
      this.getModelName('task') ||
      this.getModelName('main')
    )
  }

  async addModel(
    config: Omit<ModelProfile, 'createdAt' | 'isActive'>,
  ): Promise<string> {
    const existingByModelName = this.modelProfiles.find(
      p => p.modelName === config.modelName,
    )
    if (existingByModelName) {
      throw new Error(
        `Model with modelName '${config.modelName}' already exists: ${existingByModelName.name}`,
      )
    }

    const existingByName = this.modelProfiles.find(p => p.name === config.name)
    if (existingByName) {
      throw new Error(`Model with name '${config.name}' already exists`)
    }

    const newModel: ModelProfile = {
      ...config,
      apiKey: '',
      createdAt: Date.now(),
      isActive: true,
    }

    this.modelProfiles.push(newModel)

    if (this.modelProfiles.length === 1) {
      this.config.modelPointers = {
        main: config.modelName,
        task: config.modelName,
        compact: config.modelName,
        quick: config.modelName,
      }
      this.config.defaultModelName = config.modelName
    } else {
      if (!this.config.modelPointers) {
        this.config.modelPointers = {
          ...DEFAULT_MODEL_POINTERS,
          main: config.modelName,
        }
      } else {
        this.config.modelPointers.main = config.modelName
      }
    }

    this.saveConfig()
    return config.modelName
  }

  async upsertModel(
    config: Omit<ModelProfile, 'createdAt' | 'isActive'>,
  ): Promise<string> {
    const existingIndex = this.modelProfiles.findIndex(
      p => p.modelName === config.modelName,
    )

    if (existingIndex === -1) {
      return this.addModel(config)
    }

    const existingByName = this.modelProfiles.find(
      p => p.name === config.name && p.modelName !== config.modelName,
    )
    if (existingByName) {
      throw new Error(`Model with name '${config.name}' already exists`)
    }

    const existing = this.modelProfiles[existingIndex]!
    const updatedModel: ModelProfile = {
      ...existing,
      ...config,
      // Keep legacy storage untouched, but never accept or persist a newly
      // supplied plaintext key. Runtime resolution only uses apiKeyEnv.
      apiKey: existing.apiKey,
      reasoningEffort: config.reasoningEffort ?? existing.reasoningEffort,
      createdAt: existing.createdAt,
      lastUsed: existing.lastUsed,
      isActive: true,
      isGPT5: existing.isGPT5,
      validationStatus: existing.validationStatus,
      lastValidation: existing.lastValidation,
    }

    this.modelProfiles[existingIndex] = updatedModel
    this.saveConfig()
    return config.modelName
  }

  setPointer(pointer: ModelPointerType, modelName: string): void {
    if (!this.findByModelName(modelName)) {
      throw new Error(`Model '${modelName}' not found`)
    }

    if (!this.config.modelPointers) {
      this.config.modelPointers = { ...DEFAULT_MODEL_POINTERS }
    }

    this.config.modelPointers[pointer] = modelName
    this.saveConfig()
  }

  getAvailableModels(): ModelProfile[] {
    return this.getActiveModelProfiles()
  }

  getAllConfiguredModels(): ModelProfile[] {
    return this.modelProfiles.map(redactModelProfileCredential)
  }

  getAllAvailableModelNames(): string[] {
    return this.getAvailableModels().map(p => p.modelName)
  }

  getAllConfiguredModelNames(): string[] {
    return this.getAllConfiguredModels().map(p => p.modelName)
  }

  getModelSwitchingDebugInfo(): {
    totalModels: number
    activeModels: number
    inactiveModels: number
    currentMainModel: string | null
    availableModels: Array<{
      name: string
      modelName: string
      provider: string
      isActive: boolean
      lastUsed?: number
    }>
    modelPointers: Record<string, string | undefined>
  } {
    const availableModels = this.getAvailableModels()
    const currentMainModelName = this.config.modelPointers?.main

    return {
      totalModels: this.modelProfiles.length,
      activeModels: availableModels.length,
      inactiveModels: this.modelProfiles.length - availableModels.length,
      currentMainModel: currentMainModelName || null,
      availableModels: this.modelProfiles.map(p => ({
        name: p.name,
        modelName: p.modelName,
        provider: p.provider,
        isActive: p.isActive,
        lastUsed: p.lastUsed,
      })),
      modelPointers: this.config.modelPointers || {},
    }
  }

  removeModel(modelName: string): void {
    this.modelProfiles = this.modelProfiles.filter(
      p => p.modelName !== modelName,
    )

    if (!this.config.modelPointers) {
      this.config.modelPointers = { ...DEFAULT_MODEL_POINTERS }
    }

    const fallbackModelName =
      this.modelProfiles.find(p => p.isActive)?.modelName || ''

    for (const pointer of POINTERS) {
      const currentModelName = this.config.modelPointers[pointer]
      const pointsToDeletedModel = currentModelName === modelName
      const pointsToMissingModel =
        currentModelName && !this.findByModelName(currentModelName)

      if (!fallbackModelName) {
        this.config.modelPointers[pointer] = ''
      } else if (pointsToDeletedModel || pointsToMissingModel) {
        this.config.modelPointers[pointer] = fallbackModelName
      }
    }

    this.config.defaultModelName = fallbackModelName
    this.saveConfig()
  }

  private getRuntimeReadyModelProfiles(): ModelProfile[] {
    return this.modelProfiles
      .filter(
        profile =>
          profile.isActive && getModelCredentialStatus(profile).success,
      )
      .map(redactModelProfileCredential)
  }

  private saveConfig(): void {
    this.config.modelProfiles = this.modelProfiles
    const updatedConfig = {
      ...this.config,
      modelProfiles: this.modelProfiles,
    }
    saveGlobalConfig(updatedConfig)
  }

  async getFallbackModel(): Promise<string> {
    const modelConfig = await getModelConfig()
    if (isBedrockRuntimeEnabled()) return modelConfig.bedrock
    if (isVertexRuntimeEnabled()) return modelConfig.vertex
    return modelConfig.firstParty
  }

  resolveModel(modelParam: ModelParam): ModelProfile | null {
    return resolveModel(this.config, this.modelProfiles, modelParam)
  }

  resolveModelWithInfo(modelParam: ModelParam) {
    return resolveModelWithInfo(this.config, this.modelProfiles, modelParam)
  }

  private findByModelName(modelName: string): ModelProfile | null {
    return this.modelProfiles.find(p => p.modelName === modelName) || null
  }

  private updateLastUsed(modelName: string): void {
    const profile = this.findByModelName(modelName)
    if (profile) profile.lastUsed = Date.now()
  }
}
