import { randomUUID } from 'crypto'

import { addToHistory } from '#core/history'
import { hasPermissionsToUseTool } from '#core/permissions'
import { isUuid } from '#core/utils/uuid'
import { LEGACY_ENV } from '#core/compat/legacyEnv'

import type { WrappedClient } from '#core/mcp/client'
import type { Message } from '#core/query'
import type { Tool } from '#core/tooling/Tool'
import type { PermissionMode } from '#core/types/PermissionMode'
import type { ToolPermissionContextUpdate } from '#core/types/toolPermissionContext'
import type { ContentBlockParam } from '@anthropic-ai/sdk/resources/index.mjs'

import {
  getOutputStyleSystemPromptAdditions,
  getCurrentOutputStyleDefinition,
} from '#cli-services/outputStyles'
import { createPrintControlRequestHandler } from './controlRequests'
import {
  finishHeadlessRun,
  startHeadlessRun,
} from './headlessRunTelemetry'
import { createStdioPermissionPromptCanUseTool } from './permissionPrompt'
import { runSingleTurnPrint } from './runSingleTurn'

type UUID = `${string}-${string}-${string}-${string}-${string}`

function isUuidValue(value: string): value is UUID {
  return isUuid(value)
}

export type RunNonTextPrintModeArgs = {
  inputPrompt: string
  cwd: string
  safe?: boolean
  verbose?: boolean

  normalizedOutputFormat: 'json' | 'stream-json'
  normalizedInputFormat: 'text' | 'stream-json'
  normalizedPermissionPromptTool: string | null
  replayUserMessages?: boolean
  maxThinkingTokens?: number
  maxTurns?: number
  maxBudgetUsd?: number
  includePartialMessages?: boolean

  toolsForPrint: Tool[]
  commands: Array<{ isHidden?: boolean; userFacingName: () => string }>
  initialMessages?: Message[]
  sessionPersistence?: boolean

  systemPromptOverride?: string
  appendSystemPrompt?: string
  disableSlashCommands?: boolean

  allowedTools?: unknown
  disallowedTools?: unknown
  addDir?: unknown
  permissionMode?: string
  dangerouslySkipPermissions?: boolean
  allowDangerouslySkipPermissions?: boolean

  jsonSchema?: string
  model?: string
  mcpClients: WrappedClient[]
}

function cliRuleList(value: unknown): string[] {
  if (!value) return []
  const raw = Array.isArray(value) ? value : [value]
  return raw
    .flatMap(v => String(v ?? '').split(','))
    .map(v => v.trim())
    .filter(Boolean)
}

function isPermissionMode(value: string): value is PermissionMode {
  return (
    value === 'acceptEdits' ||
    value === 'bypassPermissions' ||
    value === 'default' ||
    value === 'dontAsk' ||
    value === 'plan'
  )
}

export async function runNonTextPrintMode(
  args: RunNonTextPrintModeArgs,
): Promise<void> {
  const { createUserMessage } = await import('#core/utils/messages')
  const { getTotalCost, getTotalAPIDuration } =
    await import('#core/cost-tracker')
  const { buildSystemPromptForSession, runTurn, query } =
    await import('@kode/engine')
  const { getContext } = await import('@kode/context')
  const { getKodeAgentSessionId } =
    await import('#protocol/utils/kodeAgentSessionId')
  const { kodeMessageToSdkMessage, makeSdkInitMessage, makeSdkResultMessage } =
    await import('#protocol/utils/kodeAgentStreamJson')
  const { KodeAgentStructuredStdio } =
    await import('#protocol/utils/kodeAgentStructuredStdio')
  const {
    loadToolPermissionContextFromDisk,
    persistToolPermissionUpdateToDisk,
  } = await import('#core/utils/permissions/toolPermissionSettings')
  const { applyToolPermissionContextUpdates } =
    await import('#core/types/toolPermissionContext')

  const sessionIdForSdk = getKodeAgentSessionId()
  const startedAt = Date.now()
  const sdkMessages: unknown[] = []
  const shouldIncludePartialMessages =
    args.normalizedOutputFormat === 'stream-json' &&
    Boolean(args.includePartialMessages)
  const headlessRun = startHeadlessRun({
    cwd: args.cwd,
    inputFormat: args.normalizedInputFormat,
    outputFormat: args.normalizedOutputFormat,
    promptChars:
      args.normalizedInputFormat === 'stream-json'
        ? 0
        : args.inputPrompt.length,
    toolCount: args.toolsForPrint.length,
    model: args.model,
    maxTurns: args.maxTurns,
    maxBudgetUsd: args.maxBudgetUsd,
  })

  const writeSdkLine = (obj: unknown) => {
    process.stdout.write(JSON.stringify(obj) + '\n')
  }

  const normalizedJsonSchema =
    typeof args.jsonSchema === 'string' ? args.jsonSchema.trim() : ''
  const parsedJsonSchema = (() => {
    if (!normalizedJsonSchema) return null
    try {
      const parsed = JSON.parse(normalizedJsonSchema)
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('Schema must be a JSON object')
      }
      return parsed as Record<string, unknown>
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      console.error(`Error: Invalid --json-schema: ${msg}`)
      finishHeadlessRun(headlessRun, {
        isError: true,
        resultSubtype: 'error_invalid_json_schema',
        error: msg,
      })
      process.exit(1)
    }
  })()

  const outputStyle = getCurrentOutputStyleDefinition()
  const systemPrompt = await buildSystemPromptForSession({
    disableSlashCommands: args.disableSlashCommands,
    systemPromptOverride: args.systemPromptOverride,
    appendSystemPrompt: args.appendSystemPrompt,
    jsonSchema: parsedJsonSchema,
    outputStyleActive: outputStyle !== null,
    keepCodingInstructions: outputStyle?.keepCodingInstructions,
  })

  const ctx = await getContext()

  const isBypassAvailable =
    !args.safe ||
    Boolean(args.allowDangerouslySkipPermissions) ||
    Boolean(args.dangerouslySkipPermissions)

  let toolPermissionContext = loadToolPermissionContextFromDisk({
    projectDir: args.cwd,
    includeKodeProjectConfig: true,
    isBypassPermissionsModeAvailable: isBypassAvailable,
  })

  const updates: ToolPermissionContextUpdate[] = []
  const allowedRules = cliRuleList(args.allowedTools)
  const deniedRules = cliRuleList(args.disallowedTools)
  const additionalDirs = cliRuleList(args.addDir)

  if (allowedRules.length > 0) {
    updates.push({
      type: 'addRules',
      destination: 'cliArg',
      behavior: 'allow',
      rules: allowedRules,
    })
  }
  if (deniedRules.length > 0) {
    updates.push({
      type: 'addRules',
      destination: 'cliArg',
      behavior: 'deny',
      rules: deniedRules,
    })
  }
  if (additionalDirs.length > 0) {
    updates.push({
      type: 'addDirectories',
      destination: 'cliArg',
      directories: additionalDirs,
    })
  }

  const normalizedPermissionMode =
    typeof args.permissionMode === 'string' ? args.permissionMode.trim() : ''
  const hasRuleEntries = (
    groups: typeof toolPermissionContext.alwaysAllowRules,
  ) =>
    Object.values(groups).some(
      rules => Array.isArray(rules) && rules.length > 0,
    )
  const hasCustomPermissions =
    toolPermissionContext.additionalWorkingDirectories.size > 0 ||
    hasRuleEntries(toolPermissionContext.alwaysAllowRules) ||
    hasRuleEntries(toolPermissionContext.alwaysDenyRules) ||
    hasRuleEntries(toolPermissionContext.alwaysAskRules)
  const shouldAutoBypassForNonInteractive =
    !normalizedPermissionMode &&
    toolPermissionContext.mode === 'default' &&
    !hasCustomPermissions &&
    !args.safe &&
    args.normalizedInputFormat !== 'stream-json' &&
    !args.normalizedPermissionPromptTool
  if (shouldAutoBypassForNonInteractive) {
    updates.push({
      type: 'setMode',
      destination: 'cliArg',
      mode: 'bypassPermissions',
    })
  }
  if (normalizedPermissionMode) {
    const normalized =
      normalizedPermissionMode === 'delegate'
        ? 'default'
        : normalizedPermissionMode
    if (!isPermissionMode(normalized)) {
      console.error(
        `Error: Invalid --permission-mode "${normalizedPermissionMode}". Expected one of: acceptEdits, bypassPermissions, default, delegate, dontAsk, plan`,
      )
      finishHeadlessRun(headlessRun, {
        isError: true,
        resultSubtype: 'error_invalid_permission_mode',
        error: `Invalid --permission-mode "${normalizedPermissionMode}"`,
      })
      process.exit(1)
    }
    updates.push({
      type: 'setMode',
      destination: 'cliArg',
      mode: normalized,
    })
  }

  if (args.dangerouslySkipPermissions) {
    updates.push({
      type: 'setMode',
      destination: 'cliArg',
      mode: 'bypassPermissions',
    })
  }

  if (updates.length > 0) {
    toolPermissionContext = applyToolPermissionContextUpdates(
      toolPermissionContext,
      updates,
    )
  }

  const printOptions = {
    commands: args.commands,
    tools: args.toolsForPrint,
    verbose: true,
    safeMode: Boolean(args.safe),
    maxTurns:
      typeof args.maxTurns === 'number' &&
      Number.isFinite(args.maxTurns) &&
      args.maxTurns > 0
        ? Math.trunc(args.maxTurns)
        : undefined,
    maxBudgetUsd:
      typeof args.maxBudgetUsd === 'number' ? args.maxBudgetUsd : undefined,
    ...(shouldIncludePartialMessages
      ? {
          onStreamEvent: (event: unknown) => {
            writeSdkLine({
              type: 'stream_event',
              event,
              session_id: sessionIdForSdk,
              parent_tool_use_id: null,
              uuid: randomUUID(),
            })
          },
        }
      : {}),
    forkNumber: 0,
    messageLogName: 'unused',
    maxThinkingTokens:
      typeof args.maxThinkingTokens === 'number' &&
      Number.isFinite(args.maxThinkingTokens) &&
      args.maxThinkingTokens >= 0
        ? Math.trunc(args.maxThinkingTokens)
        : 0,
    persistSession: args.sessionPersistence !== false,
    toolPermissionContext,
    mcpClients: args.mcpClients,
    shouldAvoidPermissionPrompts: args.normalizedInputFormat !== 'stream-json',
    model:
      typeof args.model === 'string' && args.model.trim()
        ? args.model.trim()
        : undefined,
    getCustomSystemPromptAdditions: getOutputStyleSystemPromptAdditions,
  }

  const availableTools = args.toolsForPrint.map(t => t.name)
  const slashCommands =
    args.disableSlashCommands === true
      ? undefined
      : args.commands
          .filter(c => !c.isHidden)
          .map(c => `/${c.userFacingName()}`)

  const initMsg = makeSdkInitMessage({
    sessionId: sessionIdForSdk,
    cwd: args.cwd,
    tools: availableTools,
    slashCommands,
    uuid: randomUUID(),
  })

  if (args.normalizedOutputFormat === 'stream-json') {
    writeSdkLine(initMsg)
  } else {
    sdkMessages.push(initMsg)
  }

  let activeTurnAbortController: AbortController | null = null
  const structured =
    args.normalizedInputFormat === 'stream-json'
      ? new KodeAgentStructuredStdio(process.stdin, process.stdout, {
          onInterrupt: () => {
            activeTurnAbortController?.abort()
          },
          onControlRequest: createPrintControlRequestHandler({
            mcpClients: args.mcpClients,
            setPermissionMode: mode => {
              if (printOptions.toolPermissionContext) {
                printOptions.toolPermissionContext.mode = mode
              }
            },
            setModel: nextModel => {
              printOptions.model = nextModel
            },
            setMaxThinkingTokens: tokens => {
              printOptions.maxThinkingTokens = tokens
            },
          }),
        })
      : null

  if (structured) structured.start()

  const permissionTimeoutMs = (() => {
    const raw = process.env.KODE_STDIO_PERMISSION_TIMEOUT_MS
    const n = raw ? Number(raw) : NaN
    return Number.isFinite(n) && n > 0 ? n : 30_000
  })()

  const canUseTool =
    args.normalizedPermissionPromptTool === 'stdio' && structured
      ? createStdioPermissionPromptCanUseTool({
          structured,
          permissionTimeoutMs,
          projectDir: args.cwd,
          baseCanUseTool: hasPermissionsToUseTool,
          getToolPermissionContext: () => printOptions.toolPermissionContext,
          setToolPermissionContext: next => {
            printOptions.toolPermissionContext = next
          },
          applyToolPermissionContextUpdates,
          persistToolPermissionUpdateToDisk,
        })
      : hasPermissionsToUseTool

  if (args.normalizedInputFormat === 'stream-json') {
    if (!structured) {
      console.error('Error: Structured stdin is not available')
      finishHeadlessRun(headlessRun, {
        isError: true,
        resultSubtype: 'error_invalid_input',
        error: 'Structured stdin is not available',
      })
      process.exit(1)
    }

    const { runKodeAgentStreamJsonSession } =
      await import('#protocol/utils/kodeAgentStreamJsonSession')

    const exitAfterStopDelayMs = (() => {
      const raw =
        process.env.KODE_EXIT_AFTER_STOP_DELAY ??
        process.env[LEGACY_ENV.codeExitAfterStopDelay]
      if (!raw) return null
      const n = parseInt(String(raw), 10)
      return Number.isFinite(n) && n > 0 ? n : null
    })()

    let idleTimer: ReturnType<typeof setTimeout> | null = null
    let idleStartedAt = 0
    let isProcessing = false

    const stopIdleTimer = () => {
      if (!idleTimer) return
      clearTimeout(idleTimer)
      idleTimer = null
    }

    const startIdleTimer = () => {
      if (exitAfterStopDelayMs === null) return
      stopIdleTimer()
      idleStartedAt = Date.now()
      idleTimer = setTimeout(() => {
        const elapsed = Date.now() - idleStartedAt
        if (isProcessing) return
        if (elapsed < exitAfterStopDelayMs) return
        process.stderr.write(
          `Exiting after ${exitAfterStopDelayMs}ms of idle time\n`,
        )
        // Best-effort journal must close before process.exit; otherwise the
        // durable agent run is left `running` until restart reconciliation.
        finishHeadlessRun(headlessRun, {
          totalCostUsd: getTotalCost(),
          durationMs: Date.now() - startedAt,
          durationApiMs: getTotalAPIDuration(),
        })
        process.exit(0)
      }, exitAfterStopDelayMs)
    }

    const isRecord = (value: unknown): value is Record<string, unknown> =>
      Boolean(value) && typeof value === 'object' && !Array.isArray(value)

    const normalizeUserContent = (
      content: string | unknown[],
    ): string | ContentBlockParam[] => {
      if (typeof content === 'string') return content
      const blocks: ContentBlockParam[] = []
      for (const block of content) {
        if (!isRecord(block) || typeof block.type !== 'string') continue
        const normalized =
          block.type === 'server_tool_use' || block.type === 'mcp_tool_use'
            ? { ...block, type: 'tool_use' }
            : block
        blocks.push(normalized as unknown as ContentBlockParam)
      }
      return blocks
    }

    await runKodeAgentStreamJsonSession({
      structured,
      query,
      makeUserMessage: (content, uuidOverride) => {
        const msg = createUserMessage(normalizeUserContent(content))
        if (uuidOverride && isUuidValue(uuidOverride)) msg.uuid = uuidOverride
        return msg
      },
      writeSdkLine: obj => writeSdkLine(obj),
      sessionId: sessionIdForSdk,
      systemPrompt,
      jsonSchema: parsedJsonSchema,
      context: ctx,
      canUseTool,
      toolUseContextBase: {
        options: printOptions,
        messageId: undefined,
        readFileTimestamps: {},
        setToolJSX: () => {},
      },
      replayUserMessages: Boolean(args.replayUserMessages),
      getTotalCostUsd: () => getTotalCost(),
      getTotalApiDurationMs: () => getTotalAPIDuration(),
      maxBudgetUsd: args.maxBudgetUsd,
      onProcessingStateChange:
        exitAfterStopDelayMs !== null
          ? processing => {
              isProcessing = processing
              if (processing) {
                stopIdleTimer()
                return
              }
              startIdleTimer()
            }
          : undefined,
      onActiveTurnAbortControllerChanged: controller => {
        activeTurnAbortController = controller
      },
      initialMessages: args.initialMessages,
    })

    finishHeadlessRun(headlessRun, {
      totalCostUsd: getTotalCost(),
      durationMs: Date.now() - startedAt,
      durationApiMs: getTotalAPIDuration(),
    })
    process.exit(0)
  }

  addToHistory(args.inputPrompt)
  const userMsg = createUserMessage(args.inputPrompt)
  const baseMessages = [...(args.initialMessages ?? []), userMsg]
  if (typeof args.maxThinkingTokens !== 'number') {
    const { getMaxThinkingTokens } = await import('#core/utils/thinking')
    printOptions.maxThinkingTokens = await getMaxThinkingTokens(baseMessages)
  }

  const sdkUser = kodeMessageToSdkMessage(userMsg, sessionIdForSdk)
  if (sdkUser) {
    if (args.normalizedOutputFormat === 'stream-json') {
      writeSdkLine(sdkUser)
    } else {
      sdkMessages.push(sdkUser)
    }
  }

  const abortController = new AbortController()
  await runSingleTurnPrint({
    runTurn: turnArgs =>
      runTurn({
        messages: turnArgs.messages,
        systemPrompt: turnArgs.systemPrompt,
        context: turnArgs.context,
        canUseTool: turnArgs.canUseTool,
        toolUseContext: turnArgs.toolUseContext,
      }),
    kodeMessageToSdkMessage,
    makeSdkResultMessage,
    messages: baseMessages,
    systemPrompt,
    context: ctx,
    canUseTool,
    toolUseContext: {
      options: printOptions,
      abortController,
      messageId: undefined,
      readFileTimestamps: {},
      setToolJSX: () => {},
    },
    sessionId: sessionIdForSdk,
    outputFormat: args.normalizedOutputFormat,
    writeSdkLine,
    sdkMessages,
    startedAt,
    getTotalCostUsd: () => getTotalCost(),
    getTotalApiDurationMs: () => getTotalAPIDuration(),
    maxBudgetUsd: args.maxBudgetUsd,
    jsonSchema: parsedJsonSchema,
    verbose: args.verbose,
    headlessRun,
  })
}
