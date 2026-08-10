import { useKeypress } from '#ui-ink/hooks/useKeypress'
import {
  DEFAULT_CONTEXT_LENGTH,
  type ContextLengthOption,
} from './flow/options'
import type { ModelSelectorScreen } from './flow/state'
import type { ConnectionTestResult } from './flow/actions/connectionTest'
import type { ProviderType } from '#core/utils/config'
import { logError } from '#core/utils/log'

type Option = { value: string; label: string }

export function useModelSelectorInput(args: {
  currentScreen: ModelSelectorScreen
  mainMenuOptions: Option[]
  providerFocusIndex: number
  setProviderFocusIndex: (value: number | ((prev: number) => number)) => void
  partnerProviderOptions: Option[]
  partnerProviderFocusIndex: number
  setPartnerProviderFocusIndex: (
    value: number | ((prev: number) => number),
  ) => void
  codingPlanOptions: Option[]
  codingPlanFocusIndex: number
  setCodingPlanFocusIndex: (value: number | ((prev: number) => number)) => void

  selectedProvider: ProviderType
  /** Legacy plumbing for callers; this hook never reads credential values. */
  apiKey?: string
  resourceName: string
  providerBaseUrl: string
  customBaseUrl: string
  customModelName: string

  contextLength: number
  contextLengthOptions: ContextLengthOption[]
  setContextLength: (value: number) => void

  isTestingConnection: boolean
  connectionTestResult: ConnectionTestResult | null

  activeFieldIndex: number
  setActiveFieldIndex: (value: number | ((prev: number) => number)) => void

  handleProviderSelection: (provider: string) => void | Promise<void>
  handleApiKeySubmit: (key: string) => void | Promise<void>
  fetchModelsWithRetry: () => Promise<unknown>
  navigateTo: (screen: ModelSelectorScreen) => void
  handleResourceNameSubmit: (name: string) => void
  handleCustomBaseUrlSubmit: (url: string) => void
  handleProviderBaseUrlSubmit: (url: string) => void
  handleCustomModelSubmit: (model: string) => void
  handleConfirmation: () => Promise<void>
  setValidationError: (value: string | null) => void
  handleConnectionTest: () => void
  handleContextLengthSubmit: () => void
  setModelLoadError: (value: string | null) => void
  getFormFieldsForModelParams: () => Array<{ name: string; component: string }>
  handleModelParamsSubmit: () => void
}) {
  useKeypress((input, key) => {
    const inputChar = input.length === 1 ? input : ''

    const clampIndex = (next: number, length: number) => {
      if (length <= 0) return 0
      return Math.max(0, Math.min(next, length - 1))
    }

    const isUp = key.upArrow || inputChar === 'k'
    const isDown = key.downArrow || inputChar === 'j'
    const isPageUp = key.pageUp
    const isPageDown = key.pageDown
    const isHome = key.home
    const isEnd = key.end

    const pageJump = 5

    if (args.currentScreen === 'provider') {
      if (isHome) {
        args.setProviderFocusIndex(0)
        return true
      }
      if (isEnd) {
        args.setProviderFocusIndex(
          clampIndex(
            args.mainMenuOptions.length - 1,
            args.mainMenuOptions.length,
          ),
        )
        return true
      }
      if (isUp) {
        args.setProviderFocusIndex(prev =>
          clampIndex(prev - 1, args.mainMenuOptions.length),
        )
        return true
      }
      if (isDown) {
        args.setProviderFocusIndex(prev =>
          clampIndex(prev + 1, args.mainMenuOptions.length),
        )
        return true
      }
      if (isPageUp) {
        args.setProviderFocusIndex(prev =>
          clampIndex(prev - pageJump, args.mainMenuOptions.length),
        )
        return true
      }
      if (isPageDown) {
        args.setProviderFocusIndex(prev =>
          clampIndex(prev + pageJump, args.mainMenuOptions.length),
        )
        return true
      }
      if (key.return) {
        const opt = args.mainMenuOptions[args.providerFocusIndex]
        if (opt) {
          void args.handleProviderSelection(opt.value)
        }
        return true
      }
    }

    if (args.currentScreen === 'partnerProviders') {
      if (isHome) {
        args.setPartnerProviderFocusIndex(0)
        return true
      }
      if (isEnd) {
        args.setPartnerProviderFocusIndex(
          clampIndex(
            args.partnerProviderOptions.length - 1,
            args.partnerProviderOptions.length,
          ),
        )
        return true
      }
      if (isUp) {
        args.setPartnerProviderFocusIndex(prev =>
          clampIndex(prev - 1, args.partnerProviderOptions.length),
        )
        return true
      }
      if (isDown) {
        args.setPartnerProviderFocusIndex(prev =>
          clampIndex(prev + 1, args.partnerProviderOptions.length),
        )
        return true
      }
      if (isPageUp) {
        args.setPartnerProviderFocusIndex(prev =>
          clampIndex(prev - pageJump, args.partnerProviderOptions.length),
        )
        return true
      }
      if (isPageDown) {
        args.setPartnerProviderFocusIndex(prev =>
          clampIndex(prev + pageJump, args.partnerProviderOptions.length),
        )
        return true
      }
      if (key.return) {
        const opt = args.partnerProviderOptions[args.partnerProviderFocusIndex]
        if (opt) {
          void args.handleProviderSelection(opt.value)
        }
        return true
      }
    }

    if (args.currentScreen === 'partnerCodingPlans') {
      if (isHome) {
        args.setCodingPlanFocusIndex(0)
        return true
      }
      if (isEnd) {
        args.setCodingPlanFocusIndex(
          clampIndex(
            args.codingPlanOptions.length - 1,
            args.codingPlanOptions.length,
          ),
        )
        return true
      }
      if (isUp) {
        args.setCodingPlanFocusIndex(prev =>
          clampIndex(prev - 1, args.codingPlanOptions.length),
        )
        return true
      }
      if (isDown) {
        args.setCodingPlanFocusIndex(prev =>
          clampIndex(prev + 1, args.codingPlanOptions.length),
        )
        return true
      }
      if (isPageUp) {
        args.setCodingPlanFocusIndex(prev =>
          clampIndex(prev - pageJump, args.codingPlanOptions.length),
        )
        return true
      }
      if (isPageDown) {
        args.setCodingPlanFocusIndex(prev =>
          clampIndex(prev + pageJump, args.codingPlanOptions.length),
        )
        return true
      }
      if (key.return) {
        const opt = args.codingPlanOptions[args.codingPlanFocusIndex]
        if (opt) {
          void args.handleProviderSelection(opt.value)
        }
        return true
      }
    }

    if (args.currentScreen === 'apiKey' && key.tab) {
      void args.fetchModelsWithRetry().catch(error => {
        logError(error)
      })
      return true
    }

    if (args.currentScreen === 'confirmation') {
      if (inputChar.toLowerCase() === 'a') {
        args.setActiveFieldIndex(0)
        args.navigateTo('modelParams')
        return true
      }
      if (key.return) {
        void args.handleConfirmation().catch(error => {
          logError(error)
          args.setValidationError(
            error instanceof Error
              ? error.message
              : 'Unexpected error occurred',
          )
        })
        return true
      }
    }

    if (args.currentScreen === 'connectionTest') {
      if (key.return) {
        if (!args.isTestingConnection && !args.connectionTestResult) {
          args.handleConnectionTest()
        } else if (
          args.connectionTestResult &&
          args.connectionTestResult.success
        ) {
          args.navigateTo('confirmation')
        } else if (
          args.connectionTestResult &&
          !args.connectionTestResult.success
        ) {
          args.handleConnectionTest()
        }
        return true
      }
    }

    if (args.currentScreen === 'contextLength') {
      if (key.return) {
        args.handleContextLengthSubmit()
        return true
      }

      if (isUp) {
        const currentIndex = args.contextLengthOptions.findIndex(
          opt => opt.value === args.contextLength,
        )
        const newIndex =
          currentIndex > 0
            ? currentIndex - 1
            : currentIndex === -1
              ? args.contextLengthOptions.findIndex(
                  opt => opt.value === DEFAULT_CONTEXT_LENGTH,
                ) || 0
              : args.contextLengthOptions.length - 1
        args.setContextLength(args.contextLengthOptions[newIndex]!.value)
        return true
      }

      if (isDown) {
        const currentIndex = args.contextLengthOptions.findIndex(
          opt => opt.value === args.contextLength,
        )
        const newIndex =
          currentIndex === -1
            ? args.contextLengthOptions.findIndex(
                opt => opt.value === DEFAULT_CONTEXT_LENGTH,
              ) || 0
            : (currentIndex + 1) % args.contextLengthOptions.length
        args.setContextLength(args.contextLengthOptions[newIndex]!.value)
        return true
      }
    }

    if (
      args.currentScreen === 'apiKey' &&
      ((key.ctrl && input === 'v') || (key.meta && input === 'v'))
    ) {
      args.setModelLoadError(
        "Paste the environment variable name with your terminal's normal paste action.",
      )
      return true
    }

    if (args.currentScreen === 'modelParams' && key.tab) {
      const formFields = args.getFormFieldsForModelParams()
      args.setActiveFieldIndex(current => (current + 1) % formFields.length)
      return true
    }

    if (args.currentScreen === 'modelParams' && key.return) {
      const formFields = args.getFormFieldsForModelParams()
      const currentField = formFields[args.activeFieldIndex]

      if (
        currentField?.name === 'submit' ||
        args.activeFieldIndex === formFields.length - 1
      ) {
        args.handleModelParamsSubmit()
        return true
      }

      if (currentField?.component === 'select') return false
    }
    return undefined
  })
}
