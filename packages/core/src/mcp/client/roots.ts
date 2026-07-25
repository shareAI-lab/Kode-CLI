import { basename, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import {
  type ClientCapabilities,
  ListRootsRequestSchema,
  type Root,
} from '@modelcontextprotocol/sdk/types.js'

import { checkHasTrustDialogAccepted } from '#core/utils/config'
import { logMCPError } from '#core/utils/log'
import { getCwd, subscribeCwdChanged } from '#core/utils/state'
import { isMcpSamplingEnabled } from './sampling'

let exposeRootsOverrideForTests: boolean | null = null
const rootsClients = new Set<Client>()
let unsubscribeCwdChanged: (() => void) | null = null
const MCP_ROOTS_LIST_METHOD = 'roots/list'

type ClientWithOptionalRemoveRequestHandler = Client & {
  removeRequestHandler?: (method: string) => void
}

export function createMcpRootsForCwd(cwd: string): Root[] {
  const rootPath = resolve(cwd)
  return [
    {
      uri: pathToFileURL(rootPath).toString(),
      name: basename(rootPath) || rootPath,
    },
  ]
}

export function getMcpRoots(): Root[] {
  return createMcpRootsForCwd(getCwd())
}

export function shouldExposeMcpRoots(): boolean {
  if (process.env.NODE_ENV === 'test' && exposeRootsOverrideForTests !== null) {
    return exposeRootsOverrideForTests
  }
  return checkHasTrustDialogAccepted()
}

export function getMcpClientCapabilities(): ClientCapabilities {
  const capabilities: ClientCapabilities = {}

  if (shouldExposeMcpRoots()) {
    capabilities.roots = { listChanged: true }
  }

  if (isMcpSamplingEnabled()) {
    capabilities.sampling = {}
  }

  return capabilities
}

function ensureCwdChangedSubscription(): void {
  if (unsubscribeCwdChanged) return

  unsubscribeCwdChanged = subscribeCwdChanged(() => {
    notifyMcpRootsListChanged()
  })
}

function cleanupCwdChangedSubscriptionIfIdle(): void {
  if (rootsClients.size > 0 || !unsubscribeCwdChanged) return

  unsubscribeCwdChanged()
  unsubscribeCwdChanged = null
}

function removeMcpRootsListRequestHandler(client: Client): void {
  const clientWithRemove = client as ClientWithOptionalRemoveRequestHandler

  clientWithRemove.removeRequestHandler?.(MCP_ROOTS_LIST_METHOD)
}

export function notifyMcpRootsListChanged(): void {
  for (const client of rootsClients) {
    void client.sendRootsListChanged().catch(error => {
      rootsClients.delete(client)
      cleanupCwdChangedSubscriptionIfIdle()
      logMCPError(
        'roots',
        `Failed to notify MCP roots list change: ${error instanceof Error ? error.message : String(error)}`,
      )
    })
  }
}

export function registerMcpClientRequestHandlers(client: Client): void {
  if (!shouldExposeMcpRoots()) return

  client.setRequestHandler(ListRootsRequestSchema, async () => ({
    roots: getMcpRoots(),
  }))

  rootsClients.add(client)
  ensureCwdChangedSubscription()
}

export function unregisterMcpClientRequestHandlers(client: Client): void {
  const wasRegistered = rootsClients.delete(client)
  if (wasRegistered) {
    removeMcpRootsListRequestHandler(client)
  }

  cleanupCwdChangedSubscriptionIfIdle()
}

export function __setMcpRootsTrustOverrideForTests(
  value: boolean | null,
): void {
  exposeRootsOverrideForTests = value
}

export function __resetMcpRootsForTests(): void {
  exposeRootsOverrideForTests = null
  rootsClients.clear()
  unsubscribeCwdChanged?.()
  unsubscribeCwdChanged = null
}

export function __isMcpRootsCwdWatcherActiveForTests(): boolean {
  return unsubscribeCwdChanged !== null
}
