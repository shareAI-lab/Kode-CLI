// Type definitions for log-related functionality
// Used by log selector, log list, and log utilities

import type { UUID } from 'crypto'

/**
 * Serialized message structure stored in log files
 * Based on how messages are serialized and deserialized in log.ts
 */
export interface SerializedMessage {
  type: 'user' | 'assistant' | 'progress'
  uuid: UUID
  message?: {
    content: string | Array<{ type: string; text?: string }>
    role: 'user' | 'assistant' | 'system'
  }
  costUSD?: number
  durationMs?: number
  timestamp: string
  cwd?: string
  userType?: string
  sessionId?: string
  version?: string
}

/**
 * Log option representing a single conversation log
 * Used by LogSelector and LogList components
 */
export interface LogOption {
  // File metadata
  date: string
  fullPath: string
  value: number // Index in the logs array

  // Timestamps for sorting
  created: Date
  modified: Date

  // Content metadata
  firstPrompt: string
  messageCount: number
  messages: SerializedMessage[]

  // Fork and branch info
  forkNumber?: number
  sidechainNumber?: number
}

/**
 * Props for LogList component
 * Used by LogList.tsx
 */
export interface LogListProps {
  context: {
    unmount?: () => void
  }
}
