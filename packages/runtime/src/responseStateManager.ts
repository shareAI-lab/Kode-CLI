/**
 * GPT-5 Responses API state management
 * Manages previous_response_id for conversation continuity and reasoning context reuse
 */

interface ConversationState {
  previousResponseId?: string
  lastUpdate: number
}

export class ResponseStateManager {
  private conversationStates = new Map<string, ConversationState>()
  private nextCleanupAt: number

  constructor(
    private readonly now: () => number = Date.now,
    private readonly cleanupIntervalMs = 60 * 60 * 1000,
  ) {
    this.nextCleanupAt = this.now() + this.cleanupIntervalMs
  }

  /**
   * Set the previous response ID for a conversation
   */
  setPreviousResponseId(conversationId: string, responseId: string): void {
    const now = this.now()
    this.cleanupIfDue(now)
    this.conversationStates.set(conversationId, {
      previousResponseId: responseId,
      lastUpdate: now,
    })
  }

  /**
   * Get the previous response ID for a conversation
   */
  getPreviousResponseId(conversationId: string): string | undefined {
    const now = this.now()
    this.cleanupIfDue(now)
    const state = this.conversationStates.get(conversationId)
    if (state) {
      // Update last access time
      state.lastUpdate = now
      return state.previousResponseId
    }
    return undefined
  }

  /**
   * Clear state for a conversation
   */
  clearConversation(conversationId: string): void {
    this.conversationStates.delete(conversationId)
  }

  /**
   * Clear all conversation states
   */
  clearAll(): void {
    this.conversationStates.clear()
    this.nextCleanupAt = this.now() + this.cleanupIntervalMs
  }

  /**
   * Clean up stale conversations
   */
  private cleanupIfDue(now: number): void {
    if (now < this.nextCleanupAt) return

    for (const [conversationId, state] of this.conversationStates.entries()) {
      if (now - state.lastUpdate > this.cleanupIntervalMs) {
        this.conversationStates.delete(conversationId)
      }
    }
    this.nextCleanupAt = now + this.cleanupIntervalMs
  }

  /**
   * Get current state size (for debugging/monitoring)
   */
  getStateSize(): number {
    this.cleanupIfDue(this.now())
    return this.conversationStates.size
  }
}

// Singleton instance
export const responseStateManager = new ResponseStateManager()

/**
 * Helper to generate conversation ID from context
 */
export function getConversationId(
  agentId?: string,
  messageId?: string,
): string {
  // Use agentId as primary identifier, fallback to messageId or timestamp
  return (
    agentId ||
    messageId ||
    `conv_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
  )
}
