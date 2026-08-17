import { createHash } from 'node:crypto'
import { appendFileSync, mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { getKodeRoot } from '@kode/config/dataRoots'
import type { ToolPermissionContextUpdate } from '@kode/types/toolPermissionContext'

export type PermissionAuditRecord = {
  version: 1
  at: string
  workspaceHash: string
  sessionId: string | null
  outcome: 'applied' | 'rejected'
  update: ToolPermissionContextUpdate | null
  reason?: string
}

function workspaceHash(cwd: string): string {
  return createHash('sha256').update(resolve(cwd)).digest('hex').slice(0, 24)
}

export function getPermissionAuditPath(cwd: string): string {
  return join(getKodeRoot(), 'permission-audit', `${workspaceHash(cwd)}.jsonl`)
}

/**
 * Audit writes are deliberately best-effort. They never grant or reject a
 * permission change; the service applies its policy before writing the record.
 */
export function appendPermissionAuditRecord(
  record: Omit<PermissionAuditRecord, 'version' | 'at' | 'workspaceHash'> & {
    cwd: string
  },
): void {
  try {
    const path = getPermissionAuditPath(record.cwd)
    mkdirSync(join(getKodeRoot(), 'permission-audit'), {
      recursive: true,
      mode: 0o700,
    })
    const value: PermissionAuditRecord = {
      version: 1,
      at: new Date().toISOString(),
      workspaceHash: workspaceHash(record.cwd),
      sessionId: record.sessionId,
      outcome: record.outcome,
      update: record.update,
      ...(record.reason ? { reason: record.reason } : {}),
    }
    appendFileSync(path, `${JSON.stringify(value)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    })
  } catch {
    // A degraded local audit store must not alter enforcement semantics.
  }
}
