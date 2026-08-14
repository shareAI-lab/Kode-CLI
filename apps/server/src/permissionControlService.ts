import { resolve } from 'node:path'

import {
  applyToolPermissionContextUpdate,
  canUserModifyToolPermissionUpdate,
  type ToolPermissionContext,
  type ToolPermissionContextUpdate,
} from '@kode/types/toolPermissionContext'
import { isPersistableToolPermissionDestination } from '@kode/types/toolPermissionContext'
import {
  loadToolPermissionContextFromDisk,
  persistToolPermissionUpdateToDisk,
} from '@kode/core/utils/permissions/toolPermissionSettings'
import type {
  DaemonPermissionSnapshot,
  DaemonPermissionUpdate,
} from '@kode/protocol'

import { appendPermissionAuditRecord } from './permissionAuditStore'
import type { SessionRegistry } from './sessionRegistry'
import type { DaemonSession } from './ws/types'

export type PermissionControlFailure =
  | 'not_found'
  | 'session_required'
  | 'unsupported_destination'
  | 'policy_locked'
  | 'bypass_unavailable'
  | 'persistence_failed'

export type PermissionControlResult<T> =
  { ok: true; value: T } | { ok: false; reason: PermissionControlFailure }

type PermissionControlDependencies = {
  loadContext: (args: {
    projectDir: string
    isBypassPermissionsModeAvailable: boolean
  }) => ToolPermissionContext
  persistUpdate: (args: {
    update: ToolPermissionContextUpdate
    projectDir: string
  }) => { persisted: boolean }
  audit: (args: {
    cwd: string
    sessionId: string | null
    outcome: 'applied' | 'rejected'
    update: ToolPermissionContextUpdate | null
    reason?: string
  }) => void
}

const SERVER_MUTABLE_DESTINATIONS = new Set([
  'session',
  'localSettings',
  'userSettings',
  'projectSettings',
])

function contextToSnapshot(args: {
  context: ToolPermissionContext
  source: 'runtime' | 'disk'
  sessionId: string | null
}): DaemonPermissionSnapshot {
  const toRules = (
    rules: ToolPermissionContext['alwaysAllowRules'],
  ): Record<string, string[]> =>
    Object.fromEntries(
      Object.entries(rules).map(([destination, values]) => [
        destination,
        [...(values ?? [])],
      ]),
    )

  return {
    source: args.source,
    sessionId: args.sessionId,
    mode: args.context.mode,
    isBypassPermissionsModeAvailable:
      args.context.isBypassPermissionsModeAvailable,
    additionalWorkingDirectories: Array.from(
      args.context.additionalWorkingDirectories.values(),
    ).map(entry => ({ path: entry.path, source: entry.source })),
    rules: {
      allow: toRules(args.context.alwaysAllowRules),
      deny: toRules(args.context.alwaysDenyRules),
      ask: toRules(args.context.alwaysAskRules),
    },
  }
}

function defaultDependencies(): PermissionControlDependencies {
  return {
    loadContext: loadToolPermissionContextFromDisk,
    persistUpdate: persistToolPermissionUpdateToDisk,
    audit: appendPermissionAuditRecord,
  }
}

function asCoreUpdate(
  update: DaemonPermissionUpdate,
): ToolPermissionContextUpdate {
  // The protocol schema is the runtime boundary; the structural cast keeps the
  // protocol package independent from @kode/core's internal type aliases.
  return update as ToolPermissionContextUpdate
}

/**
 * Applies daemon permission changes through the same context primitives used by
 * CLI and ACP. It never resolves or edits an in-flight approval request; a
 * current turn keeps its captured context, while future tool decisions see the
 * refreshed session context.
 */
export class PermissionControlService {
  private readonly deps: PermissionControlDependencies

  constructor(
    private readonly sessionRegistry: SessionRegistry,
    dependencies: Partial<PermissionControlDependencies> = {},
  ) {
    this.deps = { ...defaultDependencies(), ...dependencies }
  }

  get(args: {
    cwd: string
    sessionId?: string
  }): PermissionControlResult<DaemonPermissionSnapshot> {
    const cwd = resolve(args.cwd)
    if (args.sessionId) {
      const session = this.findSession({ cwd, sessionId: args.sessionId })
      if (!session) return { ok: false, reason: 'not_found' }
      return {
        ok: true,
        value: contextToSnapshot({
          context: session.toolPermissionContext,
          source: 'runtime',
          sessionId: session.sessionId,
        }),
      }
    }

    return {
      ok: true,
      value: contextToSnapshot({
        context: this.loadDiskContext(cwd),
        source: 'disk',
        sessionId: null,
      }),
    }
  }

  update(args: {
    cwd: string
    sessionId?: string
    update: DaemonPermissionUpdate
  }): PermissionControlResult<{
    permission: DaemonPermissionSnapshot
    persisted: boolean
    refreshedSessionIds: string[]
    inflightApprovalCount: number
  }> {
    const cwd = resolve(args.cwd)
    const update = asCoreUpdate(args.update)
    const session = args.sessionId
      ? this.findSession({ cwd, sessionId: args.sessionId })
      : null
    if (args.sessionId && !session) {
      return this.reject({
        cwd,
        sessionId: args.sessionId,
        update,
        reason: 'not_found',
      })
    }

    const policyFailure = this.validateUpdate({
      update,
      session,
      cwd,
    })
    if (policyFailure) {
      return this.reject({
        cwd,
        sessionId: session?.sessionId ?? null,
        update,
        reason: policyFailure,
      })
    }

    const persisted =
      isPersistableToolPermissionDestination(update.destination) &&
      update.type !== 'setMode'
    if (persisted) {
      try {
        if (!this.deps.persistUpdate({ update, projectDir: cwd }).persisted) {
          return this.reject({
            cwd,
            sessionId: session?.sessionId ?? null,
            update,
            reason: 'persistence_failed',
          })
        }
      } catch {
        return this.reject({
          cwd,
          sessionId: session?.sessionId ?? null,
          update,
          reason: 'persistence_failed',
        })
      }
    }

    const targets =
      update.destination === 'session'
        ? session
          ? [session]
          : []
        : this.sessionRegistry.listForCwd(cwd)
    for (const target of targets) {
      target.toolPermissionContext = applyToolPermissionContextUpdate(
        target.toolPermissionContext,
        update,
      )
    }

    const responseContext = session
      ? session.toolPermissionContext
      : persisted
        ? this.loadDiskContext(cwd)
        : applyToolPermissionContextUpdate(this.loadDiskContext(cwd), update)
    const responseSource = session ? 'runtime' : 'disk'
    const inflightApprovalCount = targets.reduce(
      (count, target) => count + target.inflightPermissionRequests.size,
      0,
    )
    this.safeAudit({
      cwd,
      sessionId: session?.sessionId ?? null,
      outcome: 'applied',
      update,
    })

    return {
      ok: true,
      value: {
        permission: contextToSnapshot({
          context: responseContext,
          source: responseSource,
          sessionId: session?.sessionId ?? null,
        }),
        persisted,
        refreshedSessionIds: targets.map(target => target.sessionId),
        inflightApprovalCount,
      },
    }
  }

  private loadDiskContext(cwd: string): ToolPermissionContext {
    return this.deps.loadContext({
      projectDir: cwd,
      isBypassPermissionsModeAvailable: true,
    })
  }

  private findSession(args: {
    cwd: string
    sessionId: string
  }): DaemonSession | null {
    const session = this.sessionRegistry.get(args.sessionId)
    if (!session || resolve(session.cwd) !== args.cwd) return null
    return session
  }

  private validateUpdate(args: {
    cwd: string
    session: DaemonSession | null
    update: ToolPermissionContextUpdate
  }): PermissionControlFailure | null {
    const { update, session } = args
    if (update.destination === 'policySettings') return 'policy_locked'
    if (!canUserModifyToolPermissionUpdate(update)) return 'policy_locked'
    if (!SERVER_MUTABLE_DESTINATIONS.has(update.destination)) {
      return 'unsupported_destination'
    }
    if (update.destination === 'session' && !session) return 'session_required'
    if (update.type === 'setMode' && update.destination !== 'session') {
      return 'unsupported_destination'
    }
    if (
      update.type === 'setMode' &&
      update.mode === 'bypassPermissions' &&
      !(session?.toolPermissionContext ?? this.loadDiskContext(args.cwd))
        .isBypassPermissionsModeAvailable
    ) {
      return 'bypass_unavailable'
    }
    return null
  }

  private reject(args: {
    cwd: string
    sessionId: string | null
    update: ToolPermissionContextUpdate | null
    reason: PermissionControlFailure
  }): PermissionControlResult<never> {
    this.safeAudit({
      cwd: args.cwd,
      sessionId: args.sessionId,
      outcome: 'rejected',
      update: args.update,
      reason: args.reason,
    })
    return { ok: false, reason: args.reason }
  }

  private safeAudit(
    args: Parameters<PermissionControlDependencies['audit']>[0],
  ): void {
    try {
      this.deps.audit(args)
    } catch {
      // Audit is observational and must not mutate permission semantics.
    }
  }
}
