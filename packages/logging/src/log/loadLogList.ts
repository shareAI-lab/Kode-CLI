import {
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
  copyFileSync,
  promises as fsPromises,
} from 'fs'
import { join } from 'path'

import type { LogOption, SerializedMessage } from '@kode/types/logs'

import { logError } from './errors'
import { readJsonLog } from './jsonLog'
import { CACHE_PATHS, LEGACY_CACHE_PATHS, parseLogFilename } from './paths'
import { parseISOString, sortLogs } from './util'

const MIGRATION_MESSAGE_LOG_LIMIT = 50
let didMigrateMessageLogs = false

function migrateLegacyMessageLogsIfNeeded() {
  if (didMigrateMessageLogs) return
  didMigrateMessageLogs = true

  const legacyDir = LEGACY_CACHE_PATHS.messages()
  const newDir = CACHE_PATHS.messages()

  if (!existsSync(legacyDir)) return

  const newHasAny =
    existsSync(newDir) &&
    readdirSync(newDir).some(file => file.endsWith('.json'))
  if (newHasAny) return

  try {
    mkdirSync(newDir, { recursive: true })
  } catch {
    return
  }

  let legacyFiles: string[] = []
  try {
    legacyFiles = readdirSync(legacyDir).filter(file => file.endsWith('.json'))
  } catch {
    return
  }

  const sorted = legacyFiles
    .map(file => {
      try {
        const stats = statSync(join(legacyDir, file))
        return { file, mtimeMs: stats.mtimeMs }
      } catch {
        return { file, mtimeMs: 0 }
      }
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, MIGRATION_MESSAGE_LOG_LIMIT)

  for (const { file } of sorted) {
    const src = join(legacyDir, file)
    const dest = join(newDir, file)
    if (existsSync(dest)) continue
    try {
      copyFileSync(src, dest)
    } catch {
      // Best-effort migration; ignore per-file failures.
    }
  }
}

export async function loadLogList(
  path = CACHE_PATHS.messages(),
): Promise<LogOption[]> {
  if (path === CACHE_PATHS.messages()) {
    migrateLegacyMessageLogsIfNeeded()
  }

  const searchPaths =
    path === CACHE_PATHS.messages()
      ? [CACHE_PATHS.messages(), LEGACY_CACHE_PATHS.messages()]
      : [path]

  const existingPaths = searchPaths.filter(p => existsSync(p))
  if (existingPaths.length === 0) {
    logError(`No logs found at ${path}`)
    return []
  }

  const filesWithDir = (
    await Promise.all(
      existingPaths.map(async dirPath => {
        const dirFiles = await fsPromises.readdir(dirPath)
        return dirFiles.map(file => ({ file, dirPath }))
      }),
    )
  ).flat()

  const seen = new Set<string>()
  const uniqueFiles = filesWithDir.filter(({ file }) => {
    if (seen.has(file)) return false
    seen.add(file)
    return true
  })

  const logData = await Promise.all(
    uniqueFiles.map(async ({ file, dirPath }, i) => {
      const fullPath = join(dirPath, file)
      const messages = readJsonLog(fullPath) as SerializedMessage[]
      const firstMessage = messages[0]
      const lastMessage = messages[messages.length - 1]
      const firstPrompt =
        firstMessage?.type === 'user' &&
        typeof firstMessage?.message?.content === 'string'
          ? firstMessage?.message?.content
          : 'No prompt'

      const { date, forkNumber, sidechainNumber } = parseLogFilename(file)
      return {
        date,
        forkNumber,
        fullPath,
        messages,
        value: i, // overwritten after sorting
        created: parseISOString(firstMessage?.timestamp || date),
        modified: lastMessage?.timestamp
          ? parseISOString(lastMessage.timestamp)
          : parseISOString(date),
        firstPrompt:
          firstPrompt.split('\n')[0]?.slice(0, 50) +
            (firstPrompt.length > 50 ? '…' : '') || 'No prompt',
        messageCount: messages.length,
        sidechainNumber,
      }
    }),
  )

  return sortLogs(logData.filter(_ => _.messages.length)).map((_, i) => ({
    ..._,
    value: i,
  }))
}
