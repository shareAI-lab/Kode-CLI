import { mkdtempSync, mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import {
  findGitRoot,
  getProjectInstructionFiles,
  readAndConcatProjectInstructionFiles,
} from '../../projectInstructions'

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'kode-context-test-'))
})

afterEach(() => {
  // temp dirs cleaned by OS
})

describe('findGitRoot', () => {
  test('finds git root from nested cwd', () => {
    mkdirSync(join(root, 'src', 'nested'), { recursive: true })
    mkdirSync(join(root, '.git'))
    expect(findGitRoot(join(root, 'src', 'nested'))).toBe(root)
  })

  test('returns null when no .git exists', () => {
    mkdirSync(join(root, 'src'), { recursive: true })
    expect(findGitRoot(join(root, 'src'))).toBeNull()
  })
})

describe('getProjectInstructionFiles', () => {
  test('finds AGENTS.md at git root', () => {
    mkdirSync(join(root, '.git'))
    writeFileSync(join(root, 'AGENTS.md'), '# Instructions')
    const files = getProjectInstructionFiles(root)
    expect(files).toHaveLength(1)
    expect(files[0]!.filename).toBe('AGENTS.md')
    expect(files[0]!.absolutePath).toBe(join(root, 'AGENTS.md'))
  })

  test('finds AGENTS.override.md at git root', () => {
    mkdirSync(join(root, '.git'))
    writeFileSync(join(root, 'AGENTS.override.md'), '# Override')
    const files = getProjectInstructionFiles(root)
    expect(files).toHaveLength(1)
    expect(files[0]!.filename).toBe('AGENTS.override.md')
  })

  test('returns empty when no instruction files', () => {
    mkdirSync(join(root, '.git'))
    expect(getProjectInstructionFiles(root)).toHaveLength(0)
  })
})

describe('readAndConcatProjectInstructionFiles', () => {
  test('concatenates multiple files with headings', () => {
    mkdirSync(join(root, '.git'))
    writeFileSync(join(root, 'AGENTS.md'), 'Root instructions')
    mkdirSync(join(root, 'src'))
    writeFileSync(join(root, 'src', 'AGENTS.md'), 'Src instructions')

    const files = getProjectInstructionFiles(join(root, 'src'))
    expect(files).toHaveLength(2)

    const { content } = readAndConcatProjectInstructionFiles(files, {
      includeHeadings: true,
    })
    expect(content).toContain('Root instructions')
    expect(content).toContain('Src instructions')
  })
})
