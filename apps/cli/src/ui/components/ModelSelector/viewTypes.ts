import type { Theme } from '#core/utils/theme'
import type { ProviderType } from '#core/utils/config'
import type { ConnectionTestResult } from './flow/actions/connectionTest'
import type { ScreenExitState } from '#ui-ink/primitives/layout/ScreenFrame'
import type {
  ReasoningEffortOption,
  ContextLengthOption,
  RequestStrategyOption,
} from './flow/options'
import type { ModelSelectorScreen } from './flow/state'
import type { ModelInfo } from './flow/types'

export type Option = { value: string; label: string }

export type WindowedOptionInteractions = {
  onOptionPress?: (optionIndex: number) => void
  onWheel?: (direction: 'up' | 'down') => void
}

export type ModelParamsField = {
  name: string
  label: string
  description?: string
  component: 'select' | 'button'
  options?: Array<{ label: string; value: string }>
  defaultValue?: string
}

export type ModelSelectorViewProps = {
  theme: Theme
  exitState: ScreenExitState
  terminalRows: number
  terminalColumns: number
  compactLayout: boolean
  tightLayout: boolean
  containerPaddingY: number
  containerGap: number

  currentScreen: ModelSelectorScreen

  selectedProvider: ProviderType
  selectedModel: string

  apiKeyEnv?: string
  apiKey: string
  hasStoredApiKey: boolean
  cursorOffset: number
  handleApiKeyChange: (value: string) => void
  handleApiKeySubmit: (key: string) => void | Promise<void>
  handleCursorOffsetChange: (offset: number) => void

  isLoadingModels: boolean
  modelLoadError: string | null

  providerBaseUrl: string
  setProviderBaseUrl: (value: string) => void
  providerBaseUrlCursorOffset: number
  setProviderBaseUrlCursorOffset: (value: number) => void

  customBaseUrl: string
  setCustomBaseUrl: (value: string) => void
  customBaseUrlCursorOffset: number
  setCustomBaseUrlCursorOffset: (value: number) => void

  customModelName: string
  setCustomModelName: (value: string) => void
  customModelNameCursorOffset: number
  setCustomModelNameCursorOffset: (value: number) => void

  resourceName: string
  setResourceName: (value: string) => void
  resourceNameCursorOffset: number
  setResourceNameCursorOffset: (value: number) => void

  availableModels: ModelInfo[]
  modelSearchQuery: string
  modelSearchCursorOffset: number
  handleModelSearchChange: (value: string) => void
  handleModelSearchCursorOffsetChange: (offset: number) => void
  modelOptions: Array<{ label: string; value: string }>

  handleResourceNameSubmit: (name: string) => void
  handleCustomBaseUrlSubmit: (url: string) => void
  handleProviderBaseUrlSubmit: (url: string) => void
  handleCustomModelSubmit: (model: string) => void
  handleModelSelection: (model: string) => void
  handleModelParamsSubmit: () => void

  maxTokens: string
  setMaxTokens: (value: string) => void
  setSelectedMaxTokensPreset: (value: number) => void
  setMaxTokensCursorOffset: (value: number) => void

  supportsReasoningEffort: boolean
  reasoningEffortOptions: Array<{ label: string; value: ReasoningEffortOption }>
  reasoningEffort: ReasoningEffortOption | null
  setReasoningEffort: (value: ReasoningEffortOption | null) => void

  requestStrategy: RequestStrategyOption
  requestStrategyOptions: Array<{ label: string; value: RequestStrategyOption }>
  setRequestStrategy: (value: RequestStrategyOption) => void
  activateAsMain: boolean

  contextLength: number
  contextLengthOptions: ContextLengthOption[]

  isTestingConnection: boolean
  connectionTestResult: ConnectionTestResult | null

  validationError: string | null
  ollamaBaseUrl: string

  activeFieldIndex: number
  setActiveFieldIndex: (value: number | ((prev: number) => number)) => void
  getFormFieldsForModelParams: () => ModelParamsField[]

  mainMenuOptions: Option[]
  providerFocusIndex: number
  providerReservedLines: number
  onProviderOptionPress: (optionIndex: number) => void
  onProviderOptionWheel: (direction: 'up' | 'down') => void

  partnerProviderOptions: Option[]
  partnerProviderFocusIndex: number
  partnerReservedLines: number
  onPartnerProviderOptionPress: (optionIndex: number) => void
  onPartnerProviderOptionWheel: (direction: 'up' | 'down') => void

  codingPlanOptions: Option[]
  codingPlanFocusIndex: number
  codingReservedLines: number
  onCodingPlanOptionPress: (optionIndex: number) => void
  onCodingPlanOptionWheel: (direction: 'up' | 'down') => void

  getProviderLabel: (provider: string, modelCount: number) => string
}
