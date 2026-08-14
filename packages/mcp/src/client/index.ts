export type { ConnectedClient, FailedClient, WrappedClient } from './types'

export type { ScopedMcpServerConfig } from './config'
export {
  addMcpServer,
  ensureConfigScope,
  getMcprcServerStatus,
  getMcpServer,
  listMCPServers,
  listPluginMCPServers,
  parseEnvVars,
  parseMcpServersFromCliConfigEntries,
  removeMcpServer,
} from './config'

export { getClients, getClientsForCliMcpConfig } from './clients'
export { __setMcpClientsForTests } from './clients'
export { MCPClientManager } from './manager'

export {
  completeMCPArgument,
  type McpCompletion,
  type McpCompletionRef,
  type McpCompletionRequest,
} from './completion'
export { getMCPTools } from './tools'
export { getMCPCommands, runCommand, type McpPromptCommand } from './commands'
export {
  getMCPResources,
  getMCPResourceTemplates,
  subscribeMCPResource,
  unsubscribeMCPResource,
  type McpResource,
  type McpResourceTemplate,
} from './resources'
export {
  __resetMcpResourceUpdatesForTests,
  notifyMcpResourceUpdated,
  subscribeMcpResourceUpdated,
  type McpResourceUpdatedEvent,
} from './resourceUpdates'
export {
  authenticateMcpServer,
  clearMcpAuth,
  getMcpAuthSnapshot,
} from './oauth'
export { resetMcpConnections } from './reset'
export {
  createMcpRootsForCwd,
  getMcpClientCapabilities,
  getMcpRoots,
  shouldExposeMcpRoots,
} from './roots'
export {
  formatMcpClientCapabilityLine,
  formatMcpClientCapabilitySummary,
  getMcpClientCapabilitySummary,
  summarizeMcpClientCapabilities,
  type McpClientCapabilitySummary,
} from './clientCapabilities'

export {
  __resetMcpListChangedForTests,
  getMcpListChangedVersion,
  notifyMcpListChanged,
  subscribeMcpListChanged,
  type McpListChangedEvent,
  type McpListKind,
} from './listChanged'
export {
  __resetMcpLoggingForTests,
  MCP_LOGGING_LEVELS,
  handleMcpLoggingMessage,
  setMcpLoggingLevel,
  subscribeMcpLogMessage,
  type McpLogMessageEvent,
  type McpLoggingLevel,
} from './logging'
export {
  __resetMcpSamplingForTests,
  __setMcpSamplingEnabledForTests,
  isMcpSamplingEnabled,
  setMcpSamplingEnabled,
} from './sampling'
