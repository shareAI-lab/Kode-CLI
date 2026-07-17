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
import {
  setRequestStatus,
  setRequestInputTokens,
  updateRequestTokens,
} from '#core/utils/requestStatus'

/**
 * Attach core diagnostics and runtime knobs to @kode/ai so provider transport
 * keeps full logs/status without hard-depending on those core modules.
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
  })
}
