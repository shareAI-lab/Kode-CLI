import {
  createDurableRun,
  finishDurableRun,
  heartbeatDurableRun,
} from '#core/runs'
import type { AgentSupervisor } from '#core/utils/agentSupervisor'
import { runWithCwdScope } from '#runtime/cwd'
import { runWithKodeAgentSessionForkInfo } from '#protocol/utils/kodeAgentSessionForkInfo'
import { runWithKodeAgentSessionId } from '#protocol/utils/kodeAgentSessionId'

import type { PreparedTaskToolRun } from './callTypes'

type TerminalStatus = 'completed' | 'failed' | 'cancelled'

const HEARTBEAT_INTERVAL_MS = 1_000

/**
 * One owner for timeout, durable journaling, and supervisor release across
 * every background-entry path (explicit background and Ctrl+B promotion).
 */
export class BackgroundAgentLifecycle {
  private readonly agentId: string
  private readonly supervisor: AgentSupervisor
  private readonly durableEnabled: boolean
  private lastHeartbeatAt = 0
  private finished = false

  constructor(args: {
    agentId: string
    description: string
    cwd: string
    sessionId: string
    outputFile: string
    abortController: AbortController
    supervisor: AgentSupervisor
  }) {
    this.agentId = args.agentId
    this.supervisor = args.supervisor
    this.durableEnabled = process.env.NODE_ENV !== 'test'
    this.supervisor.attachAbortController(args.abortController)

    if (this.durableEnabled) {
      try {
        createDurableRun({
          id: args.agentId,
          kind: 'agent',
          cwd: args.cwd,
          sessionId: args.sessionId,
          command: args.description,
          outputFile: args.outputFile,
        })
        this.lastHeartbeatAt = Date.now()
      } catch {
        // In-memory execution remains usable if best-effort journaling fails.
      }
    }
  }

  heartbeat(): void {
    if (!this.durableEnabled || this.finished) return
    const now = Date.now()
    if (now - this.lastHeartbeatAt < HEARTBEAT_INTERVAL_MS) return
    this.lastHeartbeatAt = now
    try {
      heartbeatDurableRun({ id: this.agentId, now })
    } catch {
      // Best-effort only.
    }
  }

  finish(status: TerminalStatus, error?: string): void {
    if (this.finished) return
    this.finished = true
    if (this.durableEnabled) {
      try {
        finishDurableRun({
          id: this.agentId,
          status,
          ...(error ? { error } : {}),
        })
      } catch {
        // Best-effort only.
      }
    }
    this.supervisor.release()
  }
}

/** Preserve workspace and session identity after the parent daemon turn ends. */
export function runInPreparedAgentScope<T>(
  prepared: PreparedTaskToolRun,
  callback: () => T,
): T {
  return runWithCwdScope(
    prepared.cwd,
    () =>
      runWithKodeAgentSessionId(prepared.sessionId, () =>
        runWithKodeAgentSessionForkInfo(prepared.sessionForkInfo, callback),
      ),
    prepared.originalCwd,
  )
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error(signal.aborted ? 'Agent run aborted' : 'Agent run stopped')
}

function closeIteratorBestEffort<T>(iterator: AsyncIterator<T, void>): void {
  try {
    const closing = iterator.return?.()
    if (closing) void Promise.resolve(closing).catch(() => {})
  } catch {
    // A transport may throw synchronously while closing. Cancellation must
    // still settle the caller and lifecycle owner without an unhandled error.
  }
}

/**
 * Stop awaiting a provider iterator even when the provider ignores its abort
 * signal. The iterator return is best-effort; lifecycle cleanup must not wait
 * for a non-cooperative transport.
 */
export function awaitAgentIteratorNext<T>(
  iterator: AsyncIterator<T, void>,
  pending: Promise<IteratorResult<T, void>>,
  signal: AbortSignal,
): Promise<IteratorResult<T, void>> {
  if (signal.aborted) {
    closeIteratorBestEffort(iterator)
    return Promise.reject(abortReason(signal))
  }

  return new Promise((resolve, reject) => {
    let settled = false
    const cleanup = () => signal.removeEventListener('abort', onAbort)
    const onAbort = () => {
      if (settled) return
      settled = true
      cleanup()
      closeIteratorBestEffort(iterator)
      reject(abortReason(signal))
    }

    signal.addEventListener('abort', onAbort, { once: true })
    pending.then(
      result => {
        if (settled) return
        settled = true
        cleanup()
        resolve(result)
      },
      error => {
        if (settled) return
        settled = true
        cleanup()
        reject(error)
      },
    )
  })
}
