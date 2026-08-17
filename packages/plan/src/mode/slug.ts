import { randomBytes } from 'crypto'
import { parse } from 'path'
import type { ToolUseContext } from '@kode/tool-interface/Tool'
import {
  PLAN_SLUG_ADJECTIVES,
  PLAN_SLUG_NOUNS,
  PLAN_SLUG_VERBS,
} from '#protocol/utils/planSlugWords'

import { getConversationKey } from './state'

const planSlugCache = new Map<string, string>()

function pickIndex(length: number): number {
  return randomBytes(4).readUInt32BE(0) % length
}

function pickWord(words: readonly string[]): string {
  return words[pickIndex(words.length)]!
}

export function generateSlug(): string {
  const adjective = pickWord(PLAN_SLUG_ADJECTIVES)
  const verb = pickWord(PLAN_SLUG_VERBS)
  const noun = pickWord(PLAN_SLUG_NOUNS)
  return `${adjective}-${verb}-${noun}`
}

export function setPlanSlug(conversationKey: string, slug: string): void {
  planSlugCache.set(conversationKey, slug)
}

export function getPlanSlugForConversationKey(
  conversationKey: string,
): string | null {
  return planSlugCache.get(conversationKey) ?? null
}

export function extractSlugFromPlanFilePath(
  planFilePath: string,
): string | null {
  if (!planFilePath) return null
  const baseName = parse(planFilePath).name
  if (!baseName) return null

  const agentMarker = '-agent-'
  const idx = baseName.lastIndexOf(agentMarker)
  if (idx === -1) return baseName
  if (idx === 0) return null
  return baseName.slice(0, idx)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function getTrimmedString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

export function hydratePlanSlugFromMessages(
  messages: unknown[],
  context?: ToolUseContext,
): boolean {
  const conversationKey = getConversationKey(context)
  if (planSlugCache.has(conversationKey)) return true

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (!isRecord(msg)) continue

    const directSlug = getTrimmedString(msg.slug)
    if (directSlug) {
      planSlugCache.set(conversationKey, directSlug)
      return true
    }

    const toolUseResult = msg.toolUseResult
    if (!isRecord(toolUseResult)) continue
    const data = toolUseResult.data
    if (!isRecord(data)) continue

    const planFilePath =
      getTrimmedString(data.planFilePath) || getTrimmedString(data.filePath)
    if (!planFilePath) continue

    const slug = extractSlugFromPlanFilePath(planFilePath)
    if (!slug) continue

    planSlugCache.set(conversationKey, slug)
    return true
  }

  return false
}

export function __resetPlanSlugsForTests(): void {
  planSlugCache.clear()
}
