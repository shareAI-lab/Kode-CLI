import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  __preferFilesOverMentionsForTests,
  generateSuggestionsForContext,
} from './generateSuggestions'
import type { UnifiedSuggestion } from './types'

const tempDirs: string[] = []

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'kode-completion-suggestions-'))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true })
  }
})

const exploreAgent: UnifiedSuggestion = {
  value: 'run-agent-explore',
  displayValue: '👤 run-agent-explore',
  type: 'agent',
  score: 85,
}

const srcAgent: UnifiedSuggestion = {
  value: 'run-agent-src',
  displayValue: '👤 run-agent-src',
  type: 'agent',
  score: 85,
}

describe('__preferFilesOverMentionsForTests', () => {
  test('prefers files when the prefix hits a file and no agent', () => {
    expect(
      __preferFilesOverMentionsForTests({
        prefix: 'src',
        mentionSuggestions: [exploreAgent],
        fileSuggestions: [
          { value: 'src/', displayValue: 'src/', type: 'file', score: 80 },
        ],
      }),
    ).toBe(true)
  })

  test('keeps mentions first when an agent name matches the prefix', () => {
    expect(
      __preferFilesOverMentionsForTests({
        prefix: 'src',
        mentionSuggestions: [srcAgent],
        fileSuggestions: [
          { value: 'src/', displayValue: 'src/', type: 'file', score: 80 },
        ],
      }),
    ).toBe(false)
  })

  test('keeps mentions first for an empty @ prefix', () => {
    expect(
      __preferFilesOverMentionsForTests({
        prefix: '',
        mentionSuggestions: [exploreAgent],
        fileSuggestions: [
          { value: 'src/', displayValue: 'src/', type: 'file', score: 80 },
        ],
      }),
    ).toBe(false)
  })
})

describe('generateSuggestionsForContext @ ranking', () => {
  test('ranks a cwd folder above an unrelated agent for @src', () => {
    const cwd = makeTempDir()
    mkdirSync(join(cwd, 'src'))

    const suggestions = generateSuggestionsForContext({
      context: {
        type: 'agent',
        prefix: 'src',
        startPos: 0,
        endPos: 4,
        trigger: '@',
      },
      commands: [],
      agentSuggestions: [exploreAgent],
      modelSuggestions: [],
      systemCommands: [],
      isLoadingCommands: false,
      cwd,
    })

    expect(suggestions[0]?.type).toBe('file')
    expect(suggestions[0]?.value).toBe('src/')
  })

  test('ranks a prefix-matching agent above the same-named folder', () => {
    const cwd = makeTempDir()
    mkdirSync(join(cwd, 'src'))

    const suggestions = generateSuggestionsForContext({
      context: {
        type: 'agent',
        prefix: 'src',
        startPos: 0,
        endPos: 4,
        trigger: '@',
      },
      commands: [],
      agentSuggestions: [srcAgent],
      modelSuggestions: [],
      systemCommands: [],
      isLoadingCommands: false,
      cwd,
    })

    expect(suggestions[0]?.type).toBe('agent')
    expect(suggestions[0]?.value).toBe('run-agent-src')
  })
})
