export type DurableRunKind = 'shell' | 'agent' | 'goal'
export type DurableRunStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'orphaned'
  | 'interrupted'

export type DurableRunProcessIdentity = {
  pid: number
  /** OS-provided process-start token; required before a shell run can be tailed after restart. */
  startToken: string
}

export type DurableRunFailureKind =
  | 'configuration'
  | 'budget_limit'
  | 'turn_limit'
  | 'cancelled'
  | 'permission'
  | 'provider'
  | 'execution'

export type DurableRunFailure = {
  kind: DurableRunFailureKind
  message: string
  retryable: boolean
  recommendedAction: string
}

/**
 * Optional structured telemetry attached when a durable run finishes.
 * Headless agent runs use this; shell/task runs may omit it.
 */
export type DurableRunTelemetry = {
  mode: 'headless'
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
  failure?: DurableRunFailure
}

export type DurableRun = {
  version: 1
  id: string
  kind: DurableRunKind
  status: DurableRunStatus
  cwd: string
  command?: string
  sessionId?: string
  goalId?: string
  worktreeId?: string
  outputFile?: string
  process?: DurableRunProcessIdentity
  createdAt: number
  updatedAt: number
  heartbeatAt: number
  finishedAt?: number
  error?: string
  telemetry?: DurableRunTelemetry
}

export type CreateDurableRunArgs = {
  id?: string
  kind: DurableRunKind
  cwd: string
  command?: string
  sessionId?: string
  goalId?: string
  worktreeId?: string
  outputFile?: string
  process?: DurableRunProcessIdentity
  storageRoot?: string
  now?: number
}

export type DurableRunProbe = (identity: DurableRunProcessIdentity) => {
  alive: boolean
  startToken?: string
}

export type ReconciledDurableRun = {
  run: DurableRun
  action: 'tail_only' | 'requeueable' | 'orphaned' | 'unchanged'
}
