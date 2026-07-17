import {
  createDurableRun,
  createHeadlessRunTelemetry,
  finishDurableRun,
  heartbeatDurableRun,
  type CreateHeadlessRunTelemetryArgs,
} from '#core/runs'
import { getKodeAgentSessionId } from '#protocol/utils/kodeAgentSessionId'

export type HeadlessRunStartSnapshot = Pick<
  CreateHeadlessRunTelemetryArgs,
  | 'inputFormat'
  | 'outputFormat'
  | 'promptChars'
  | 'toolCount'
  | 'model'
  | 'maxTurns'
  | 'maxBudgetUsd'
>

export type HeadlessRunTracker = {
  id: string
  startedAt: number
  heartbeat: ReturnType<typeof setInterval>
  snapshot: HeadlessRunStartSnapshot
  /** Optional journal root (tests / multi-root hosts). */
  storageRoot?: string
  finished?: boolean
}

const HEARTBEAT_INTERVAL_MS = 15_000

export type HeadlessRunOutcome = Pick<
  CreateHeadlessRunTelemetryArgs,
  | 'isError'
  | 'resultSubtype'
  | 'error'
  | 'numTurns'
  | 'totalCostUsd'
  | 'durationMs'
  | 'durationApiMs'
>

/**
 * Durable telemetry must never block an agent run. The persistent journal is
 * best effort, while the caller remains responsible for the actual result.
 */
export function startHeadlessRun(
  args: HeadlessRunStartSnapshot & { cwd: string; storageRoot?: string },
): HeadlessRunTracker | null {
  try {
    const run = createDurableRun({
      kind: 'agent',
      cwd: args.cwd,
      command: 'headless',
      sessionId: getKodeAgentSessionId(),
      ...(args.storageRoot ? { storageRoot: args.storageRoot } : {}),
    })
    const heartbeat = setInterval(() => {
      try {
        heartbeatDurableRun({
          id: run.id,
          ...(args.storageRoot ? { storageRoot: args.storageRoot } : {}),
        })
      } catch {
        // The best-effort journal cannot interrupt an active agent run.
      }
    }, HEARTBEAT_INTERVAL_MS)
    heartbeat.unref?.()
    const snapshot: HeadlessRunStartSnapshot = {
      inputFormat: args.inputFormat,
      outputFormat: args.outputFormat,
      promptChars: args.promptChars,
      toolCount: args.toolCount,
      ...(args.model?.trim() ? { model: args.model.trim() } : {}),
      ...(typeof args.maxTurns === 'number' ? { maxTurns: args.maxTurns } : {}),
      ...(typeof args.maxBudgetUsd === 'number'
        ? { maxBudgetUsd: args.maxBudgetUsd }
        : {}),
    }
    return {
      id: run.id,
      startedAt: run.createdAt,
      heartbeat,
      snapshot,
      ...(args.storageRoot ? { storageRoot: args.storageRoot } : {}),
    }
  } catch {
    return null
  }
}

/**
 * Idempotent finish for multi-exit print paths (normal completion, error, and
 * KODE_EXIT_AFTER_STOP_DELAY idle exit). Safe to call more than once.
 */
export function finishHeadlessRun(
  tracker: HeadlessRunTracker | null | undefined,
  outcome: HeadlessRunOutcome,
): void {
  if (!tracker || tracker.finished) return
  tracker.finished = true
  clearInterval(tracker.heartbeat)
  try {
    const telemetry = createHeadlessRunTelemetry({
      ...tracker.snapshot,
      numTurns: outcome.numTurns,
      totalCostUsd: outcome.totalCostUsd,
      durationMs: outcome.durationMs ?? Date.now() - tracker.startedAt,
      durationApiMs: outcome.durationApiMs,
      resultSubtype: outcome.resultSubtype,
      isError: outcome.isError,
      error: outcome.error,
    })
    finishDurableRun({
      id: tracker.id,
      status: telemetry.failure ? 'failed' : 'completed',
      ...(telemetry.failure ? { error: telemetry.failure.message } : {}),
      telemetry,
      ...(tracker.storageRoot ? { storageRoot: tracker.storageRoot } : {}),
    })
  } catch {
    // A telemetry write failure must not change the agent's outcome.
  }
}
