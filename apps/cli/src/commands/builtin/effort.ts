import type { ModelManager } from '#core/model/manager'
import { triggerModelConfigChange } from '#core/messages'
import { getModelManager } from '#core/utils/model'
import { isReasoningEffort } from '#core/model/reasoningEffort'

import type { Command } from '../types'

const HELP_ARGS = new Set(['help', '-h', '--help'])

type EffortModelManager = Pick<
  ModelManager,
  'getModel' | 'getSupportedReasoningEfforts' | 'setReasoningEffort'
>

function formatAvailableEfforts(efforts: readonly string[]): string {
  return efforts.length > 0 ? efforts.join(', ') : 'not supported'
}

export function setCurrentModelReasoningEffort(
  rawEffort: string,
  modelManager: EffortModelManager,
): string {
  const profile = modelManager.getModel('main')
  if (!profile) return 'No main model is configured. Run /model first.'

  const supported = modelManager.getSupportedReasoningEfforts('main')
  const effort = rawEffort.trim().toLowerCase()
  if (!effort) {
    return `Current reasoning effort for ${profile.name}: ${profile.reasoningEffort ?? 'provider default'}. Available: ${formatAvailableEfforts(supported)}.`
  }
  if (HELP_ARGS.has(effort)) {
    return `Usage: /effort [level]\nCurrent model: ${profile.name}\nAvailable levels: ${formatAvailableEfforts(supported)}.`
  }
  if (!isReasoningEffort(effort)) {
    return `Invalid reasoning effort '${rawEffort}'. Available: ${formatAvailableEfforts(supported)}.`
  }
  if (!supported.includes(effort)) {
    return `Reasoning effort '${effort}' is not supported by ${profile.name}. Available: ${formatAvailableEfforts(supported)}.`
  }

  modelManager.setReasoningEffort('main', effort)
  return `Set reasoning effort for ${profile.name} to ${effort}.`
}

const effort = {
  type: 'local',
  name: 'effort',
  description: 'Show or set the current model reasoning effort',
  isEnabled: true,
  isHidden: false,
  argumentHint: '[none|minimal|low|medium|high|xhigh|max]',
  userFacingName() {
    return 'effort'
  },
  async call(args) {
    const result = setCurrentModelReasoningEffort(args, getModelManager())
    if (result.startsWith('Set reasoning effort')) {
      triggerModelConfigChange()
    }
    return result
  },
} satisfies Command

export default effort
