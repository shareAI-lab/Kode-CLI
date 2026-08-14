import { randomUUID } from 'node:crypto'
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  rmSync,
  renameSync,
  statSync,
  unlinkSync,
} from 'node:fs'
import { dirname, join } from 'node:path'

import type { KodeAgentSessionListItem } from './kodeAgentSessionResume'
import { listKodeAgentSessions } from './kodeAgentSessionResume'
import {
  getSessionLogFilePath,
  getSessionStoreRoots,
  sanitizeProjectNameForSessionStore,
} from './kodeAgentSessionLog'

export type ImportableSession = KodeAgentSessionListItem & {
  sourcePath: string
  destinationPath: string
}

export type ImportLegacySessionResult =
  | {
      kind: 'imported'
      sessionId: string
      sourcePath: string
      destinationPath: string
    }
  | { kind: 'already_present'; sessionId: string; destinationPath: string }
  | { kind: 'not_found'; sessionId: string }
  | { kind: 'failed'; sessionId: string; message: string }

function resolveLegacySessionLogPath(args: {
  cwd: string
  sessionId: string
}): string | null {
  const projectName = sanitizeProjectNameForSessionStore(args.cwd)
  const roots = getSessionStoreRoots().slice(1)
  for (const root of roots) {
    const candidate = join(
      root,
      'projects',
      projectName,
      `${args.sessionId}.jsonl`,
    )
    if (existsSync(candidate)) return candidate
  }
  return null
}

function copyDirIfMissing(sourceDir: string, destinationDir: string): void {
  if (existsSync(destinationDir)) return
  cpSync(sourceDir, destinationDir, { recursive: true })
}

export function listImportableLegacySessions(args: {
  cwd: string
}): ImportableSession[] {
  const sessions = listKodeAgentSessions({ cwd: args.cwd })

  const importable: ImportableSession[] = []
  for (const session of sessions) {
    const destinationPath = getSessionLogFilePath({
      cwd: args.cwd,
      sessionId: session.sessionId,
    })
    if (existsSync(destinationPath)) continue

    const sourcePath = resolveLegacySessionLogPath({
      cwd: args.cwd,
      sessionId: session.sessionId,
    })
    if (!sourcePath) continue

    importable.push({ ...session, sourcePath, destinationPath })
  }

  return importable
}

export function importLegacySession(args: {
  cwd: string
  sessionId: string
}): ImportLegacySessionResult {
  const destinationPath = getSessionLogFilePath({
    cwd: args.cwd,
    sessionId: args.sessionId,
  })

  if (existsSync(destinationPath)) {
    return {
      kind: 'already_present',
      sessionId: args.sessionId,
      destinationPath,
    }
  }

  const sourcePath = resolveLegacySessionLogPath({
    cwd: args.cwd,
    sessionId: args.sessionId,
  })
  if (!sourcePath) return { kind: 'not_found', sessionId: args.sessionId }

  const sourceSessionDir = join(dirname(sourcePath), args.sessionId)

  // Copy through a sibling temp file and atomically rename so a crash or a
  // partial copy can never leave a truncated destination .jsonl that would
  // permanently block re-import as `already_present`.
  const temporaryPath = join(
    dirname(destinationPath),
    `.${process.pid}.${randomUUID()}.import.tmp`,
  )
  let committed = false
  try {
    mkdirSync(dirname(destinationPath), { recursive: true })
    copyFileSync(sourcePath, temporaryPath)
    renameSync(temporaryPath, destinationPath)
    committed = true

    if (
      existsSync(sourceSessionDir) &&
      statSync(sourceSessionDir).isDirectory()
    ) {
      const destinationSessionDir = join(
        dirname(destinationPath),
        args.sessionId,
      )
      copyDirIfMissing(sourceSessionDir, destinationSessionDir)
    }

    return {
      kind: 'imported',
      sessionId: args.sessionId,
      sourcePath,
      destinationPath,
    }
  } catch (error) {
    try {
      unlinkSync(temporaryPath)
    } catch {
      /* no-op */
    }
    if (committed) {
      // A failure after the commit point (e.g. the session-directory copy)
      // must not leave a half-imported destination behind: remove the
      // committed log and any partial session directory so a later call can
      // retry from scratch.
      try {
        unlinkSync(destinationPath)
      } catch {
        /* no-op */
      }
      try {
        rmSync(join(dirname(destinationPath), args.sessionId), {
          recursive: true,
          force: true,
        })
      } catch {
        /* no-op */
      }
    }
    return {
      kind: 'failed',
      sessionId: args.sessionId,
      message: error instanceof Error ? error.message : String(error),
    }
  }
}
