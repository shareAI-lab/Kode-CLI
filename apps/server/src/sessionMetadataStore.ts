import { randomUUID } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'

import { isUuid } from '@kode/runtime'
import { getSessionProjectDir } from '#protocol/utils/kodeAgentSessionLog'

export const SESSION_METADATA_SCHEMA_VERSION = 1

export class SessionMetadataValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SessionMetadataValidationError'
  }
}

export type PersistentSessionMetadata = {
  schemaVersion: typeof SESSION_METADATA_SCHEMA_VERSION
  sessionId: string
  customTitle: string | null
  tag: string | null
  summary: string | null
  forkedFromSessionId: string | null
  forkRootSessionId: string | null
  archivedAt: string | null
  createdAt: string
  updatedAt: string
}

export type SessionMetadataPatch = {
  customTitle?: string | null
  tag?: string | null
  summary?: string | null
  archivedAt?: string | null
  forkedFromSessionId?: string | null
  forkRootSessionId?: string | null
}

export type SessionMetadataReadResult =
  | { kind: 'missing' }
  | { kind: 'invalid' }
  | { kind: 'ok'; metadata: PersistentSessionMetadata }

const MAX_CUSTOM_TITLE_LENGTH = 200
const MAX_TAG_LENGTH = 100
const MAX_SUMMARY_LENGTH = 12_000

export function getSessionMetadataFilePath(args: {
  cwd: string
  sessionId: string
}): string {
  if (!isUuid(args.sessionId)) {
    throw new Error('Invalid session id')
  }
  return join(getSessionProjectDir(args.cwd), `${args.sessionId}.metadata.json`)
}

function readNullableString(
  value: unknown,
  maxLength: number,
): string | null | undefined {
  if (value === null) return null
  if (typeof value !== 'string') return undefined
  const normalized = value.trim()
  return normalized.length <= maxLength ? normalized || null : undefined
}

function readNullableUuid(value: unknown): string | null | undefined {
  if (value === null) return null
  return typeof value === 'string' && isUuid(value) ? value : undefined
}

function readIsoDate(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined
  return Number.isNaN(new Date(value).getTime()) ? undefined : value
}

function parseMetadata(value: unknown): PersistentSessionMetadata | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  if (record.schemaVersion !== SESSION_METADATA_SCHEMA_VERSION) return null
  if (typeof record.sessionId !== 'string' || !isUuid(record.sessionId)) {
    return null
  }

  const customTitle = readNullableString(
    record.customTitle,
    MAX_CUSTOM_TITLE_LENGTH,
  )
  const tag = readNullableString(record.tag, MAX_TAG_LENGTH)
  const summary = readNullableString(record.summary, MAX_SUMMARY_LENGTH)
  const forkedFromSessionId = readNullableUuid(record.forkedFromSessionId)
  const forkRootSessionId = readNullableUuid(record.forkRootSessionId)
  const archivedAt =
    record.archivedAt === null ? null : readIsoDate(record.archivedAt)
  const createdAt = readIsoDate(record.createdAt)
  const updatedAt = readIsoDate(record.updatedAt)
  if (
    customTitle === undefined ||
    tag === undefined ||
    summary === undefined ||
    forkedFromSessionId === undefined ||
    forkRootSessionId === undefined ||
    archivedAt === undefined ||
    !createdAt ||
    !updatedAt
  ) {
    return null
  }

  return {
    schemaVersion: SESSION_METADATA_SCHEMA_VERSION,
    sessionId: record.sessionId,
    customTitle,
    tag,
    summary,
    forkedFromSessionId,
    forkRootSessionId,
    archivedAt,
    createdAt,
    updatedAt,
  }
}

function normalizePatchText(
  value: string | null | undefined,
  maxLength: number,
  field: string,
): string | null | undefined {
  if (value === undefined || value === null) return value
  const normalized = value.trim()
  if (normalized.length > maxLength) {
    throw new SessionMetadataValidationError(`${field} is too long`)
  }
  return normalized || null
}

function normalizePatchUuid(
  value: string | null | undefined,
  field: string,
): string | null | undefined {
  if (value === undefined || value === null) return value
  if (!isUuid(value)) {
    throw new SessionMetadataValidationError(`Invalid ${field}`)
  }
  return value
}

function normalizePatchDate(
  value: string | null | undefined,
  field: string,
): string | null | undefined {
  if (value === undefined || value === null) return value
  if (Number.isNaN(new Date(value).getTime())) {
    throw new SessionMetadataValidationError(`Invalid ${field}`)
  }
  return value
}

function writeMetadataAtomically(
  path: string,
  metadata: PersistentSessionMetadata,
): void {
  const directory = dirname(path)
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const temporaryPath = join(
    directory,
    `.${metadata.sessionId}.${process.pid}.${randomUUID()}.tmp`,
  )
  try {
    writeFileSync(temporaryPath, `${JSON.stringify(metadata)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    })
    renameSync(temporaryPath, path)
  } catch (error) {
    try {
      rmSync(temporaryPath, { force: true })
    } catch {
      /* no-op */
    }
    throw error
  }
}

export function readSessionMetadata(args: {
  cwd: string
  sessionId: string
}): SessionMetadataReadResult {
  const path = getSessionMetadataFilePath(args)
  if (!existsSync(path)) return { kind: 'missing' }

  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    const metadata = parseMetadata(parsed)
    if (!metadata || metadata.sessionId !== args.sessionId) {
      return { kind: 'invalid' }
    }
    return { kind: 'ok', metadata }
  } catch {
    return { kind: 'invalid' }
  }
}

export function writeSessionMetadata(args: {
  cwd: string
  sessionId: string
  patch: SessionMetadataPatch
  defaults?: Partial<
    Pick<
      PersistentSessionMetadata,
      | 'customTitle'
      | 'tag'
      | 'summary'
      | 'forkedFromSessionId'
      | 'forkRootSessionId'
    >
  >
}): PersistentSessionMetadata {
  const current = readSessionMetadata(args)
  if (current.kind === 'invalid') {
    throw new Error('Session metadata is invalid')
  }

  const now = new Date().toISOString()
  const base: PersistentSessionMetadata =
    current.kind === 'ok'
      ? current.metadata
      : {
          schemaVersion: SESSION_METADATA_SCHEMA_VERSION,
          sessionId: args.sessionId,
          customTitle: args.defaults?.customTitle ?? null,
          tag: args.defaults?.tag ?? null,
          summary: args.defaults?.summary ?? null,
          forkedFromSessionId: args.defaults?.forkedFromSessionId ?? null,
          forkRootSessionId: args.defaults?.forkRootSessionId ?? null,
          archivedAt: null,
          createdAt: now,
          updatedAt: now,
        }

  const customTitle = normalizePatchText(
    args.patch.customTitle,
    MAX_CUSTOM_TITLE_LENGTH,
    'customTitle',
  )
  const tag = normalizePatchText(args.patch.tag, MAX_TAG_LENGTH, 'tag')
  const summary = normalizePatchText(
    args.patch.summary,
    MAX_SUMMARY_LENGTH,
    'summary',
  )
  const forkedFromSessionId = normalizePatchUuid(
    args.patch.forkedFromSessionId,
    'forkedFromSessionId',
  )
  const forkRootSessionId = normalizePatchUuid(
    args.patch.forkRootSessionId,
    'forkRootSessionId',
  )
  const archivedAt = normalizePatchDate(args.patch.archivedAt, 'archivedAt')

  const metadata: PersistentSessionMetadata = {
    ...base,
    customTitle: customTitle === undefined ? base.customTitle : customTitle,
    tag: tag === undefined ? base.tag : tag,
    summary: summary === undefined ? base.summary : summary,
    forkedFromSessionId:
      forkedFromSessionId === undefined
        ? base.forkedFromSessionId
        : forkedFromSessionId,
    forkRootSessionId:
      forkRootSessionId === undefined
        ? base.forkRootSessionId
        : forkRootSessionId,
    archivedAt: archivedAt === undefined ? base.archivedAt : archivedAt,
    updatedAt: now,
  }

  writeMetadataAtomically(getSessionMetadataFilePath(args), metadata)
  return metadata
}
