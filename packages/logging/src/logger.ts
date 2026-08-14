import { randomUUID } from 'crypto'
import chalk from 'chalk'

import {
  DEBUG_VERBOSE_TERMINAL_LOG_LEVELS,
  LogLevel,
  TERMINAL_LOG_LEVELS,
} from './levels'
import { shouldLogWithDedupe } from './dedupe'
import { formatDataForTerminal } from './formatters'
import { isDebugMode, isDebugVerboseMode, isVerboseMode } from './mode'
import { terminalLog } from './terminal'
import { DEBUG_PATHS, STARTUP_TIMESTAMP, writeToFile } from './transports'
import type { LogEntry } from './types'
import { getKodeAgentSessionId } from '#protocol/utils/kodeAgentSessionId'

class RequestContext {
  public readonly id: string
  public readonly startTime: number
  private phases: Map<string, number> = new Map()

  constructor() {
    this.id = randomUUID().slice(0, 8)
    this.startTime = Date.now()
  }

  markPhase(phase: string) {
    this.phases.set(phase, Date.now() - this.startTime)
  }

  getPhaseTime(phase: string): number {
    return this.phases.get(phase) || 0
  }

  getAllPhases(): Record<string, number> {
    return Object.fromEntries(this.phases)
  }
}

const activeRequests = new Map<string, RequestContext>()
let currentRequest: RequestContext | null = null

function shouldShowInTerminal(level: LogLevel): boolean {
  if (!isDebugMode()) return false
  if (isDebugVerboseMode()) return DEBUG_VERBOSE_TERMINAL_LOG_LEVELS.has(level)
  return TERMINAL_LOG_LEVELS.has(level)
}

function logToTerminal(entry: LogEntry) {
  if (!shouldShowInTerminal(entry.level)) return

  const { level, phase, data, requestId, elapsed } = entry
  const timestamp = new Date().toISOString().slice(11, 23)

  let prefix = ''
  let color = chalk.gray

  switch (level) {
    case LogLevel.FLOW:
      prefix = '🔄'
      color = chalk.cyan
      break
    case LogLevel.API:
      prefix = '🌐'
      color = chalk.yellow
      break
    case LogLevel.STATE:
      prefix = '📊'
      color = chalk.blue
      break
    case LogLevel.ERROR:
      prefix = '❌'
      color = chalk.red
      break
    case LogLevel.WARN:
      prefix = '⚠️'
      color = chalk.yellow
      break
    case LogLevel.INFO:
      prefix = 'ℹ️'
      color = chalk.green
      break
    case LogLevel.TRACE:
      prefix = '📈'
      color = chalk.magenta
      break
    default:
      prefix = '🔍'
      color = chalk.gray
  }

  const reqId = requestId ? chalk.dim(`[${requestId}]`) : ''
  const elapsedStr = elapsed !== undefined ? chalk.dim(`+${elapsed}ms`) : ''
  const dataStr = formatDataForTerminal(data)

  terminalLog(
    `${color(`[${timestamp}]`)} ${prefix} ${color(phase)} ${reqId} ${dataStr} ${elapsedStr}`,
  )
}

export function debugLog(
  level: LogLevel,
  phase: string,
  data: unknown,
  requestId?: string,
) {
  if (!isDebugMode()) return
  if (!shouldLogWithDedupe(level, phase, data)) return

  const entry: LogEntry = {
    timestamp: new Date().toISOString(),
    level,
    phase,
    data,
    requestId: requestId || currentRequest?.id,
    elapsed: currentRequest ? Date.now() - currentRequest.startTime : undefined,
  }

  writeToFile(DEBUG_PATHS.detailed(), entry)

  switch (level) {
    case LogLevel.FLOW:
      writeToFile(DEBUG_PATHS.flow(), entry)
      break
    case LogLevel.API:
      writeToFile(DEBUG_PATHS.api(), entry)
      break
    case LogLevel.STATE:
      writeToFile(DEBUG_PATHS.state(), entry)
      break
  }

  logToTerminal(entry)
}

export const debug = {
  flow: (phase: string, data: unknown, requestId?: string) =>
    debugLog(LogLevel.FLOW, phase, data, requestId),

  api: (phase: string, data: unknown, requestId?: string) =>
    debugLog(LogLevel.API, phase, data, requestId),

  state: (phase: string, data: unknown, requestId?: string) =>
    debugLog(LogLevel.STATE, phase, data, requestId),

  info: (phase: string, data: unknown, requestId?: string) =>
    debugLog(LogLevel.INFO, phase, data, requestId),

  warn: (phase: string, data: unknown, requestId?: string) =>
    debugLog(LogLevel.WARN, phase, data, requestId),

  error: (phase: string, data: unknown, requestId?: string) =>
    debugLog(LogLevel.ERROR, phase, data, requestId),

  trace: (phase: string, data: unknown, requestId?: string) =>
    debugLog(LogLevel.TRACE, phase, data, requestId),

  ui: (phase: string, data: unknown, requestId?: string) =>
    debugLog(LogLevel.STATE, `UI_${phase}`, data, requestId),
}

export function startRequest(): RequestContext {
  const ctx = new RequestContext()
  currentRequest = ctx
  activeRequests.set(ctx.id, ctx)

  debug.flow('REQUEST_START', {
    requestId: ctx.id,
    activeRequests: activeRequests.size,
  })

  return ctx
}

export function endRequest(ctx?: RequestContext) {
  const request = ctx || currentRequest
  if (!request) return

  debug.flow('REQUEST_END', {
    requestId: request.id,
    totalTime: Date.now() - request.startTime,
    phases: request.getAllPhases(),
  })

  activeRequests.delete(request.id)
  if (currentRequest === request) currentRequest = null
}

export function getCurrentRequest(): RequestContext | null {
  return currentRequest
}

export function markPhase(phase: string, data?: unknown) {
  if (!currentRequest) return

  currentRequest.markPhase(phase)
  debug.flow(`PHASE_${phase.toUpperCase()}`, {
    requestId: currentRequest.id,
    elapsed: currentRequest.getPhaseTime(phase),
    data,
  })
}

export function logReminderEvent(
  eventType: string,
  reminderData: any,
  agentId?: string,
) {
  if (!isDebugMode()) return

  debug.info('REMINDER_EVENT_TRIGGERED', {
    eventType,
    agentId: agentId || 'default',
    reminderType: reminderData?.type || 'unknown',
    reminderCategory: reminderData?.category || 'general',
    reminderPriority: reminderData?.priority || 'medium',
    contentLength: reminderData?.content ? reminderData.content.length : 0,
    timestamp: Date.now(),
  })
}

export function initDebugLogger() {
  if (!isDebugMode()) return

  debug.info('DEBUG_LOGGER_INIT', {
    startupTimestamp: STARTUP_TIMESTAMP,
    sessionId: getKodeAgentSessionId(),
    debugPaths: {
      detailed: DEBUG_PATHS.detailed(),
      flow: DEBUG_PATHS.flow(),
      api: DEBUG_PATHS.api(),
      state: DEBUG_PATHS.state(),
    },
  })

  const terminalLevels = isDebugVerboseMode()
    ? Array.from(DEBUG_VERBOSE_TERMINAL_LOG_LEVELS).join(', ')
    : Array.from(TERMINAL_LOG_LEVELS).join(', ')

  terminalLog(
    chalk.dim(`[DEBUG] Terminal output filtered to: ${terminalLevels}`),
  )
  terminalLog(
    chalk.dim(`[DEBUG] Complete logs saved to: ${DEBUG_PATHS.base()}`),
  )
  if (!isDebugVerboseMode()) {
    terminalLog(
      chalk.dim(
        `[DEBUG] Use --debug-verbose for detailed system logs (FLOW, API, STATE)`,
      ),
    )
  }
}

export function getDebugInfo() {
  return {
    isDebugMode: isDebugMode(),
    isVerboseMode: isVerboseMode(),
    isDebugVerboseMode: isDebugVerboseMode(),
    startupTimestamp: STARTUP_TIMESTAMP,
    sessionId: getKodeAgentSessionId(),
    currentRequest: currentRequest?.id,
    activeRequests: Array.from(activeRequests.keys()),
    terminalLogLevels: isDebugVerboseMode()
      ? Array.from(DEBUG_VERBOSE_TERMINAL_LOG_LEVELS)
      : Array.from(TERMINAL_LOG_LEVELS),
    debugPaths: {
      detailed: DEBUG_PATHS.detailed(),
      flow: DEBUG_PATHS.flow(),
      api: DEBUG_PATHS.api(),
      state: DEBUG_PATHS.state(),
    },
  }
}
