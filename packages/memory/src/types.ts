/**
 * Durable, project-scoped memory.  This deliberately stores concise facts and
 * preferences rather than raw conversation transcripts.
 */
export const MEMORY_SCHEMA_VERSION = 1 as const

export type MemorySource =
  | string
  | {
      kind?: string
      id?: string
      label?: string
    }

export type NormalizedMemorySource = {
  kind: string
  id?: string
  label?: string
}

export type MemoryRecord = {
  id: string
  text: string
  normalizedText: string
  fingerprint: string
  tags: string[]
  confidence: number
  source?: NormalizedMemorySource
  createdAt: number
  updatedAt: number
  expiresAt?: number
}

export type MemoryRememberInput = {
  cwd: string
  text: string
  source?: MemorySource
  tags?: string[]
  confidence?: number
  expiresAt?: number
  /** Test and embedding escape hatch. Defaults to Kode's configured root. */
  storageRoot?: string
  /** Test-only deterministic clock. */
  now?: number
}

export type MemoryScope = {
  cwd: string
  storageRoot?: string
}

export type MemoryListInput = MemoryScope & {
  limit?: number
  includeExpired?: boolean
  now?: number
}

export type RelevantMemory = MemoryRecord & {
  score: number
  matchedTerms: string[]
}

export type RelevantMemoriesInput = MemoryScope & {
  query: string
  limit?: number
  now?: number
}

export type MemoryForgetInput = MemoryScope & {
  id: string
  now?: number
}

export type MemoryExtractionInput = MemoryScope & {
  text: string
  source?: MemorySource
  maxMemories?: number
  now?: number
}

export type MemoryEvent =
  | {
      schemaVersion: typeof MEMORY_SCHEMA_VERSION
      type: 'remember'
      at: number
      memory: MemoryRecord
    }
  | {
      schemaVersion: typeof MEMORY_SCHEMA_VERSION
      type: 'forget'
      at: number
      id: string
    }
