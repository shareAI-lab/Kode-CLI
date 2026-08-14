import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'fs'
import { basename, isAbsolute, join, relative, resolve, parse } from 'path'
import {
  generateSlug,
  getPlanSlugForConversationKey,
  setPlanSlug,
} from './slug'
import { getActivePlanConversationKey, DEFAULT_CONVERSATION_KEY } from './state'
import { getKodeRoot as getKodeBaseDir } from '#config/dataRoots'
import { getOriginalCwd } from '#runtime/cwd'
import { getClaudeCompatRoots } from '#config/dataRoots'
import { isSettingSourceEnabled, loadSettingsWithLegacyFallback } from '#config'
import type { SettingsDestination } from '#config'

const MAX_SLUG_ATTEMPTS = 10
const MAIN_AGENT_ID = 'main'

function normalizeAgentId(agentId: string | undefined): string | undefined {
  const trimmed = typeof agentId === 'string' ? agentId.trim() : ''
  if (!trimmed) return undefined
  if (trimmed === MAIN_AGENT_ID) return undefined
  return trimmed
}

export function getPlanDirectory(): string {
  const projectDir = getOriginalCwd()
  const destinations: SettingsDestination[] = [
    'userSettings',
    'projectSettings',
    'localSettings',
  ]

  let override: string | null = null
  for (const destination of destinations) {
    if (!isSettingSourceEnabled(destination)) continue
    const loaded = loadSettingsWithLegacyFallback({
      destination,
      projectDir,
      migrateToPrimary: true,
    }).settings as Record<string, unknown> | null
    const next =
      typeof loaded?.plansDirectory === 'string' ? loaded.plansDirectory : ''
    const trimmed = next.trim()
    if (trimmed) override = trimmed
  }

  let dir = join(getKodeBaseDir(), 'plans')
  if (override) {
    dir = isAbsolute(override) ? override : join(projectDir, override)
  }

  if (!existsSync(dir)) {
    try {
      mkdirSync(dir, { recursive: true })
    } catch {
      dir = join(getKodeBaseDir(), 'plans')
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    }
  }
  return dir
}

function getOrCreatePlanSlug(conversationKey: string): string {
  const existing = getPlanSlugForConversationKey(conversationKey)
  if (existing) return existing

  const dir = getPlanDirectory()

  let slug: string | null = null
  for (let attempt = 0; attempt < MAX_SLUG_ATTEMPTS; attempt++) {
    slug = generateSlug()
    const path = join(dir, `${slug}.md`)
    if (!existsSync(path)) break
  }

  if (!slug) slug = generateSlug()

  setPlanSlug(conversationKey, slug)
  return slug
}

export function getPlanFilePath(
  agentId?: string,
  conversationKey?: string,
): string {
  const dir = getPlanDirectory()
  const key = conversationKey ?? DEFAULT_CONVERSATION_KEY
  const slug = getOrCreatePlanSlug(key)

  const normalizedAgentId = normalizeAgentId(agentId)
  if (!normalizedAgentId) return join(dir, `${slug}.md`)
  return join(dir, `${slug}-agent-${normalizedAgentId}.md`)
}

function resolveExistingPath(path: string): string {
  const resolved = resolve(path)
  try {
    return realpathSync(resolved)
  } catch {
    return resolved
  }
}

export function isPlanFilePathForActiveConversation(path: string): boolean {
  const key = getActivePlanConversationKey() ?? DEFAULT_CONVERSATION_KEY
  const planDir = resolveExistingPath(getPlanDirectory())
  const expectedMainPlanPath = resolveExistingPath(
    getPlanFilePath(undefined, key),
  )
  const target = resolveExistingPath(path)

  const rel = relative(planDir, target)
  if (!rel || rel === '') return false
  if (rel.startsWith('..')) return false
  if (isAbsolute(rel)) return false

  const expectedSlug = parse(expectedMainPlanPath).name
  const targetName = parse(target).name
  return (
    targetName === expectedSlug ||
    targetName.startsWith(`${expectedSlug}-agent-`)
  )
}

export function isMainPlanFilePathForActiveConversation(path: string): boolean {
  const key = getActivePlanConversationKey() ?? DEFAULT_CONVERSATION_KEY
  const expected = resolveExistingPath(getPlanFilePath(undefined, key))
  const target = resolveExistingPath(path)
  return target === expected
}

export function isPathInPlanDirectory(path: string): boolean {
  const dir = resolve(getPlanDirectory())
  const target = resolve(path)
  const rel = relative(dir, target)
  if (!rel || rel === '') return true
  if (rel.startsWith('..')) return false
  if (isAbsolute(rel)) return false
  return true
}

export function readPlanFile(
  agentId?: string,
  conversationKey?: string,
): { content: string; exists: boolean; planFilePath: string } {
  const planFilePath = getPlanFilePath(agentId, conversationKey)
  if (!existsSync(planFilePath)) {
    const legacyName = basename(planFilePath)
    const legacyRoots = getClaudeCompatRoots()
    for (const root of legacyRoots) {
      const legacyPlanPath = join(root, 'plans', legacyName)
      if (!existsSync(legacyPlanPath)) continue
      try {
        const content = readFileSync(legacyPlanPath, 'utf8')
        try {
          writeFileSync(planFilePath, content, 'utf8')
        } catch {
          // If we can't migrate, still return the legacy content so plan mode can proceed.
        }
        return { content, exists: true, planFilePath }
      } catch {
        continue
      }
    }
    return { content: '', exists: false, planFilePath }
  }
  return {
    content: readFileSync(planFilePath, 'utf8'),
    exists: true,
    planFilePath,
  }
}
