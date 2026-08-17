import { getAgentPrompt } from '#core/constants/prompts'
import { getContext } from '@kode/context'
import { query } from '@kode/engine/orchestrator'
import type { ToolUseContext } from '@kode/tool-interface/Tool'
import { getAvailableAgentTypes, getAgentByType } from '@kode/agent'
import { generateAgentId } from '#core/utils/agentStorage'
import {
  getAgentTranscript,
  saveAgentTranscript,
} from '#core/utils/agentTranscripts'
import { getCwd, getOriginalCwd } from '#core/utils/state'
import { getMaxThinkingTokens } from '#core/utils/thinking'
import { createDefaultToolPermissionContext } from '#core/types/toolPermissionContext'
import { LEGACY_ENV } from '#core/compat/legacyEnv'
import { getKodeAgentSessionId } from '#protocol/utils/kodeAgentSessionId'
import { getKodeAgentSessionForkInfo } from '#protocol/utils/kodeAgentSessionForkInfo'
import { loadKodeAgentSidechainMessagesForResume } from '#protocol/utils/kodeAgentSessionLoad'
import { AgentSupervisor } from '#core/utils/agentSupervisor'

import { getTaskTools } from './prompt'
import { buildForkContextForAgent } from './forkContext'
import { normalizeAgentModelName, modelEnumToPointer } from './models'
import { getToolNameFromSpec, parseToolSpec } from './toolSpec'
import {
  applyAgentPermissionMode,
  normalizeAgentPermissionMode,
} from './permissions'
import { callTaskToolBackground } from './callBackground'
import { callTaskToolForeground } from './callForeground'
import type { Input, Output } from './schema'
import type {
  PreparedTaskToolRun,
  QueryFn,
  TaskToolQueryOptions,
} from './callTypes'

type TaskToolUseContext = ToolUseContext & {
  __testQuery?: QueryFn
}

/**
 * Raw speech can be fragmented or self-correcting. A main agent must turn it
 * into a validated TaskBatch voice brief before a subagent receives work; this
 * keeps an unreviewed transcript from becoming an executable delegation
 * prompt. TaskBatch sets the second flag only after that validation succeeds.
 */
export function getVoiceTaskDispatchError(
  context: Pick<ToolUseContext, 'options'>,
): string | null {
  return context.options?.voiceTurn === true &&
    context.options.voiceIntentPrepared !== true
    ? 'Voice-originated delegation must use TaskBatch with a complete voice_intent. Organize the request, ask about unresolved points, then dispatch the structured tasks through TaskBatch.'
    : null
}

export async function* callTaskTool(
  input: Input,
  toolUseContext: TaskToolUseContext,
): AsyncGenerator<
  | {
      type: 'progress'
      content: any
      normalizedMessages?: any[]
      tools?: any[]
    }
  | {
      type: 'result'
      data: Output
      resultForAssistant?: string | any[]
      newMessages?: unknown[]
      contextModifier?: {
        modifyContext: (ctx: ToolUseContext) => ToolUseContext
      }
    },
  void,
  unknown
> {
  const voiceDispatchError = getVoiceTaskDispatchError(toolUseContext)
  if (voiceDispatchError) throw new Error(voiceDispatchError)
  const startTime = Date.now()
  const options = toolUseContext.options ?? {}
  const safeMode = options.safeMode ?? false
  const forkNumber = options.forkNumber ?? 0
  const messageLogName = options.messageLogName ?? 'default'
  const verbose = options.verbose ?? false
  const parentModel = options.model

  const queryFn: QueryFn =
    typeof toolUseContext.__testQuery === 'function'
      ? toolUseContext.__testQuery
      : query

  const agentConfig = await getAgentByType(input.subagent_type)
  if (!agentConfig) {
    const available = await getAvailableAgentTypes()
    throw new Error(
      `Agent type '${input.subagent_type}' not found. Available agents: ${available.join(', ')}`,
    )
  }

  const effectivePrompt = input.prompt

  const normalizedAgentModel = normalizeAgentModelName(agentConfig.model)
  const defaultSubagentModel = 'task'
  const envSubagentModel =
    process.env.KODE_SUBAGENT_MODEL ?? process.env[LEGACY_ENV.codeSubagentModel]
  const modelToUse: string =
    (typeof envSubagentModel === 'string' && envSubagentModel.trim()
      ? envSubagentModel.trim()
      : undefined) ||
    modelEnumToPointer(input.model) ||
    (normalizedAgentModel === 'inherit'
      ? parentModel || defaultSubagentModel
      : normalizedAgentModel) ||
    defaultSubagentModel

  const toolFilter = agentConfig.tools
  let tools = await getTaskTools(safeMode)
  let agentCommandAllowedTools: string[] = []
  if (toolFilter) {
    const isAllArray =
      Array.isArray(toolFilter) &&
      toolFilter.length === 1 &&
      toolFilter[0] === '*'
    if (toolFilter === '*' || isAllArray) {
      // Keep all tools
    } else if (Array.isArray(toolFilter)) {
      const parsedToolSpecs = toolFilter.map(parseToolSpec)
      const allowedToolNames = new Set(parsedToolSpecs.map(spec => spec.name))
      tools = tools.filter(t => allowedToolNames.has(t.name))
      agentCommandAllowedTools = parsedToolSpecs.flatMap(spec =>
        spec.commandAllowedRule ? [spec.commandAllowedRule] : [],
      )
    }
  }

  const disallowedTools = Array.isArray(agentConfig.disallowedTools)
    ? agentConfig.disallowedTools
    : []
  if (disallowedTools.length > 0) {
    const disallowedToolNames = new Set(
      disallowedTools.map(getToolNameFromSpec).filter(Boolean),
    )
    tools = tools.filter(t => !disallowedToolNames.has(t.name))
  }

  const enabledToolNames = new Set(tools.map(tool => tool.name))
  agentCommandAllowedTools = agentCommandAllowedTools.filter(rule =>
    enabledToolNames.has(getToolNameFromSpec(rule)),
  )

  const agentId = input.resume || generateAgentId()

  let baseTranscript: any[] = []
  if (input.resume) {
    const transcriptOwner = {
      agentId: input.resume,
      cwd: getCwd(),
      sessionId: getKodeAgentSessionId(),
    }
    const cached = getAgentTranscript(transcriptOwner)
    if (cached) {
      baseTranscript = cached.filter(m => m.type !== 'progress')
    } else {
      const loaded = loadKodeAgentSidechainMessagesForResume({
        ...transcriptOwner,
      })
      if (loaded.length === 0) {
        throw new Error(`No transcript found for agent ID: ${input.resume}`)
      }
      baseTranscript = loaded
      saveAgentTranscript(transcriptOwner, loaded as any)
    }
  }

  const { forkContextMessages, promptMessages } = buildForkContextForAgent({
    enabled:
      agentConfig.forkContext === true || options.forceForkContext === true,
    prompt: effectivePrompt,
    toolUseId: toolUseContext.toolUseId,
    messageLogName,
    forkNumber,
  })

  const transcriptMessages = [...(baseTranscript || []), ...promptMessages]
  const messagesForQuery = [...forkContextMessages, ...transcriptMessages]

  const [baseSystemPrompt, context, maxThinkingTokens] = await Promise.all([
    getAgentPrompt(),
    getContext(),
    getMaxThinkingTokens(messagesForQuery, {
      thinkingMode: options.thinkingMode,
    }),
  ])
  const systemPrompt =
    agentConfig.systemPrompt && agentConfig.systemPrompt.length > 0
      ? [...baseSystemPrompt, agentConfig.systemPrompt]
      : baseSystemPrompt

  const agentPermissionMode = normalizeAgentPermissionMode(
    agentConfig.permissionMode,
  )
  const baseToolPermissionContext =
    options.toolPermissionContext ??
    createDefaultToolPermissionContext({
      isBypassPermissionsModeAvailable: !safeMode,
    })
  const toolPermissionContext =
    applyAgentPermissionMode(baseToolPermissionContext, {
      agentPermissionMode,
      safeMode,
    }) ?? baseToolPermissionContext

  const launchIdentity = {
    cwd: getCwd(),
    originalCwd: getOriginalCwd(),
    sessionId: getKodeAgentSessionId(),
    sessionForkInfo: getKodeAgentSessionForkInfo(),
  }

  // Acquire only after fallible agent/config/context preparation so an
  // initialization error cannot leak a concurrency slot.
  const supervisor = AgentSupervisor.acquire(agentId, {
    maxExecutionTimeMs: agentConfig.maxExecutionTimeMs,
  })

  const queryOptions: TaskToolQueryOptions = {
    safeMode,
    forkNumber,
    messageLogName,
    tools,
    commands: [],
    verbose,
    permissionMode: toolPermissionContext.mode,
    toolPermissionContext,
    commandAllowedTools: [
      ...new Set([
        ...(options.commandAllowedTools ?? []),
        ...agentCommandAllowedTools,
      ]),
    ],
    maxTurns: Math.min(
      input.max_turns ?? supervisor.maxTurnsHardCap,
      supervisor.maxTurnsHardCap,
    ),
    maxThinkingTokens,
    model: modelToUse,
    mcpClients: options.mcpClients,
  }

  const prepared: PreparedTaskToolRun = {
    queryFn,
    agentId,
    effectivePrompt,
    systemPrompt,
    context,
    messagesForQuery,
    transcriptMessages,
    queryOptions,
    messageLogName,
    forkNumber,
    abortController: toolUseContext.abortController,
    readFileTimestamps: toolUseContext.readFileTimestamps,
    startTime,
    ...launchIdentity,
  }

  if (input.run_in_background) {
    try {
      // Background agents manage their own supervisor release after launch.
      yield* callTaskToolBackground(input, prepared, {
        parentAgentId: toolUseContext.agentId,
        parentToolUseId: toolUseContext.toolUseId,
        subagentType: input.subagent_type,
        model: modelToUse,
        supervisor,
      })
    } catch (error) {
      supervisor.release()
      throw error
    }
    return
  }

  const setToolJSXMaybe = (toolUseContext as any).setToolJSX as unknown
  const setToolJSX =
    typeof setToolJSXMaybe === 'function' ? (setToolJSXMaybe as any) : undefined

  let backgroundOwnershipTransferred = false
  try {
    for await (const chunk of callTaskToolForeground(input, prepared, {
      setToolJSX,
      backgroundMetadata: {
        parentAgentId: toolUseContext.agentId,
        parentToolUseId: toolUseContext.toolUseId,
        subagentType: input.subagent_type,
        model: modelToUse,
      },
      supervisor,
    })) {
      if (chunk.type === 'result') {
        saveAgentTranscript(
          {
            agentId: prepared.agentId,
            cwd: prepared.cwd,
            sessionId: prepared.sessionId,
          },
          prepared.transcriptMessages,
        )
        if (chunk.backgroundOwnershipTransferred) {
          backgroundOwnershipTransferred = true
        }
      }
      yield chunk
    }
  } finally {
    if (!backgroundOwnershipTransferred) supervisor.release()
  }
}
