import { redactSensitiveMemoryText } from '#core/memory/redaction'

import type {
  DurableRunFailureKind,
  DurableRunTelemetry,
} from './types'

const MAX_FAILURE_MESSAGE_LENGTH = 500

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function optionalNonNegativeInteger(value: unknown): number | undefined {
  const number = finiteNumber(value)
  if (number === undefined || number < 0) return undefined
  return Math.trunc(number)
}

function optionalText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed || undefined
}

function safeFailureMessage(value: unknown, fallback: string): string {
  const raw = value instanceof Error ? value.message : String(value ?? '')
  const normalized = raw.replace(/\s+/g, ' ').trim()
  if (!normalized) return fallback
  const redacted = redactSensitiveMemoryText(normalized).text
  return redacted.slice(0, MAX_FAILURE_MESSAGE_LENGTH) || fallback
}

/**
 * Map structured result subtypes only. Do not infer kind from free-text
 * messages — callers that know cancel/permission/provider should emit a
 * matching subtype at the print boundary.
 */
function failureKind(resultSubtype?: string): DurableRunFailureKind {
  if (resultSubtype?.startsWith('error_invalid_')) return 'configuration'
  if (resultSubtype === 'error_max_budget_usd') return 'budget_limit'
  if (resultSubtype === 'error_max_turns') return 'turn_limit'
  if (
    resultSubtype === 'error_cancelled' ||
    resultSubtype === 'cancelled'
  ) {
    return 'cancelled'
  }
  if (resultSubtype === 'error_permission') return 'permission'
  if (resultSubtype === 'error_provider') return 'provider'
  return 'execution'
}

function recommendation(kind: DurableRunFailureKind): {
  retryable: boolean
  recommendedAction: string
} {
  switch (kind) {
    case 'configuration':
      return {
        retryable: false,
        recommendedAction:
          'Correct the invalid headless option or schema before retrying.',
      }
    case 'budget_limit':
      return {
        retryable: false,
        recommendedAction:
          'Inspect progress, then raise --max-budget-usd only if the remaining work justifies it.',
      }
    case 'turn_limit':
      return {
        retryable: false,
        recommendedAction:
          'Inspect progress, then resume with a larger --max-turns or a narrower objective.',
      }
    case 'cancelled':
      return {
        retryable: true,
        recommendedAction:
          'Resume only after confirming that cancellation was intentional and the workspace is still safe.',
      }
    case 'permission':
      return {
        retryable: false,
        recommendedAction:
          'Review the denied tool or permission policy before retrying.',
      }
    case 'provider':
      return {
        retryable: true,
        recommendedAction:
          'Retry with backoff after checking provider status or selecting a fallback model.',
      }
    case 'execution':
      return {
        retryable: false,
        recommendedAction:
          'Inspect the failure details and workspace state before retrying.',
      }
  }
}

function defaultFailureMessage(resultSubtype?: string): string {
  if (resultSubtype === 'error_max_budget_usd') {
    return 'Headless run reached its configured budget limit.'
  }
  if (resultSubtype === 'error_max_turns') {
    return 'Headless run reached its configured turn limit.'
  }
  return 'Headless agent execution failed.'
}

export type CreateHeadlessRunTelemetryArgs = {
  inputFormat: string
  outputFormat: string
  promptChars: number
  toolCount: number
  model?: string
  maxTurns?: number
  maxBudgetUsd?: number
  numTurns?: number
  totalCostUsd?: number
  durationMs?: number
  durationApiMs?: number
  resultSubtype?: string
  isError?: boolean
  error?: unknown
}

export function createHeadlessRunTelemetry(
  args: CreateHeadlessRunTelemetryArgs,
): DurableRunTelemetry {
  const resultSubtype = optionalText(args.resultSubtype)
  const model = optionalText(args.model)
  const maxTurns = optionalNonNegativeInteger(args.maxTurns)
  const maxBudgetUsd = finiteNumber(args.maxBudgetUsd)
  const numTurns = optionalNonNegativeInteger(args.numTurns)
  const totalCostUsd = finiteNumber(args.totalCostUsd)
  const durationMs = optionalNonNegativeInteger(args.durationMs)
  const durationApiMs = optionalNonNegativeInteger(args.durationApiMs)
  const hasFailure =
    args.isError === true ||
    (resultSubtype !== undefined && resultSubtype.startsWith('error_'))
  const message = safeFailureMessage(
    args.error,
    defaultFailureMessage(resultSubtype),
  )
  const kind = hasFailure ? failureKind(resultSubtype) : undefined
  const guidance = kind ? recommendation(kind) : undefined

  return {
    mode: 'headless',
    inputFormat: args.inputFormat,
    outputFormat: args.outputFormat,
    promptChars: optionalNonNegativeInteger(args.promptChars) ?? 0,
    toolCount: optionalNonNegativeInteger(args.toolCount) ?? 0,
    ...(model ? { model } : {}),
    ...(maxTurns !== undefined ? { maxTurns } : {}),
    ...(maxBudgetUsd !== undefined ? { maxBudgetUsd } : {}),
    ...(numTurns !== undefined ? { numTurns } : {}),
    ...(totalCostUsd !== undefined ? { totalCostUsd } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
    ...(durationApiMs !== undefined ? { durationApiMs } : {}),
    ...(resultSubtype ? { resultSubtype } : {}),
    ...(kind && guidance
      ? {
          failure: {
            kind,
            message,
            retryable: guidance.retryable,
            recommendedAction: guidance.recommendedAction,
          },
        }
      : {}),
  }
}
