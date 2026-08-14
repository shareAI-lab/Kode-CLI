import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  addToHistory,
  getGlobalHistoryWithPastes,
  getHistoryWithPastes,
} from '#core/history'
import { flushPendingSync } from '#core/utils/jsonlWriter'
import { setCwd } from '#core/utils/state'

describe('prompt history (pasted content replay)', () => {
  const runnerCwd = process.cwd()
  const originalHome = process.env.HOME
  const originalKodeConfigDir = process.env.KODE_CONFIG_DIR
  const originalClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR

  let homeDir: string
  let configDir: string
  let projectDir: string

  beforeEach(async () => {
    homeDir = mkdtempSync(join(tmpdir(), 'kode-history-home-'))
    configDir = mkdtempSync(join(tmpdir(), 'kode-history-config-'))
    projectDir = mkdtempSync(join(tmpdir(), 'kode-history-project-'))

    process.env.HOME = homeDir
    process.env.KODE_CONFIG_DIR = configDir
    delete process.env.ANYKODE_CONFIG_DIR
    delete process.env.KODE_SKIP_PROMPT_HISTORY
    delete process.env.CLAUDE_CODE_SKIP_PROMPT_HISTORY
    delete process.env.CLAUDE_CONFIG_DIR

    await setCwd(projectDir)
  })

  afterEach(async () => {
    await setCwd(runnerCwd)

    if (originalHome === undefined) delete process.env.HOME
    else process.env.HOME = originalHome

    if (originalKodeConfigDir === undefined) delete process.env.KODE_CONFIG_DIR
    else process.env.KODE_CONFIG_DIR = originalKodeConfigDir

    if (originalClaudeConfigDir === undefined)
      delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = originalClaudeConfigDir

    delete process.env.KODE_SKIP_PROMPT_HISTORY
    delete process.env.CLAUDE_CODE_SKIP_PROMPT_HISTORY

    rmSync(homeDir, { recursive: true, force: true })
    rmSync(configDir, { recursive: true, force: true })
    rmSync(projectDir, { recursive: true, force: true })
  })

  test('stores large pasted text in paste-cache and rehydrates for Ctrl+R/↑ history', () => {
    const pastedText = 'x'.repeat(1500)

    addToHistory({
      display: 'hello [Pasted text #1 +3 lines] world',
      pastedContents: {
        1: { id: 1, type: 'text', content: pastedText },
      },
    })

    const historyFile = join(configDir, 'history.jsonl')
    flushPendingSync(historyFile)
    expect(existsSync(historyFile)).toBe(true)

    const rawLine = readFileSync(historyFile, 'utf8').trim()
    const parsed = JSON.parse(rawLine) as {
      display: string
      pastedContents: Record<string, { contentHash?: string; content?: string }>
    }

    expect(parsed.display).toBe('hello [Pasted text #1 +3 lines] world')
    expect(parsed.pastedContents['1']?.content).toBeUndefined()
    expect(typeof parsed.pastedContents['1']?.contentHash).toBe('string')
    expect(
      existsSync(
        join(
          configDir,
          'paste-cache',
          `${parsed.pastedContents['1']?.contentHash}.txt`,
        ),
      ),
    ).toBe(true)

    const items = getHistoryWithPastes()
    expect(items.length).toBeGreaterThan(0)

    expect(items[0]?.display).toBe('hello [Pasted text #1 +3 lines] world')
    expect(items[0]?.pastedTexts).toEqual([
      { placeholder: '[Pasted text #1 +3 lines]', text: pastedText },
    ])
  })

  test('respects KODE_SKIP_PROMPT_HISTORY', () => {
    process.env.KODE_SKIP_PROMPT_HISTORY = 'true'
    addToHistory('hello')
    expect(existsSync(join(configDir, 'history.jsonl'))).toBe(false)
  })

  test('Ctrl+R history search is global across projects', async () => {
    const projectDir2 = mkdtempSync(join(tmpdir(), 'kode-history-project2-'))

    await setCwd(projectDir)
    addToHistory('from project 1')

    await setCwd(projectDir2)
    addToHistory('from project 2')

    const globalHistory = getGlobalHistoryWithPastes().map(h => h.display)
    expect(globalHistory).toContain('from project 1')
    expect(globalHistory).toContain('from project 2')

    const project2History = getHistoryWithPastes().map(h => h.display)
    expect(project2History).toContain('from project 2')
    expect(project2History).not.toContain('from project 1')

    rmSync(projectDir2, { recursive: true, force: true })
  })
})
