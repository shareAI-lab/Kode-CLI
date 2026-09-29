import type {
  ClientCapabilities,
  CreateMessageRequest,
  CreateMessageResult,
  ElicitRequest,
  ElicitResult,
} from '@modelcontextprotocol/sdk/types.js'

import { getDefaultMcpRoots, type McpRoot } from './roots'

export type ElicitationMode = 'form' | 'url'

/**
 * Per-request context for a server-to-client capability request.
 */
export type McpCapabilityRequestContext = {
  /**
   * Aborted when the server cancels (or the connection drops) the request that
   * triggered this prompt, so hosts can stop work that is no longer wanted.
   */
  signal?: AbortSignal
}

/**
 * Host-provided implementations for the MCP client capabilities that require
 * user interaction or model access. Hosts (the CLI, the daemon, tests) install
 * these once at startup; anything a host does not install stays unadvertised so
 * servers never send requests Kode cannot answer.
 */
export type McpCapabilityResponders = {
  /**
   * Filesystem roots exposed via `roots/list`. Defaults to the trusted
   * workspace roots when not installed.
   */
  getRoots?: (serverName: string) => Promise<McpRoot[]>
  /** Handle `elicitation/create` requests by asking the user. */
  elicit?: (
    serverName: string,
    request: ElicitRequest,
    context?: McpCapabilityRequestContext,
  ) => Promise<ElicitResult>
  /** Elicitation modes the host can render. Defaults to `['form']`. */
  elicitationModes?: ElicitationMode[]
  /** Handle `sampling/createMessage` requests by calling a model. */
  sample?: (
    serverName: string,
    request: CreateMessageRequest,
    context?: McpCapabilityRequestContext,
  ) => Promise<CreateMessageResult>
}

let responders: McpCapabilityResponders = {}

export function setMcpCapabilityResponders(
  next: McpCapabilityResponders | null,
): void {
  responders = next ?? {}
}

export function getMcpCapabilityResponders(): McpCapabilityResponders {
  return responders
}

export async function resolveMcpRoots(serverName: string): Promise<McpRoot[]> {
  const getRoots = responders.getRoots
  if (getRoots) return await getRoots(serverName)
  return getDefaultMcpRoots()
}

/**
 * Client capabilities to advertise during `initialize`.
 *
 * `roots` is always advertised because Kode can always answer with an (empty
 * or trusted) root list. `elicitation` and `sampling` are only advertised when
 * a host responder is installed, so a headless run never invites a server
 * request it would have to fail.
 */
export function getMcpClientCapabilities(): ClientCapabilities {
  const capabilities: ClientCapabilities = { roots: { listChanged: false } }

  if (responders.elicit) {
    const modes = responders.elicitationModes ?? ['form']
    const elicitation: NonNullable<ClientCapabilities['elicitation']> = {}
    if (modes.includes('form')) elicitation.form = {}
    if (modes.includes('url')) elicitation.url = {}
    capabilities.elicitation = elicitation
  }

  if (responders.sample) capabilities.sampling = {}

  return capabilities
}
