import { nanoid } from 'nanoid'

import { isAbsolute } from 'node:path'

import { buildSystemPromptForSession, getSessionContext } from '#core/engine'
import { getTools } from '#tools'
import { grantReadPermissionForOriginalDir } from '#core/utils/permissions/filesystem'
import { setCwd, setOriginalCwd } from '#core/utils/state'
import { loadToolPermissionContextFromDisk } from '#core/utils/permissions/toolPermissionSettings'
import { getClients, type WrappedClient } from '#core/mcp/client'

import { JsonRpcError, type JsonRpcPeer } from '../../jsonrpc'
import type * as Protocol from '../../protocol'
import { connectAcpMcpServers, mergeMcpClients } from '../mcp'
import { coercePermissionMode, getModeState } from '../modes'
import {
  loadAcpSessionFromDisk,
  persistAcpSessionToDisk,
} from '../sessionStore'
import { sendAvailableCommands, sendCurrentMode } from '../notifications'
import { replayConversation } from '../kodeMessages'
import type { AcpCommand, SessionState } from '../types'
import { isRecord } from '../guards'

async function loadSessionDeps(): Promise<{
  commands: AcpCommand[]
  tools: Awaited<ReturnType<typeof getTools>>
  context: Record<string, string>
  systemPrompt: string[]
  configuredMcpClients: WrappedClient[]
}> {
  const [tools, ctx, systemPrompt, configuredMcpClients] = await Promise.all([
    getTools(),
    getSessionContext(),
    buildSystemPromptForSession({ disableSlashCommands: false }),
    getClients().catch(() => [] as WrappedClient[]),
  ])
  return {
    commands: [],
    tools,
    context: ctx,
    systemPrompt,
    configuredMcpClients,
  }
}

export async function handleSessionNew(args: {
  peer: JsonRpcPeer
  sessions: Map<string, SessionState>
  params: unknown
}): Promise<Protocol.NewSessionResponse> {
  const p = isRecord(args.params) ? args.params : {}

  const cwd = typeof p.cwd === 'string' ? p.cwd : ''
  if (!cwd) {
    throw new JsonRpcError(-32602, 'Missing required param: cwd')
  }
  if (!isAbsolute(cwd)) {
    throw new JsonRpcError(-32602, `cwd must be an absolute path: ${cwd}`)
  }

  setOriginalCwd(cwd)
  await setCwd(cwd)
  grantReadPermissionForOriginalDir()

  const mcpServers = Array.isArray(p.mcpServers)
    ? (p.mcpServers as Protocol.McpServer[])
    : []

  const { commands, tools, context, systemPrompt, configuredMcpClients } =
    await loadSessionDeps()

  const acpMcpClients = await connectAcpMcpServers(mcpServers, { cwd })
  const mcpClients = mergeMcpClients(configuredMcpClients, acpMcpClients)

  const toolPermissionContext = loadToolPermissionContextFromDisk({
    projectDir: cwd,
    includeKodeProjectConfig: true,
    isBypassPermissionsModeAvailable: true,
  })

  const sessionId = `sess_${nanoid()}`
  const currentModeId = toolPermissionContext.mode

  const session: SessionState = {
    sessionId,
    cwd,
    mcpServers,
    mcpClients,
    commands,
    tools,
    systemPrompt,
    context,
    messages: [],
    toolPermissionContext,
    readFileTimestamps: {},
    responseState: {},
    currentModeId,
    activeAbortController: null,
    toolCalls: new Map(),
  }

  args.sessions.set(sessionId, session)

  sendAvailableCommands(args.peer, session)
  sendCurrentMode(args.peer, session)
  persistAcpSessionToDisk(session)

  return {
    sessionId,
    modes: getModeState(session.currentModeId),
  }
}

export async function handleSessionLoad(args: {
  peer: JsonRpcPeer
  sessions: Map<string, SessionState>
  params: unknown
}): Promise<Protocol.LoadSessionResponse> {
  const p = isRecord(args.params) ? args.params : {}

  const sessionId = typeof p.sessionId === 'string' ? p.sessionId : ''
  const cwd = typeof p.cwd === 'string' ? p.cwd : ''
  if (!sessionId)
    throw new JsonRpcError(-32602, 'Missing required param: sessionId')
  if (!cwd) throw new JsonRpcError(-32602, 'Missing required param: cwd')
  if (!isAbsolute(cwd)) {
    throw new JsonRpcError(-32602, `cwd must be an absolute path: ${cwd}`)
  }

  setOriginalCwd(cwd)
  await setCwd(cwd)
  grantReadPermissionForOriginalDir()

  const persisted = loadAcpSessionFromDisk(cwd, sessionId)
  if (!persisted) {
    throw new JsonRpcError(-32602, `Session not found: ${sessionId}`)
  }

  const mcpServers = Array.isArray(p.mcpServers)
    ? (p.mcpServers as Protocol.McpServer[])
    : []

  const { commands, tools, context, systemPrompt, configuredMcpClients } =
    await loadSessionDeps()

  const acpMcpClients = await connectAcpMcpServers(mcpServers, { cwd })
  const mcpClients = mergeMcpClients(configuredMcpClients, acpMcpClients)

  const toolPermissionContext = loadToolPermissionContextFromDisk({
    projectDir: cwd,
    includeKodeProjectConfig: true,
    isBypassPermissionsModeAvailable: true,
  })

  const currentModeId = coercePermissionMode(
    typeof persisted.currentModeId === 'string' && persisted.currentModeId
      ? persisted.currentModeId
      : toolPermissionContext.mode,
  )
  toolPermissionContext.mode = currentModeId

  const session: SessionState = {
    sessionId,
    cwd,
    mcpServers,
    mcpClients,
    commands,
    tools,
    systemPrompt,
    context,
    messages: Array.isArray(persisted.messages) ? persisted.messages : [],
    toolPermissionContext,
    readFileTimestamps: isRecord(persisted.readFileTimestamps)
      ? (persisted.readFileTimestamps as Record<string, number>)
      : {},
    responseState: isRecord(persisted.responseState)
      ? (persisted.responseState as SessionState['responseState'])
      : {},
    currentModeId,
    activeAbortController: null,
    toolCalls: new Map(),
  }

  args.sessions.set(sessionId, session)
  sendAvailableCommands(args.peer, session)
  sendCurrentMode(args.peer, session)
  replayConversation(args.peer, session)

  return { modes: getModeState(session.currentModeId) }
}

export async function handleSessionSetMode(args: {
  peer: JsonRpcPeer
  sessions: Map<string, SessionState>
  params: unknown
}): Promise<Protocol.SetSessionModeResponse> {
  const p = isRecord(args.params) ? args.params : {}
  const sessionId = typeof p.sessionId === 'string' ? p.sessionId : ''
  const modeId = typeof p.modeId === 'string' ? p.modeId : ''

  const session = args.sessions.get(sessionId)
  if (!session)
    throw new JsonRpcError(-32602, `Session not found: ${sessionId}`)

  const allowed = new Set(
    getModeState(session.currentModeId).availableModes.map(m => m.id),
  )
  if (!allowed.has(modeId)) {
    throw new JsonRpcError(-32602, `Unknown modeId: ${modeId}`)
  }

  const nextMode = coercePermissionMode(modeId)
  session.currentModeId = nextMode
  session.toolPermissionContext.mode = nextMode
  sendCurrentMode(args.peer, session)
  persistAcpSessionToDisk(session)

  return {}
}

export async function handleSessionCancel(args: {
  sessions: Map<string, SessionState>
  params: unknown
}): Promise<void> {
  const p = isRecord(args.params) ? args.params : {}
  const sessionId = typeof p.sessionId === 'string' ? p.sessionId : ''
  const session = args.sessions.get(sessionId)
  if (!session) return
  session.activeAbortController?.abort()
}
