import { bindAiDebug } from '@kode/ai'
import {
  debug,
  getCurrentRequest,
  logAPIError,
  logLLMInteraction,
  logSystemPromptConstruction,
} from '#core/utils/debugLogger'

/**
 * Attach core diagnostics to @kode/ai so provider transport keeps full logs
 * without packages/ai hard-depending on core logger modules.
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
}
