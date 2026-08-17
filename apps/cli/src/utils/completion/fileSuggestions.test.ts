import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { generateFileSuggestions } from './fileSuggestions'

const tempDirs: string[] = []

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'kode-file-suggestions-'))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true })
  }
})

describe('generateFileSuggestions', () => {
  test('sorts directories before files while preserving prefix filtering', () => {
    const cwd = makeTempDir()
    mkdirSync(join(cwd, 'apple-dir'))
    mkdirSync(join(cwd, 'apricot-dir'))
    writeFileSync(join(cwd, 'apple-file.txt'), '')
    writeFileSync(join(cwd, 'banana-file.txt'), '')

    const suggestions = generateFileSuggestions({ prefix: 'ap', cwd })

    expect(suggestions.map(item => item.value)).toEqual([
      'apple-dir/',
      'apricot-dir/',
      'apple-file.txt',
    ])
  })

  test('fuzzy-matches file names that do not share a prefix', () => {
    const cwd = makeTempDir()
    writeFileSync(join(cwd, 'package.json'), '')
    writeFileSync(join(cwd, 'README.md'), '')

    const suggestions = generateFileSuggestions({ prefix: 'pkg', cwd })

    expect(suggestions.map(item => item.value)).toContain('package.json')
  })

  test('keeps prefix matches ahead of fuzzy matches and skips single chars', () => {
    const cwd = makeTempDir()
    writeFileSync(join(cwd, 'pack.json'), '')
    writeFileSync(join(cwd, 'package-lock.json'), '')
    writeFileSync(join(cwd, 'dist.txt'), '')

    const suggestions = generateFileSuggestions({ prefix: 'pack', cwd })

    const values = suggestions.map(item => item.value)
    expect(values.indexOf('pack.json')).toBeLessThan(
      values.indexOf('package-lock.json'),
    )

    const singleChar = generateFileSuggestions({ prefix: 'd', cwd })
    expect(singleChar.map(item => item.value)).toEqual(['dist.txt'])
  })

  test('drops entries that neither prefix-match nor fuzzy-match in one pass', () => {
    const cwd = makeTempDir()
    writeFileSync(join(cwd, 'package.json'), '')
    writeFileSync(join(cwd, 'README.md'), '')
    writeFileSync(join(cwd, 'CHANGELOG.md'), '')

    const suggestions = generateFileSuggestions({ prefix: 'pkg', cwd })

    const values = suggestions.map(item => item.value)
    expect(values).toContain('package.json')
    // Unrelated names are filtered out entirely.
    expect(values).not.toContain('README.md')
    expect(values).not.toContain('CHANGELOG.md')
  })
})
