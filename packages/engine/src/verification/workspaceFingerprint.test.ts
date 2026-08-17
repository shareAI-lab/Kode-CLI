import { afterEach, describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { captureWorkspaceFingerprint } from './workspaceFingerprint'

const temporaryDirectories: string[] = []

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' })
}

function createRepository(): string {
  const directory = mkdtempSync(join(tmpdir(), 'kode-workspace-fingerprint-'))
  temporaryDirectories.push(directory)
  git(directory, 'init', '--quiet')
  git(directory, 'config', 'user.name', 'Kode Test')
  git(directory, 'config', 'user.email', 'kode-test@example.invalid')
  writeFileSync(join(directory, 'tracked.ts'), 'export const value = 1\n')
  git(directory, 'add', 'tracked.ts')
  git(directory, 'commit', '--quiet', '-m', 'fixture')
  return directory
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('workspace fingerprint', () => {
  test('stays stable for reads and changes for tracked or untracked edits', () => {
    const directory = createRepository()
    const initial = captureWorkspaceFingerprint(directory)

    expect(initial).toMatch(/^[a-f0-9]{64}$/)
    expect(captureWorkspaceFingerprint(directory)).toBe(initial)

    writeFileSync(join(directory, 'tracked.ts'), 'export const value = 2\n')
    const trackedChange = captureWorkspaceFingerprint(directory)
    expect(trackedChange).not.toBe(initial)

    writeFileSync(join(directory, 'new.ts'), 'export const added = true\n')
    const untrackedChange = captureWorkspaceFingerprint(directory)
    expect(untrackedChange).not.toBe(trackedChange)

    writeFileSync(join(directory, 'new.ts'), 'export const added = false\n')
    expect(captureWorkspaceFingerprint(directory)).not.toBe(untrackedChange)
  })

  test('ignores index-only changes so staging does not stale prior tests', () => {
    const directory = createRepository()
    writeFileSync(join(directory, 'tracked.ts'), 'export const value = 2\n')
    const beforeStage = captureWorkspaceFingerprint(directory)

    git(directory, 'add', 'tracked.ts')

    expect(captureWorkspaceFingerprint(directory)).toBe(beforeStage)
  })

  test('returns null outside a Git worktree', () => {
    const directory = mkdtempSync(join(tmpdir(), 'kode-not-a-repo-'))
    temporaryDirectories.push(directory)
    expect(captureWorkspaceFingerprint(directory)).toBeNull()
  })
})
