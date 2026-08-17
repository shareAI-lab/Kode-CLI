import { describe, expect, test } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import {
  importLegacySession,
  listImportableLegacySessions,
} from '#protocol/utils/kodeAgentSessionImport'
import {
  getSessionLogFilePath,
  sanitizeProjectNameForSessionStore,
} from '#protocol/utils/kodeAgentSessionLog'
import { loadKodeAgentSessionMessages } from '#protocol/utils/kodeAgentSessionLoad'

async function withEnv<T>(
  updates: Record<string, string | undefined>,
  fn: () => Promise<T> | T,
): Promise<T> {
  const previous: Record<string, string | undefined> = {}
  for (const [key, value] of Object.entries(updates)) {
    previous[key] = process.env[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  try {
    return await fn()
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

describe('legacy session import (read-only discover + explicit copy into kodeRoot)', () => {
  test('lists sessions from legacy roots and imports into kodeRoot (including session directory)', async () => {
    const kodeRoot = mkdtempSync(join(tmpdir(), 'kode-import-root-'))
    const claudeRoot = mkdtempSync(join(tmpdir(), 'claude-import-root-'))
    const projectDir = mkdtempSync(join(tmpdir(), 'kode-import-proj-'))

    try {
      await withEnv(
        {
          KODE_CONFIG_DIR: kodeRoot,
          CLAUDE_CONFIG_DIR: claudeRoot,
          ANYKODE_CONFIG_DIR: undefined,
        },
        () => {
          const sessionId = '11111111-1111-4111-8111-111111111111'
          const projectName = sanitizeProjectNameForSessionStore(projectDir)

          const fixture = readFileSync(
            join(
              process.cwd(),
              'packages',
              'protocol',
              'src',
              'test',
              'fixtures',
              'claude-session-basic.jsonl',
            ),
            'utf8',
          )
            .replaceAll('{{sessionId}}', sessionId)
            .replaceAll('{{cwd}}', JSON.stringify(projectDir).slice(1, -1))

          const sourcePath = join(
            claudeRoot,
            'projects',
            projectName,
            `${sessionId}.jsonl`,
          )
          mkdirSync(dirname(sourcePath), { recursive: true })
          writeFileSync(sourcePath, fixture, 'utf8')

          const sourceToolResults = join(
            claudeRoot,
            'projects',
            projectName,
            sessionId,
            'tool-results',
          )
          mkdirSync(sourceToolResults, { recursive: true })
          writeFileSync(
            join(sourceToolResults, 'abc.txt'),
            'hello from legacy\n',
            'utf8',
          )

          const importable = listImportableLegacySessions({ cwd: projectDir })
          expect(importable.map(s => s.sessionId)).toEqual([sessionId])
          expect(importable[0]?.sourcePath).toBe(sourcePath)

          const destinationPath = getSessionLogFilePath({
            cwd: projectDir,
            sessionId,
          })
          expect(importable[0]?.destinationPath).toBe(destinationPath)
          expect(existsSync(destinationPath)).toBe(false)

          const result = importLegacySession({ cwd: projectDir, sessionId })
          expect(result.kind).toBe('imported')
          expect(existsSync(destinationPath)).toBe(true)
          expect(readFileSync(destinationPath, 'utf8')).toBe(fixture)

          const destinationToolResults = join(
            kodeRoot,
            'projects',
            projectName,
            sessionId,
            'tool-results',
          )
          expect(existsSync(join(destinationToolResults, 'abc.txt'))).toBe(true)
          expect(
            readFileSync(join(destinationToolResults, 'abc.txt'), 'utf8'),
          ).toBe('hello from legacy\n')

          const loaded = loadKodeAgentSessionMessages({
            cwd: projectDir,
            sessionId,
          })
          expect(loaded.length).toBe(2)
          expect(loaded[0]?.type).toBe('user')
          expect(loaded[1]?.type).toBe('assistant')
        },
      )
    } finally {
      rmSync(kodeRoot, { recursive: true, force: true })
      rmSync(claudeRoot, { recursive: true, force: true })
      rmSync(projectDir, { recursive: true, force: true })
    }
  })

  test('does not list or overwrite sessions already present in kodeRoot', async () => {
    const kodeRoot = mkdtempSync(join(tmpdir(), 'kode-import-root-'))
    const claudeRoot = mkdtempSync(join(tmpdir(), 'claude-import-root-'))
    const projectDir = mkdtempSync(join(tmpdir(), 'kode-import-proj-'))

    try {
      await withEnv(
        {
          KODE_CONFIG_DIR: kodeRoot,
          CLAUDE_CONFIG_DIR: claudeRoot,
          ANYKODE_CONFIG_DIR: undefined,
        },
        () => {
          const sessionId = '22222222-2222-4222-8222-222222222222'
          const projectName = sanitizeProjectNameForSessionStore(projectDir)

          const sourcePath = join(
            claudeRoot,
            'projects',
            projectName,
            `${sessionId}.jsonl`,
          )
          mkdirSync(dirname(sourcePath), { recursive: true })
          writeFileSync(
            sourcePath,
            '{"type":"assistant","uuid":"a1"}\n',
            'utf8',
          )

          const destinationPath = getSessionLogFilePath({
            cwd: projectDir,
            sessionId,
          })
          mkdirSync(dirname(destinationPath), { recursive: true })
          writeFileSync(destinationPath, 'existing\n', 'utf8')

          const importable = listImportableLegacySessions({ cwd: projectDir })
          expect(importable).toEqual([])

          const result = importLegacySession({ cwd: projectDir, sessionId })
          expect(result.kind).toBe('already_present')
          expect(readFileSync(destinationPath, 'utf8')).toBe('existing\n')
        },
      )
    } finally {
      rmSync(kodeRoot, { recursive: true, force: true })
      rmSync(claudeRoot, { recursive: true, force: true })
      rmSync(projectDir, { recursive: true, force: true })
    }
  })

  test('a failed copy leaves no partial destination so import can retry', async () => {
    const kodeRoot = mkdtempSync(join(tmpdir(), 'kode-import-root-'))
    const claudeRoot = mkdtempSync(join(tmpdir(), 'claude-import-root-'))
    const projectDir = mkdtempSync(join(tmpdir(), 'kode-import-proj-'))

    try {
      await withEnv(
        {
          KODE_CONFIG_DIR: kodeRoot,
          CLAUDE_CONFIG_DIR: claudeRoot,
          ANYKODE_CONFIG_DIR: undefined,
        },
        () => {
          const sessionId = '33333333-3333-4333-8333-333333333333'
          const projectName = sanitizeProjectNameForSessionStore(projectDir)
          const sourcePath = join(
            claudeRoot,
            'projects',
            projectName,
            `${sessionId}.jsonl`,
          )
          const destinationPath = getSessionLogFilePath({
            cwd: projectDir,
            sessionId,
          })

          // A directory where a session log is expected makes copyFileSync
          // fail deterministically (EISDIR), simulating a copy error/crash
          // mid-import.
          mkdirSync(dirname(sourcePath), { recursive: true })
          mkdirSync(sourcePath, { recursive: true })

          const first = importLegacySession({ cwd: projectDir, sessionId })
          expect(first.kind).toBe('failed')

          expect(existsSync(destinationPath)).toBe(false)
          expect(
            readdirSync(dirname(destinationPath)).some(name =>
              name.endsWith('.import.tmp'),
            ),
          ).toBe(false)

          // Repair the source and retry: the destination must be importable.
          rmSync(sourcePath, { recursive: true, force: true })
          writeFileSync(sourcePath, '{"type":"user","uuid":"u1"}\n', 'utf8')

          const retried = importLegacySession({ cwd: projectDir, sessionId })
          expect(retried.kind).toBe('imported')
          expect(readFileSync(destinationPath, 'utf8')).toBe(
            '{"type":"user","uuid":"u1"}\n',
          )
        },
      )
    } finally {
      rmSync(kodeRoot, { recursive: true, force: true })
      rmSync(claudeRoot, { recursive: true, force: true })
      rmSync(projectDir, { recursive: true, force: true })
    }
  })
})
