import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'

import {
  getSessionStoreRoots,
  getSessionStoreProjectNameCandidatesForRead,
} from './kodeAgentSessionLog'

export type KodeAgentSessionListItem = {
  sessionId: string
  slug: string | null
  customTitle: string | null
  tag: string | null
  summary: string | null
  gitBranch: string | null
  forkedFromSessionId: string | null
  forkRootSessionId: string | null
  firstPrompt: string | null
  messageExcerpt: string | null
  messageCount: number | null
  cwd: string | null
  createdAt: Date | null
  modifiedAt: Date | null
}

export type ResumeResolveResult =
  | { kind: 'ok'; sessionId: string }
  | { kind: 'ambiguous'; identifier: string; matchingSessionIds: string[] }
  | { kind: 'different_directory'; sessionId: string; otherCwd: string | null }
  | { kind: 'not_found'; identifier: string }

function safeParseJson(line: string): unknown | null {
  try {
    return JSON.parse(line)
  } catch {
    return null
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function safeParseDate(value: unknown): Date | null {
  if (typeof value !== 'string') return null
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return null
  return d
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  )
}

function extractMessageTextBestEffort(message: unknown): string {
  if (typeof message === 'string') return message
  if (!isRecord(message)) return ''

  const content = message.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''

  const parts: string[] = []
  for (const block of content) {
    if (typeof block === 'string') {
      if (block) parts.push(block)
      continue
    }
    const record = isRecord(block) ? block : null
    if (!record) continue
    if (typeof record.text === 'string' && record.text) parts.push(record.text)
  }

  return parts.join(' ')
}

function readSessionListItemBestEffort(args: {
  filePath: string
  sessionId: string
}): Omit<KodeAgentSessionListItem, 'sessionId'> {
  const { filePath, sessionId } = args

  let slug: string | null = null
  let cwd: string | null = null
  let createdAt: Date | null = null
  let modifiedAt: Date | null = null
  let customTitle: string | null = null
  let tag: string | null = null
  let gitBranch: string | null = null
  let forkedFromSessionId: string | null = null
  let forkRootSessionId: string | null = null
  let firstPrompt: string | null = null
  let messageCount = 0

  const firstMessages: string[] = []
  const lastMessages: string[] = []
  const MAX_MESSAGE_EXCERPT_MESSAGES = 100
  const MAX_MESSAGE_EXCERPT_HALF = 50
  const MAX_MESSAGE_EXCERPT_CHARS = 2000

  let lastAssistantUuid: string | null = null
  const summariesByLeaf = new Map<string, string>()
  let lastSummary: string | null = null
  let sessionSummary: string | null | undefined = undefined

  try {
    modifiedAt = new Date(statSync(filePath).mtimeMs)
  } catch {
    modifiedAt = null
  }

  let content: string
  try {
    content = readFileSync(filePath, 'utf8')
  } catch {
    return {
      slug,
      customTitle,
      tag,
      summary: null,
      gitBranch,
      forkedFromSessionId,
      forkRootSessionId,
      firstPrompt,
      messageExcerpt: null,
      messageCount: null,
      cwd,
      createdAt,
      modifiedAt,
    }
  }

  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim()
    if (!line) continue
    const parsed = safeParseJson(line)
    const entry = isRecord(parsed) ? parsed : null
    if (!entry) continue

    if (!slug && typeof entry.slug === 'string' && entry.slug.trim()) {
      slug = entry.slug.trim()
    }
    if (!cwd && typeof entry.cwd === 'string' && entry.cwd.trim()) {
      cwd = entry.cwd.trim()
    }
    if (!createdAt) {
      const ts = safeParseDate(entry.timestamp)
      if (ts) createdAt = ts
    }

    if (typeof entry.gitBranch === 'string' && entry.gitBranch.trim()) {
      gitBranch = entry.gitBranch.trim()
    }

    if (
      !forkedFromSessionId &&
      typeof entry.forkedFromSessionId === 'string' &&
      entry.forkedFromSessionId.trim()
    ) {
      forkedFromSessionId = entry.forkedFromSessionId.trim()
    }

    if (
      !forkRootSessionId &&
      typeof entry.forkRootSessionId === 'string' &&
      entry.forkRootSessionId.trim()
    ) {
      forkRootSessionId = entry.forkRootSessionId.trim()
    }

    const type = typeof entry.type === 'string' ? entry.type : ''
    if (!type) continue

    if (type === 'user' || type === 'assistant') {
      messageCount += 1
      const text = extractMessageTextBestEffort(entry.message).trim()

      if (type === 'user' && !firstPrompt && text) firstPrompt = text

      if (text && messageCount <= MAX_MESSAGE_EXCERPT_MESSAGES) {
        if (firstMessages.length < MAX_MESSAGE_EXCERPT_HALF) {
          firstMessages.push(text)
        } else {
          lastMessages.push(text)
          if (lastMessages.length > MAX_MESSAGE_EXCERPT_HALF)
            lastMessages.shift()
        }
      } else if (text && messageCount > MAX_MESSAGE_EXCERPT_MESSAGES) {
        lastMessages.push(text)
        if (lastMessages.length > MAX_MESSAGE_EXCERPT_HALF) lastMessages.shift()
      }
    }

    if (type === 'assistant') {
      if (typeof entry.uuid === 'string' && entry.uuid)
        lastAssistantUuid = entry.uuid
      continue
    }

    if (type === 'summary') {
      const leafUuid = typeof entry.leafUuid === 'string' ? entry.leafUuid : ''
      const summary = typeof entry.summary === 'string' ? entry.summary : ''
      if (leafUuid && summary) {
        summariesByLeaf.set(leafUuid, summary)
        lastSummary = summary
      }
      continue
    }

    if (type === 'custom-title') {
      const id = typeof entry.sessionId === 'string' ? entry.sessionId : ''
      if (id === sessionId) {
        const title = entry.customTitle
        if (title === null) customTitle = null
        else if (typeof title === 'string') customTitle = title.trim() || null
      }
      continue
    }

    if (type === 'tag') {
      const id = typeof entry.sessionId === 'string' ? entry.sessionId : ''
      if (id === sessionId) {
        const tagValue = entry.tag
        if (tagValue === null) tag = null
        else if (typeof tagValue === 'string') tag = tagValue.trim() || null
      }
      continue
    }

    if (type === 'session-summary') {
      const id = typeof entry.sessionId === 'string' ? entry.sessionId : ''
      if (id === sessionId) {
        const summaryValue = entry.summary
        if (summaryValue === null) sessionSummary = null
        else if (typeof summaryValue === 'string') {
          sessionSummary = summaryValue.trim() || null
        }
      }
      continue
    }
  }

  let summary = lastSummary
  if (lastAssistantUuid) {
    summary = summariesByLeaf.get(lastAssistantUuid) ?? lastSummary
  }
  if (sessionSummary !== undefined) summary = sessionSummary

  const excerptText = [...firstMessages, ...lastMessages]
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()

  const messageExcerpt =
    excerptText.length > 0
      ? excerptText.length > MAX_MESSAGE_EXCERPT_CHARS
        ? excerptText.slice(0, MAX_MESSAGE_EXCERPT_CHARS) + '…'
        : excerptText
      : null

  return {
    slug,
    customTitle,
    tag,
    summary,
    gitBranch,
    forkedFromSessionId,
    forkRootSessionId,
    firstPrompt,
    messageExcerpt,
    messageCount,
    cwd,
    createdAt,
    modifiedAt,
  }
}

function getSessionProjectDirsForRead(cwd: string): string[] {
  const projectNames = getSessionStoreProjectNameCandidatesForRead(cwd)
  return getSessionStoreRoots()
    .flatMap(root => projectNames.map(name => join(root, 'projects', name)))
    .filter(dir => existsSync(dir))
}

export function listKodeAgentSessions(args: {
  cwd: string
}): KodeAgentSessionListItem[] {
  const { cwd } = args
  const projectDirs = getSessionProjectDirsForRead(cwd)
  if (projectDirs.length === 0) return []

  const seen = new Set<string>()
  const items: KodeAgentSessionListItem[] = []

  for (const projectDir of projectDirs) {
    const candidates = readdirSync(projectDir)
      .filter(name => name.endsWith('.jsonl'))
      .filter(name => !name.startsWith('agent-'))
      .map(name => ({
        sessionId: basename(name, '.jsonl'),
        filePath: join(projectDir, name),
      }))
      .filter(c => isUuid(c.sessionId))

    for (const { sessionId, filePath } of candidates) {
      if (seen.has(sessionId)) continue
      seen.add(sessionId)
      items.push({
        sessionId,
        ...readSessionListItemBestEffort({ filePath, sessionId }),
      })
    }
  }

  items.sort((a, b) => {
    const am = a.modifiedAt?.getTime() ?? 0
    const bm = b.modifiedAt?.getTime() ?? 0
    if (am !== bm) return bm - am
    return b.sessionId.localeCompare(a.sessionId)
  })

  return items
}

export function listAllKodeAgentSessions(): KodeAgentSessionListItem[] {
  const seen = new Set<string>()
  const items: KodeAgentSessionListItem[] = []

  for (const root of getSessionStoreRoots()) {
    const projectsDir = join(root, 'projects')
    if (!existsSync(projectsDir)) continue

    let projectNames: string[]
    try {
      projectNames = readdirSync(projectsDir)
    } catch {
      continue
    }

    for (const projectName of projectNames) {
      const projectDir = join(projectsDir, projectName)
      if (!existsSync(projectDir)) continue

      let entries: string[]
      try {
        entries = readdirSync(projectDir)
      } catch {
        continue
      }

      const candidates = entries
        .filter(name => name.endsWith('.jsonl'))
        .filter(name => !name.startsWith('agent-'))
        .map(name => ({
          sessionId: basename(name, '.jsonl'),
          filePath: join(projectDir, name),
        }))
        .filter(c => isUuid(c.sessionId))

      for (const { sessionId, filePath } of candidates) {
        if (seen.has(sessionId)) continue
        seen.add(sessionId)
        items.push({
          sessionId,
          ...readSessionListItemBestEffort({ filePath, sessionId }),
        })
      }
    }
  }

  items.sort((a, b) => {
    const am = a.modifiedAt?.getTime() ?? 0
    const bm = b.modifiedAt?.getTime() ?? 0
    if (am !== bm) return bm - am
    return b.sessionId.localeCompare(a.sessionId)
  })

  return items
}

function findSessionFileAcrossProjects(args: {
  sessionId: string
}): { filePath: string } | null {
  const { sessionId } = args
  for (const root of getSessionStoreRoots()) {
    const projectsDir = join(root, 'projects')
    if (!existsSync(projectsDir)) continue

    let projectNames: string[]
    try {
      projectNames = readdirSync(projectsDir)
    } catch {
      continue
    }

    for (const projectName of projectNames) {
      const candidate = join(projectsDir, projectName, `${sessionId}.jsonl`)
      if (existsSync(candidate)) return { filePath: candidate }
    }
  }

  return null
}

function readSessionCwdBestEffort(filePath: string): string | null {
  try {
    const content = readFileSync(filePath, 'utf8')
    for (const rawLine of content.split('\n')) {
      const line = rawLine.trim()
      if (!line) continue
      const parsed = safeParseJson(line)
      const record = isRecord(parsed) ? parsed : null
      if (!record) continue
      const cwd = record.cwd
      if (typeof cwd === 'string' && cwd.trim()) return cwd.trim()
    }
  } catch {
    // ignore
  }
  return null
}

function sessionExistsInProject(cwd: string, sessionId: string): boolean {
  for (const projectDir of getSessionProjectDirsForRead(cwd)) {
    try {
      if (existsSync(join(projectDir, `${sessionId}.jsonl`))) return true
    } catch {
      continue
    }
  }
  return false
}

export function resolveResumeSessionIdentifier(args: {
  cwd: string
  identifier: string
}): ResumeResolveResult {
  const { cwd, identifier } = args
  const id = identifier.trim()
  if (!id) return { kind: 'not_found', identifier }

  if (isUuid(id)) {
    if (sessionExistsInProject(cwd, id)) return { kind: 'ok', sessionId: id }

    const elsewhere = findSessionFileAcrossProjects({ sessionId: id })
    if (elsewhere) {
      return {
        kind: 'different_directory',
        sessionId: id,
        otherCwd: readSessionCwdBestEffort(elsewhere.filePath),
      }
    }

    return { kind: 'not_found', identifier: id }
  }

  const sessions = listKodeAgentSessions({ cwd })
  const matches = sessions
    .filter(s => s.slug === id || s.customTitle === id)
    .map(s => s.sessionId)

  if (matches.length === 1) return { kind: 'ok', sessionId: matches[0]! }
  if (matches.length > 1)
    return { kind: 'ambiguous', identifier: id, matchingSessionIds: matches }
  return { kind: 'not_found', identifier: id }
}
