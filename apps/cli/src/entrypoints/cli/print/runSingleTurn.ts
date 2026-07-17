import type { CanUseToolFn } from '#core/permissions/canUseTool'
import type { Message } from '#core/query'
import type { QueryToolUseContext } from '@kode/engine'
import { MaxBudgetUsdExceededError } from '#core/errors/maxBudgetUsd'
import { MaxTurnsExceededError } from '#core/errors/maxTurns'
import { randomUUID } from 'crypto'
import {
  finishHeadlessRun,
  type HeadlessRunTracker,
} from './headlessRunTelemetry'
import { beginPrintModeSignalAbortHandling } from './signalState'

const PRINT_MODE_ABORT_SIGNALS: NodeJS.Signals[] = [
  'SIGINT',
  'SIGTERM',
  'SIGBREAK',
]

function installPrintModeSignalAbort(
  abortController: AbortController,
): () => void {
  const endPrintModeSignalAbortHandling = beginPrintModeSignalAbortHandling()
  const abort = () => {
    abortController.abort()
  }

  for (const signal of PRINT_MODE_ABORT_SIGNALS) {
    process.prependListener(signal, abort)
  }

  return () => {
    for (const signal of PRINT_MODE_ABORT_SIGNALS) {
      process.removeListener(signal, abort)
    }
    endPrintModeSignalAbortHandling()
  }
}

type RunTurnFn = (args: {
  messages: Message[]
  canUseTool: CanUseToolFn
  toolUseContext: QueryToolUseContext
  systemPrompt: string[]
  context: { [k: string]: string }
}) => AsyncIterable<Message>

type KodeMessageToSdkMessageFn = (
  message: Message,
  sessionId: string,
) => unknown | null

type MakeSdkResultMessageFn = (args: {
  sessionId: string
  result?: string
  structuredOutput?: Record<string, unknown>
  numTurns: number
  usage?: unknown
  totalCostUsd: number
  durationMs: number
  durationApiMs: number
  isError: boolean
  subtype?: string
  uuid?: string
}) => unknown

function isApiErrorAssistantMessage(message: Message | null): boolean {
  return message?.type === 'assistant' && message.isApiErrorMessage === true
}

export async function runSingleTurnPrint(args: {
  runTurn: RunTurnFn
  kodeMessageToSdkMessage: KodeMessageToSdkMessageFn
  makeSdkResultMessage: MakeSdkResultMessageFn
  messages: Message[]
  systemPrompt: string[]
  context: { [k: string]: string }
  canUseTool: CanUseToolFn
  toolUseContext: QueryToolUseContext
  sessionId: string
  outputFormat: 'json' | 'stream-json'
  writeSdkLine: (obj: unknown) => void
  sdkMessages: unknown[]
  startedAt: number
  getTotalCostUsd: () => number
  getTotalApiDurationMs: () => number
  maxBudgetUsd?: number
  jsonSchema: Record<string, unknown> | null
  verbose: boolean | undefined
  headlessRun?: HeadlessRunTracker | null
}): Promise<void> {
  let lastAssistant: Message | null = null
  let queryError: unknown = null
  const cleanupSignalAbort = installPrintModeSignalAbort(
    args.toolUseContext.abortController,
  )

  try {
    for await (const m of args.runTurn({
      messages: args.messages,
      systemPrompt: args.systemPrompt,
      context: args.context,
      canUseTool: args.canUseTool,
      toolUseContext: args.toolUseContext,
    })) {
      if (m.type === 'assistant') lastAssistant = m
      const sdk = args.kodeMessageToSdkMessage(m, args.sessionId)
      if (!sdk) continue

      if (args.outputFormat === 'stream-json') args.writeSdkLine(sdk)
      else args.sdkMessages.push(sdk)
    }
  } catch (e) {
    try {
      args.toolUseContext.abortController.abort()
    } catch {}
    queryError = e
  } finally {
    cleanupSignalAbort()
  }

  const totalCostUsd = args.getTotalCostUsd()
  const turnsFromContext = (
    args.toolUseContext as unknown as { turnCount?: unknown }
  ).turnCount
  const numTurns = (() => {
    if (typeof turnsFromContext !== 'number') return 0
    if (!Number.isFinite(turnsFromContext) || turnsFromContext < 0) return 0
    return Math.trunc(turnsFromContext)
  })()

  const budgetExceeded =
    typeof args.maxBudgetUsd === 'number' &&
    Number.isFinite(args.maxBudgetUsd) &&
    args.maxBudgetUsd > 0 &&
    totalCostUsd >= args.maxBudgetUsd

  const maxTurnsExceeded = queryError instanceof MaxTurnsExceededError

  const textFromAssistant =
    lastAssistant && lastAssistant.type === 'assistant'
      ? (() => {
          const blocks = lastAssistant.message?.content ?? []
          const found = blocks.find(block => {
            if (!block || typeof block !== 'object') return false
            if (
              !('type' in block) ||
              (block as { type?: unknown }).type !== 'text'
            )
              return false
            const record = block as unknown as Record<string, unknown>
            return typeof record.text === 'string'
          })
          if (!found) return undefined
          return (found as unknown as Record<string, unknown>).text as string
        })()
      : undefined

  let text =
    typeof textFromAssistant === 'string'
      ? textFromAssistant
      : queryError instanceof Error
        ? queryError.message
        : queryError
          ? String(queryError)
          : ''
  const hasApiErrorAssistant = isApiErrorAssistantMessage(lastAssistant)

  let structuredOutput: Record<string, unknown> | undefined
  if (
    args.jsonSchema &&
    !queryError &&
    !hasApiErrorAssistant &&
    !budgetExceeded &&
    !maxTurnsExceeded
  ) {
    try {
      const raw = typeof textFromAssistant === 'string' ? textFromAssistant : ''
      const fenced = raw.trim()
      const unfenced = (() => {
        const m = fenced.match(/^```(?:json)?\\s*([\\s\\S]*?)\\s*```$/i)
        return m ? m[1]!.trim() : fenced
      })()

      const parsed = JSON.parse(unfenced)
      const { default: Ajv } = await import('ajv')
      const ajv = new Ajv({ allErrors: true, strict: false })
      const validate = ajv.compile(args.jsonSchema)
      const ok = validate(parsed)
      if (!ok) {
        const errorText =
          typeof ajv.errorsText === 'function'
            ? ajv.errorsText(validate.errors, { separator: '; ' })
            : JSON.stringify(validate.errors ?? [])
        throw new Error(
          `Structured output failed JSON schema validation: ${errorText}`,
        )
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('Structured output must be a JSON object')
      }
      structuredOutput = parsed as Record<string, unknown>
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      queryError = new Error(msg)
      text = msg
    }
  }

  const usage =
    lastAssistant && lastAssistant.type === 'assistant'
      ? lastAssistant.message?.usage
      : undefined
  const durationMs = Date.now() - args.startedAt

  const shouldReturnMaxTurnsExceeded = maxTurnsExceeded
  const shouldReturnBudgetExceeded =
    !shouldReturnMaxTurnsExceeded &&
    (budgetExceeded || queryError instanceof MaxBudgetUsdExceededError)
  const shouldReturnDegradedApiError =
    !queryError &&
    !shouldReturnBudgetExceeded &&
    !shouldReturnMaxTurnsExceeded &&
    hasApiErrorAssistant

  const resultNumTurns = (() => {
    if (
      shouldReturnMaxTurnsExceeded &&
      queryError instanceof MaxTurnsExceededError
    ) {
      return queryError.turnCount
    }
    return Math.max(numTurns, 1)
  })()

  const isError =
    shouldReturnBudgetExceeded || shouldReturnMaxTurnsExceeded
      ? false
      : Boolean(queryError) || shouldReturnDegradedApiError
  // SDK result subtype vocabulary (keep historical success/limit semantics).
  const resultSubtype = shouldReturnMaxTurnsExceeded
    ? 'error_max_turns'
    : shouldReturnBudgetExceeded
      ? 'error_max_budget_usd'
      : shouldReturnDegradedApiError
        ? 'error_during_execution'
        : undefined
  // Durable telemetry uses structured error subtypes whenever the run failed.
  const telemetrySubtype =
    resultSubtype ??
    (isError || queryError ? 'error_during_execution' : undefined)

  const resultMsg = args.makeSdkResultMessage({
    sessionId: args.sessionId,
    result:
      shouldReturnBudgetExceeded || shouldReturnMaxTurnsExceeded
        ? undefined
        : String(text),
    structuredOutput:
      shouldReturnBudgetExceeded || shouldReturnMaxTurnsExceeded
        ? undefined
        : structuredOutput,
    numTurns: resultNumTurns,
    usage,
    totalCostUsd,
    durationMs,
    durationApiMs: args.getTotalApiDurationMs(),
    isError,
    subtype: resultSubtype,
    uuid: randomUUID(),
  })

  finishHeadlessRun(args.headlessRun, {
    isError: Boolean(telemetrySubtype),
    resultSubtype: telemetrySubtype,
    error: queryError ?? (shouldReturnDegradedApiError ? text : undefined),
    numTurns: resultNumTurns,
    totalCostUsd,
    durationMs,
    durationApiMs: args.getTotalApiDurationMs(),
  })

  if (args.outputFormat === 'stream-json') {
    args.writeSdkLine(resultMsg)
    process.exit((resultMsg as any)?.is_error ? 1 : 0)
  }

  args.sdkMessages.push(resultMsg)
  if (args.verbose) {
    process.stdout.write(`${JSON.stringify(args.sdkMessages, null, 2)}\n`)
  } else {
    process.stdout.write(`${JSON.stringify(resultMsg, null, 2)}\n`)
  }
  process.exit((resultMsg as any)?.is_error ? 1 : 0)
}

export const __installPrintModeSignalAbortForTests = installPrintModeSignalAbort
