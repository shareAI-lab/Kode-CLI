import { createHash } from 'node:crypto'
import { appendFileSync, mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { getKodeRoot } from '@kode/config/dataRoots'
import type { DaemonAgentSource } from '@kode/protocol'

export type AgentAuditRecord = {
  version: 1
  at: string
  workspaceHash: string
  action: 'create' | 'update' | 'delete'
  source: DaemonAgentSource
  agentType: string
  outcome: 'applied' | 'rejected'
  revision: string | null
  changedFields: string[]
  systemPromptHash: string | null
  reason?: string
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

export function getAgentAuditPath(cwd: string): string {
  return join(
    getKodeRoot(),
    'agent-audit',
    `${hash(resolve(cwd)).slice(0, 24)}.jsonl`,
  )
}

/** Best-effort audit only; a degraded audit store never changes mutation policy. */
export function appendAgentAuditRecord(
  record: Omit<AgentAuditRecord, 'version' | 'at' | 'workspaceHash'> & {
    cwd: string
  },
): void {
  try {
    const directory = join(getKodeRoot(), 'agent-audit')
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    const value: AgentAuditRecord = {
      version: 1,
      at: new Date().toISOString(),
      workspaceHash: hash(resolve(record.cwd)).slice(0, 24),
      action: record.action,
      source: record.source,
      agentType: record.agentType,
      outcome: record.outcome,
      revision: record.revision,
      changedFields: [...record.changedFields],
      systemPromptHash: record.systemPromptHash,
      ...(record.reason ? { reason: record.reason } : {}),
    }
    appendFileSync(
      getAgentAuditPath(record.cwd),
      `${JSON.stringify(value)}\n`,
      {
        encoding: 'utf8',
        mode: 0o600,
      },
    )
  } catch {
    /* no-op */
  }
}
