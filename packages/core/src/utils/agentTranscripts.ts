import type { Message as ConversationMessage } from '#core/query'
import { resolve } from 'node:path'

type AgentTranscriptOwner = {
  agentId: string
  cwd: string
  sessionId: string
}

const transcripts = new Map<string, ConversationMessage[]>()

function transcriptKey(owner: AgentTranscriptOwner): string {
  return JSON.stringify([
    resolve(owner.cwd),
    owner.sessionId.trim(),
    owner.agentId.trim(),
  ])
}

export function saveAgentTranscript(
  owner: AgentTranscriptOwner,
  messages: ConversationMessage[],
): void {
  transcripts.set(transcriptKey(owner), messages)
}

export function getAgentTranscript(
  owner: AgentTranscriptOwner,
): ConversationMessage[] | undefined {
  return transcripts.get(transcriptKey(owner))
}

export function __clearAgentTranscriptsForTests(): void {
  transcripts.clear()
}
