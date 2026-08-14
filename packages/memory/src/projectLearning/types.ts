import type { ProjectScope } from '#core/projectScope'

export const PROJECT_LEARNING_SCHEMA_VERSION = 1 as const

export type ProjectLearningKind = 'procedure' | 'decision' | 'failure'
export type ProjectLearningStatus = 'candidate' | 'active' | 'retired'

export type ProjectWorkspaceRevision = {
  gitHead?: string
  gitBranch?: string | null
  workspaceFingerprint?: string
}

export type ProjectLearningEvidence = {
  sourceId: string
  sessionId: string
  observedAt: number
  workspace: ProjectWorkspaceRevision
}

export type ProjectLearningRecord = {
  id: string
  scopeId: string
  text: string
  normalizedText: string
  fingerprint: string
  kind: ProjectLearningKind
  status: ProjectLearningStatus
  confidence: number
  pathPrefixes: string[]
  evidence: ProjectLearningEvidence[]
  createdAt: number
  updatedAt: number
  retiredAt?: number
  retirementReason?: string
}

export type ProjectLearningCandidate = {
  text: string
  kind: ProjectLearningKind
  pathPrefixes: string[]
}

export type ProjectLearningScope = {
  cwd: string
  storageRoot?: string
}

export type ObserveProjectLearningInput = ProjectLearningScope & {
  candidate: ProjectLearningCandidate
  sourceId: string
  sessionId: string
  workspace?: ProjectWorkspaceRevision
  now?: number
}

export type ProjectLearningListInput = ProjectLearningScope & {
  includeRetired?: boolean
  limit?: number
}

export type RelevantProjectLearning = ProjectLearningRecord & {
  score: number
  matchedTerms: string[]
}

export type RelevantProjectLearningInput = ProjectLearningScope & {
  query: string
  limit?: number
}

export type RetireProjectLearningInput = ProjectLearningScope & {
  id: string
  reason?: string
  now?: number
}

export type ProjectContextSnapshot = {
  id: string
  scope: ProjectScope
  sessionId: string
  leafUuid: string
  summary: string
  workspace: ProjectWorkspaceRevision
  createdAt: number
}

export type CaptureProjectContextSnapshotInput = ProjectLearningScope & {
  sessionId: string
  leafUuid: string
  summary: string
  workspace?: ProjectWorkspaceRevision
  now?: number
}

export type ProjectLearningEvent =
  | {
      schemaVersion: typeof PROJECT_LEARNING_SCHEMA_VERSION
      type: 'upsert'
      at: number
      learning: ProjectLearningRecord
    }
  | {
      schemaVersion: typeof PROJECT_LEARNING_SCHEMA_VERSION
      type: 'retire'
      at: number
      id: string
      reason?: string
    }
