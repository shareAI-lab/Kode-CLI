import { afterEach, describe, expect, test } from 'bun:test'
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, sep } from 'node:path'

import { resolveInProjectRoot, toGitPath } from './pathSecurity'

const cleanupPaths: string[] = []

function createSandbox(): { root: string; outside: string } {
  const sandbox = mkdtempSync(join(tmpdir(), 'kode-path-security-'))
  const root = join(sandbox, 'project')
  const outside = join(sandbox, 'outside')
  mkdirSync(root)
  mkdirSync(outside)
  cleanupPaths.push(sandbox)
  return { root, outside }
}

function relativePath(from: string, to: string): string {
  return relative(from, to).split(sep).join('/')
}

afterEach(() => {
  while (cleanupPaths.length > 0) {
    const path = cleanupPaths.pop()
    if (path) rmSync(path, { recursive: true, force: true })
  }
})

describe('pathSecurity', () => {
  test('allows a deeply nested new file from the nearest existing project parent', () => {
    const { root } = createSandbox()

    const target = resolveInProjectRoot(root, 'new/deep/tree/file.txt')

    expect(relativePath(realpathSync(root), target)).toBe(
      'new/deep/tree/file.txt',
    )
    expect(toGitPath(root, 'new/deep/tree/file.txt')).toBe(
      'new/deep/tree/file.txt',
    )
  })

  test('rejects lexical and absolute paths outside the project root', () => {
    const { root, outside } = createSandbox()

    expect(() => resolveInProjectRoot(root, '../outside/secret.txt')).toThrow(
      'Path is outside of the current project directory',
    )
    expect(() =>
      resolveInProjectRoot(root, join(outside, 'secret.txt')),
    ).toThrow('Path is outside of the current project directory')
  })

  test('rejects .git paths case-insensitively before file and git operations', () => {
    const { root } = createSandbox()
    mkdirSync(join(root, '.git'), { recursive: true })

    expect(() => resolveInProjectRoot(root, '.git/config')).toThrow(
      'Access to .git is not allowed',
    )
    expect(() => resolveInProjectRoot(root, 'nested/.GIT/config')).toThrow(
      'Access to .git is not allowed',
    )
    expect(() => toGitPath(root, '.git/config')).toThrow(
      'Access to .git is not allowed',
    )
  })

  test('rejects a nested new file through a symlink or junction that escapes the project', () => {
    const { root, outside } = createSandbox()
    const outsideFile = join(outside, 'secret.txt')
    writeFileSync(outsideFile, 'secret')
    const escapeLink = join(root, 'escape')
    symlinkSync(
      outside,
      escapeLink,
      process.platform === 'win32' ? 'junction' : 'dir',
    )

    expect(() => resolveInProjectRoot(root, 'escape/new/file.txt')).toThrow(
      'Path is outside of the current project directory',
    )
    expect(() => resolveInProjectRoot(root, 'escape/secret.txt')).toThrow(
      'Path is outside of the current project directory',
    )
  })

  test('permits a symlink or junction whose real target remains in the project', () => {
    const { root } = createSandbox()
    const targetDir = join(root, 'target')
    const link = join(root, 'internal')
    mkdirSync(targetDir)
    symlinkSync(
      targetDir,
      link,
      process.platform === 'win32' ? 'junction' : 'dir',
    )

    const target = resolveInProjectRoot(root, 'internal/new/file.txt')

    expect(relativePath(realpathSync(root), target)).toBe('target/new/file.txt')
  })

  test('rejects paths whose nearest existing parent is a file', () => {
    const { root } = createSandbox()
    const file = join(root, 'not-a-directory')
    writeFileSync(file, 'content')

    expect(() =>
      resolveInProjectRoot(root, 'not-a-directory/child.txt'),
    ).toThrow('Path parent is not a directory')
  })
})
