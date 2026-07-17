import {
  bindAiDebug,
  bindAiRequestStatus,
  bindAiRuntime,
} from '@kode/ai'
import {
  debug,
  getCurrentRequest,
  logAPIError,
  logLLMInteraction,
  logSystemPromptConstruction,
} from '#core/utils/debugLogger'
import { getGlobalConfig } from '#core/utils/config'
import { getModelManager } from '#core/utils/model'
import { logError } from '#core/utils/log'
import { addToTotalCost } from '#core/cost-tracker'
import {
  setRequestStatus,
  setRequestInputTokens,
  updateRequestTokens,
} from '#core/utils/requestStatus'

/**
 * Attach core diagnostics and runtime knobs to @kode/ai so provider transport
 * keeps full logs/status without hard-depending on those core modules.
 *
 * Adapter factory defaults to the in-package ModelAdapterFactory; no host bind
 * is required for the Responses API path.
 */
export function bindAiDebugFromCore(): void {
  bindAiDebug({
    debug,
    getCurrentRequest: () => {
      const current = getCurrentRequest()
      return current?.id ? { id: current.id } : null
    },
    logAPIError,
    logLLMInteraction,
    logSystemPromptConstruction,
  })
  bindAiRequestStatus({
    setRequestStatus,
    setRequestInputTokens,
    updateRequestTokens,
  })
  bindAiRuntime({
    getProxy: () => getGlobalConfig().proxy,
    getStream: () => getGlobalConfig().stream !== false,
    getMainModelProfile: () => getModelManager().getModel('main'),
    logError,
    addToTotalCost,
  })
}
