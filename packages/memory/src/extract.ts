import { redactSensitiveMemoryText } from './redaction'
import { rememberMemory } from './store'
import type { MemoryExtractionInput, MemoryRecord } from './types'

const EXPLICIT_MEMORY_PREFIX =
  /^(?:[-*]\s*)?(?:remember|memory|preference|convention|decision|记住|偏好|约定|规范|决策)\s*[:：-]\s*/iu
const UNSAFE_AUTOMATIC_DIRECTIVE =
  /^(?:(?:always|must|please)\s+)?(?:ignore|bypass|disable|override|skip)\b[\s\S]{0,160}\b(?:permission|approval|system|instruction|policy|safety)\b|\b(?:run|execute)\b[\s\S]{0,120}\bwithout\s+(?:asking|approval|permission)\b/iu
const MAX_INPUT_LENGTH = 16_000

function candidateLines(text: string): string[] {
  const lines = text
    .slice(0, MAX_INPUT_LENGTH)
    .split(/(?:\r?\n|(?<=[.!?。！？])\s+)/u)
    .map(line => line.replace(/^\s*[-*]\s*/, '').trim())
    .filter(Boolean)

  const seen = new Set<string>()
  const candidates: string[] = []
  for (const line of lines) {
    if (line.length < 12 || line.length > 1_600) continue
    const prefix = line.match(EXPLICIT_MEMORY_PREFIX)
    if (!prefix) continue
    const candidate = line.slice(prefix[0].length).trim()
    if (UNSAFE_AUTOMATIC_DIRECTIVE.test(candidate)) continue
    const key = candidate.normalize('NFKC').toLowerCase()
    if (candidate && !seen.has(key)) {
      seen.add(key)
      candidates.push(candidate)
    }
  }
  return candidates
}

/**
 * Extracts only statements prefixed with an explicit memory marker. It never
 * infers durable policy from ordinary prose, calls an LLM, or bypasses the
 * redaction/deduplication path used for a manual memory write.
 */
export function extractLongTermMemories(
  input: MemoryExtractionInput,
): MemoryRecord[] {
  const maxMemories = Math.max(0, Math.min(24, input.maxMemories ?? 8))
  if (maxMemories === 0) return []

  const extracted: MemoryRecord[] = []
  for (const candidate of candidateLines(
    redactSensitiveMemoryText(input.text).text,
  )) {
    const memory = rememberMemory({
      cwd: input.cwd,
      storageRoot: input.storageRoot,
      text: candidate,
      source: input.source,
      tags: ['extracted'],
      confidence: 0.7,
      now: input.now,
    })
    if (memory && !extracted.some(item => item.id === memory.id)) {
      extracted.push(memory)
    }
    if (extracted.length >= maxMemories) break
  }
  return extracted
}
