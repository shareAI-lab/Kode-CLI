export type JsonObject = Record<string, unknown>

export type Implementation = {
  name: string
  title?: string | null
  version: string
  _meta?: JsonObject | null
}

export type FileSystemCapability = {
  readTextFile?: boolean
  writeTextFile?: boolean
  _meta?: JsonObject | null
}

export type ClientCapabilities = {
  fs?: FileSystemCapability
  terminal?: boolean
  _meta?: JsonObject | null
}

export type PromptCapabilities = {
  audio?: boolean
  image?: boolean
  embeddedContext?: boolean
  /**
   * Compatibility: some clients used `embeddedContent` historically.
   * We advertise both.
   */
  embeddedContent?: boolean
  _meta?: JsonObject | null
}

export type McpCapabilities = {
  http?: boolean
  sse?: boolean
  ws?: boolean
  _meta?: JsonObject | null
}

export type AgentCapabilities = {
  loadSession?: boolean
  promptCapabilities?: PromptCapabilities
  mcpCapabilities?: McpCapabilities
  sessionCapabilities?: JsonObject
  _meta?: JsonObject | null
}

export type AuthMethod = {
  id: string
  name: string
  description?: string | null
  _meta?: JsonObject | null
}

export type InitializeParams = {
  protocolVersion: number
  clientCapabilities?: ClientCapabilities
  clientInfo?: Implementation | null
  _meta?: JsonObject | null
}

export type InitializeResponse = {
  protocolVersion: number
  agentCapabilities: AgentCapabilities
  agentInfo?: Implementation | null
  authMethods?: AuthMethod[]
  _meta?: JsonObject | null
}

export type AuthenticateParams = {
  methodId: string
  _meta?: JsonObject | null
}

export type AuthenticateResponse = JsonObject

export type EnvVariable = {
  name: string
  value: string
  _meta?: JsonObject | null
}

export type HttpHeader = {
  name: string
  value: string
  _meta?: JsonObject | null
}

export type McpServerStdio = {
  /**
   * Optional discriminator (some clients omit it for stdio).
   */
  type?: 'stdio'
  name: string
  command: string
  args: string[]
  env: EnvVariable[]
  _meta?: JsonObject | null
}

export type McpServerHttp = {
  type: 'http'
  name: string
  url: string
  headers: HttpHeader[]
  _meta?: JsonObject | null
}

export type McpServerSse = {
  type: 'sse'
  name: string
  url: string
  headers: HttpHeader[]
  _meta?: JsonObject | null
}

export type McpServerWs = {
  type: 'ws'
  name: string
  url: string
  _meta?: JsonObject | null
}

export type McpServer =
  McpServerStdio | McpServerHttp | McpServerSse | McpServerWs

export type SessionModeId = string

export type SessionMode = {
  id: SessionModeId
  name: string
  description?: string | null
  _meta?: JsonObject | null
}

export type SessionModeState = {
  currentModeId: SessionModeId
  availableModes: SessionMode[]
  _meta?: JsonObject | null
}

export type NewSessionParams = {
  cwd: string
  mcpServers: McpServer[]
  _meta?: JsonObject | null
}

export type NewSessionResponse = {
  sessionId: string
  modes?: SessionModeState | null
  _meta?: JsonObject | null
}

export type LoadSessionParams = {
  sessionId: string
  cwd: string
  mcpServers: McpServer[]
  _meta?: JsonObject | null
}

export type LoadSessionResponse = {
  modes?: SessionModeState | null
  _meta?: JsonObject | null
}

export type StopReason =
  'end_turn' | 'max_tokens' | 'max_turn_requests' | 'refusal' | 'cancelled'

export type PromptResponse = {
  stopReason: StopReason
  _meta?: JsonObject | null
}

export type SessionCancelParams = {
  sessionId: string
  _meta?: JsonObject | null
}

export type SetSessionModeParams = {
  sessionId: string
  modeId: SessionModeId
  _meta?: JsonObject | null
}

export type SetSessionModeResponse = JsonObject

export type TextContent = {
  type: 'text'
  text: string
  annotations?: JsonObject | null
  _meta?: JsonObject | null
}

export type ImageContent = {
  type: 'image'
  data?: string
  mimeType?: string
  url?: string
  annotations?: JsonObject | null
  _meta?: JsonObject | null
}

export type AudioContent = {
  type: 'audio'
  data: string
  mimeType: string
  annotations?: JsonObject | null
  _meta?: JsonObject | null
}

export type EmbeddedResource = {
  uri: string
  mimeType?: string | null
  text?: string
  blob?: string
  _meta?: JsonObject | null
}

export type EmbeddedResourceContent = {
  type: 'resource'
  resource: EmbeddedResource
  annotations?: JsonObject | null
  _meta?: JsonObject | null
}

export type ResourceLinkContent = {
  type: 'resource_link'
  uri: string
  name: string
  title?: string | null
  description?: string | null
  mimeType?: string | null
  size?: number | null
  annotations?: JsonObject | null
  _meta?: JsonObject | null
}

export type ContentBlock =
  | TextContent
  | ImageContent
  | AudioContent
  | EmbeddedResourceContent
  | ResourceLinkContent

export type PromptParams = {
  sessionId: string
  prompt: ContentBlock[]
  _meta?: JsonObject | null
}
