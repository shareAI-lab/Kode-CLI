import type { ClientCapabilities } from '@modelcontextprotocol/sdk/types.js'

import { getMcpClientCapabilities } from './roots'

export type McpClientCapabilitySummary = {
  roots: { enabled: boolean; listChanged: boolean }
  sampling: { enabled: boolean; context: boolean; tools: boolean }
  elicitation: { enabled: boolean; form: boolean; url: boolean }
  tasks: {
    enabled: boolean
    list: boolean
    cancel: boolean
    samplingCreateMessage: boolean
    elicitationCreate: boolean
  }
}

export function summarizeMcpClientCapabilities(
  capabilities: ClientCapabilities = getMcpClientCapabilities(),
): McpClientCapabilitySummary {
  return {
    roots: {
      enabled: Boolean(capabilities.roots),
      listChanged: Boolean(capabilities.roots?.listChanged),
    },
    sampling: {
      enabled: Boolean(capabilities.sampling),
      context: Boolean(capabilities.sampling?.context),
      tools: Boolean(capabilities.sampling?.tools),
    },
    elicitation: {
      enabled: Boolean(capabilities.elicitation),
      form: Boolean(capabilities.elicitation?.form),
      url: Boolean(capabilities.elicitation?.url),
    },
    tasks: {
      enabled: Boolean(capabilities.tasks),
      list: Boolean(capabilities.tasks?.list),
      cancel: Boolean(capabilities.tasks?.cancel),
      samplingCreateMessage: Boolean(
        capabilities.tasks?.requests?.sampling?.createMessage,
      ),
      elicitationCreate: Boolean(
        capabilities.tasks?.requests?.elicitation?.create,
      ),
    },
  }
}

export function getMcpClientCapabilitySummary(): McpClientCapabilitySummary {
  return summarizeMcpClientCapabilities()
}

export function formatMcpClientCapabilityLine(
  name: string,
  enabled: boolean,
  detail?: string,
): string {
  if (!enabled) return `${name}: disabled`
  return `${name}: enabled${detail ? ` (${detail})` : ''}`
}

function detailList(details: Array<[string, boolean]>): string | undefined {
  const enabledDetails = details
    .filter(([, enabled]) => enabled)
    .map(([name]) => name)

  return enabledDetails.length > 0 ? enabledDetails.join(', ') : undefined
}

export function formatMcpClientCapabilitySummary(
  summary: McpClientCapabilitySummary,
): string[] {
  return [
    formatMcpClientCapabilityLine(
      'roots',
      summary.roots.enabled,
      summary.roots.listChanged ? 'listChanged' : undefined,
    ),
    formatMcpClientCapabilityLine(
      'sampling',
      summary.sampling.enabled,
      detailList([
        ['context', summary.sampling.context],
        ['tools', summary.sampling.tools],
      ]),
    ),
    formatMcpClientCapabilityLine(
      'elicitation',
      summary.elicitation.enabled,
      detailList([
        ['form', summary.elicitation.form],
        ['url', summary.elicitation.url],
      ]),
    ),
    formatMcpClientCapabilityLine(
      'tasks',
      summary.tasks.enabled,
      detailList([
        ['list', summary.tasks.list],
        ['cancel', summary.tasks.cancel],
        ['sampling.createMessage', summary.tasks.samplingCreateMessage],
        ['elicitation.create', summary.tasks.elicitationCreate],
      ]),
    ),
  ]
}
