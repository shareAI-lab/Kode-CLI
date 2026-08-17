export type JsonlEnvelopeBase = {
  cwd: string
  sessionId: string
  forkedFromSessionId?: string
  forkRootSessionId?: string
  version: string
  gitBranch?: string
  userType: string
  isSidechain: boolean
  parentUuid: string | null
  logicalParentUuid?: string
  agentId: string
  slug: string
  uuid: string
  timestamp: string
}

export type SessionJsonlEntry =
  | (JsonlEnvelopeBase & {
      type: 'user'
      message: any
      toolUseResult?: any
      toolUseMetadata?: any
    })
  | (JsonlEnvelopeBase & {
      type: 'assistant'
      message: any
      requestId?: string
      isApiErrorMessage?: boolean
    })
  | { type: 'summary'; summary: string; leafUuid: string }
  | { type: 'custom-title'; sessionId: string; customTitle: string | null }
  | { type: 'tag'; sessionId: string; tag: string | null }
  | { type: 'session-summary'; sessionId: string; summary: string | null }
  | {
      type: 'file-history-snapshot'
      messageId: string
      snapshot: {
        messageId: string
        trackedFileBackups: Record<string, unknown>
        timestamp: string
      }
      isSnapshotUpdate: boolean
    }
