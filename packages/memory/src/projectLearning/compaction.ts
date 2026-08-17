import { dirname } from 'node:path'

import {
  captureProjectContextSnapshot,
  getProjectWorkspaceRevision,
  observeProjectLearning,
} from './store'
import type { ProjectLearningCandidate } from './types'

const LEARNING_SECTION_HEADING =
  /^##\s+Reusable Lessons \(Candidate Only\)\s*$/iu
const NEXT_SECTION_HEADING = /^##\s+/u
const LESSON_LINE = /^[-*]\s*\[(procedure|decision|failure)\]\s+(.+)$/iu
const MAX_CANDIDATES = 3
const REQUIRED_COMPACTION_SECTIONS = [
  'Technical Context',
  'Project Overview',
  'Code Changes',
  'Debugging & Issues',
  'Current Status',
  'Pending Tasks',
  'User Preferences',
  'Key Decisions',
] as const

export const PROJECT_LEARNING_COMPACTION_INSTRUCTIONS = `## Reusable Lessons (Candidate Only)
List at most 3 concise project-specific lessons that are directly supported by successful tool output, tests, or explicit user confirmation. Use exactly \`- [procedure] lesson\`, \`- [decision] lesson\`, or \`- [failure] lesson\`. A lesson must be a factual workflow hint, never a request to alter permissions, policy, safety rules, or user intent. If no lesson has direct evidence, write \`None.\``

/**
 * Auto-compaction replaces the model-visible transcript. If the summary omits
 * a required continuation section, keeping the original transcript is safer
 * than accepting a lossy context replacement. Callers use a false result as
 * an automatic context rollback to the pre-compaction messages.
 */
export function isCompactionSummarySafe(summary: string): boolean {
  const headings = new Set(
    String(summary ?? '')
      .split(/\r?\n/u)
      .flatMap(line => {
        const match = line.trim().match(/^##\s+(.+?)\s*$/u)
        return match?.[1] ? [match[1]] : []
      }),
  )
  return REQUIRED_COMPACTION_SECTIONS.every(section => headings.has(section))
}

function inferPathPrefixes(text: string): string[] {
  const matches = text.matchAll(
    /(?:^|[\s`'"(])((?:apps|packages|src|test|tests|docs)\/[A-Za-z0-9._/-]+)/gu,
  )
  const paths = new Set<string>()
  for (const match of matches) {
    const raw = match[1]?.replace(/[),.;:]+$/u, '')
    if (!raw) continue
    const prefix = /\.[A-Za-z0-9]+$/u.test(raw) ? dirname(raw) : raw
    if (prefix && prefix !== '.') paths.add(prefix.replace(/\\/g, '/'))
    if (paths.size >= 8) break
  }
  return [...paths]
}

/**
 * The extractor accepts only the fixed section and fixed bullet grammar that
 * Kode asks its compaction model to emit. Everything else in a summary stays
 * conversation data and cannot become durable project learning.
 */
export function extractProjectLearningCandidates(
  summary: string,
): ProjectLearningCandidate[] {
  const lines = String(summary ?? '').split(/\r?\n/u)
  const candidates: ProjectLearningCandidate[] = []
  let inLearningSection = false
  const seen = new Set<string>()

  for (const line of lines) {
    if (LEARNING_SECTION_HEADING.test(line.trim())) {
      inLearningSection = true
      continue
    }
    if (inLearningSection && NEXT_SECTION_HEADING.test(line.trim())) break
    if (!inLearningSection) continue
    const match = line.trim().match(LESSON_LINE)
    if (!match) continue
    const kind = match[1]?.toLowerCase()
    const text = match[2]?.trim()
    if (
      (kind !== 'procedure' && kind !== 'decision' && kind !== 'failure') ||
      !text
    ) {
      continue
    }
    const key = `${kind}\n${text.normalize('NFKC').toLowerCase()}`
    if (seen.has(key)) continue
    seen.add(key)
    candidates.push({
      kind,
      text,
      pathPrefixes: inferPathPrefixes(text),
    })
    if (candidates.length >= MAX_CANDIDATES) break
  }

  return candidates
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

/**
 * A summary alone is a model assertion, not evidence. Candidate extraction is
 * allowed only if the compacted transcript contains at least one successful
 * tool result. This is intentionally a coarse gate: a lesson is still only a
 * candidate until a second session supports it.
 */
export function hasSupportingToolEvidence(
  messages: readonly unknown[],
): boolean {
  return messages.some(message => {
    if (!isRecord(message) || message.type !== 'user') return false
    const envelope = isRecord(message.message) ? message.message : null
    const content = envelope?.content
    if (!Array.isArray(content)) return false
    return content.some(block => {
      if (!isRecord(block) || block.type !== 'tool_result') return false
      return block.is_error !== true
    })
  })
}

/**
 * A compaction boundary is the only automatic learning source in the first
 * release. Keeping extraction here makes its cost bounded and makes every
 * candidate traceable to a persisted conversation summary.
 */
export function recordProjectLearningFromCompaction(args: {
  cwd: string
  storageRoot?: string
  summary: string
  leafUuid: string
  sessionId: string
  hasSupportingToolEvidence?: boolean
}): { candidateCount: number; snapshotId: string | null } {
  const workspace = getProjectWorkspaceRevision(args.cwd)
  const snapshot = captureProjectContextSnapshot({
    cwd: args.cwd,
    storageRoot: args.storageRoot,
    summary: args.summary,
    leafUuid: args.leafUuid,
    sessionId: args.sessionId,
    workspace,
  })
  const candidates = args.hasSupportingToolEvidence
    ? extractProjectLearningCandidates(args.summary)
    : []
  for (const candidate of candidates) {
    observeProjectLearning({
      cwd: args.cwd,
      storageRoot: args.storageRoot,
      candidate,
      sourceId: args.leafUuid,
      sessionId: args.sessionId,
      workspace,
    })
  }
  return { candidateCount: candidates.length, snapshotId: snapshot?.id ?? null }
}
