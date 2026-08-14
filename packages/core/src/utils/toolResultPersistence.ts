import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { getKodeBaseDir } from '#core/utils/env'
import { appendJsonlAsync } from '#core/utils/jsonlWriter'
import { getKodeAgentSessionId } from '#protocol/utils/kodeAgentSessionId'
import { sanitizeProjectNameForSessionStore } from '#protocol/utils/kodeAgentSessionLog'

export const PERSISTED_OUTPUT_OPEN_TAG = '<persisted-output>'
export const PERSISTED_OUTPUT_CLOSE_TAG = '</persisted-output>'

export const OLD_TOOL_RESULT_CONTENT_CLEARED_MARKER =
  '[Old tool result content cleared]'

const DEFAULT_MAX_RESULT_SIZE_CHARS = 400_000
const DEFAULT_PREVIEW_CHARS = 2_000

type ToolResultContent = string | any[]

type PersistedToolResult = {
  filepath: string
  originalSize: number
  isJson: boolean
  preview: string
  hasMore: boolean
  previewChars: number
}

export type MicrocompactRecord = {
  timestamp: number
  trigger: 'auto' | 'manual'
  tokenUsageBefore: number
  tokenUsageAfter: number
  totalToolResultTokens: number
  tokensSaved: number
  toolUseIds: string[]
}

function toLocaleNumber(value: number): string {
  try {
    return value.toLocaleString()
  } catch {
    return String(value)
  }
}

function buildSessionToolResultsDir(cwd: string): string {
  const baseDir = getKodeBaseDir()
  const projectKey = sanitizeProjectNameForSessionStore(cwd)
  const sessionId = getKodeAgentSessionId()
  return join(baseDir, 'projects', projectKey, sessionId, 'tool-results')
}

export function appendMicrocompactRecord(args: {
  cwd: string
  record: MicrocompactRecord
}): void {
  const dir = buildSessionToolResultsDir(args.cwd)
  try {
    mkdirSync(dir, { recursive: true })
    const path = join(dir, 'microcompact.jsonl')
    appendJsonlAsync({
      filePath: path,
      entry: `${JSON.stringify(args.record)}\n`,
      mode: 0o600,
    })
  } catch {
    // best-effort
  }
}

function hasImageBlock(content: any[]): boolean {
  return content.some(
    block =>
      block &&
      typeof block === 'object' &&
      'type' in block &&
      (block as any).type === 'image',
  )
}

function buildPreview(args: { content: string; maxChars: number }): {
  preview: string
  hasMore: boolean
} {
  if (args.content.length <= args.maxChars) {
    return { preview: args.content, hasMore: false }
  }

  const slice = args.content.slice(0, args.maxChars)
  const lastNewline = slice.lastIndexOf('\n')
  const cutAt = lastNewline > args.maxChars * 0.5 ? lastNewline : args.maxChars
  return { preview: args.content.slice(0, cutAt), hasMore: true }
}

function formatPersistedOutput(meta: PersistedToolResult): string {
  const originalSize = toLocaleNumber(meta.originalSize)
  const previewChars = toLocaleNumber(meta.previewChars)

  let out = `${PERSISTED_OUTPUT_OPEN_TAG}\n`
  out += `Output too large (${originalSize}). Full output saved to: ${meta.filepath}\n\n`
  out += `Preview (first ${previewChars}):\n`
  out += meta.preview
  out += meta.hasMore ? '\n...\n' : '\n'
  out += PERSISTED_OUTPUT_CLOSE_TAG
  return out
}

function persistToolResultContent(args: {
  cwd: string
  toolUseId: string
  content: ToolResultContent
  previewChars?: number
}): PersistedToolResult | null {
  let isJson = false
  let serialized: string
  if (Array.isArray(args.content)) {
    isJson = true
    serialized = JSON.stringify(args.content, null, 2)
  } else {
    serialized = args.content
  }

  const dir = buildSessionToolResultsDir(args.cwd)
  try {
    mkdirSync(dir, { recursive: true })
  } catch {
    return null
  }

  const ext = isJson ? 'json' : 'txt'
  const filepath = join(dir, `${args.toolUseId}.${ext}`)

  try {
    if (!existsSync(filepath)) {
      writeFileSync(filepath, serialized, 'utf8')
    }
  } catch {
    return null
  }

  const previewChars =
    typeof args.previewChars === 'number' && Number.isFinite(args.previewChars)
      ? Math.max(0, Math.trunc(args.previewChars))
      : DEFAULT_PREVIEW_CHARS

  const { preview, hasMore } = buildPreview({
    content: serialized,
    maxChars: previewChars,
  })

  return {
    filepath,
    originalSize: serialized.length,
    isJson,
    preview,
    hasMore,
    previewChars,
  }
}

export function maybePersistOversizedToolResult(args: {
  cwd: string
  toolUseId: string
  content: ToolResultContent
  maxResultSizeChars?: number
  previewChars?: number
}): ToolResultContent {
  const contentValue = args.content
  if (!contentValue) return contentValue

  if (Array.isArray(contentValue) && hasImageBlock(contentValue)) {
    return contentValue
  }

  const maxSize = args.maxResultSizeChars ?? DEFAULT_MAX_RESULT_SIZE_CHARS
  const estimatedSize =
    typeof contentValue === 'string'
      ? contentValue.length
      : JSON.stringify(contentValue).length
  if (estimatedSize <= maxSize) return contentValue

  const persisted = persistToolResultContent({
    cwd: args.cwd,
    toolUseId: args.toolUseId,
    content: contentValue,
    previewChars: args.previewChars,
  })
  if (!persisted) return contentValue

  return formatPersistedOutput(persisted)
}
