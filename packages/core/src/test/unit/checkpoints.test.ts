import { describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  captureCheckpoint,
  getCheckpointDir,
  restoreCheckpoint,
} from '#core/checkpoints'

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' })
}

function createRepository(): {
  root: string
  repo: string
  storageRoot: string
} {
  const root = mkdtempSync(join(tmpdir(), 'kode-checkpoint-'))
  const repo = join(root, 'repo')
  const storageRoot = join(root, 'storage')
  mkdirSync(repo)
  git(repo, 'init')
  git(repo, 'config', 'user.email', 'test@example.com')
  git(repo, 'config', 'user.name', 'Kode Test')
  git(repo, 'config', 'core.autocrlf', 'false')
  writeFileSync(join(repo, 'staged.txt'), 'base-staged\n')
  writeFileSync(join(repo, 'unstaged.txt'), 'base-unstaged\n')
  git(repo, 'add', '.')
  git(repo, 'commit', '-m', 'initial')
  return { root, repo, storageRoot }
}

describe('git checkpoints', () => {
  test('fails closed on drift, preserves emergency snapshot, and restores only with force', () => {
    const fixture = createRepository()
    try {
      writeFileSync(join(fixture.repo, 'staged.txt'), 'checkpoint-staged\n')
      git(fixture.repo, 'add', 'staged.txt')
      writeFileSync(join(fixture.repo, 'unstaged.txt'), 'checkpoint-unstaged\n')
      writeFileSync(join(fixture.repo, 'new.txt'), 'checkpoint-untracked\n')
      const checkpoint = captureCheckpoint({
        cwd: fixture.repo,
        storageRoot: fixture.storageRoot,
        id: 'before-change',
      })

      writeFileSync(join(fixture.repo, 'staged.txt'), 'changed-staged\n')
      git(fixture.repo, 'add', 'staged.txt')
      writeFileSync(join(fixture.repo, 'unstaged.txt'), 'changed-unstaged\n')
      writeFileSync(join(fixture.repo, 'new.txt'), 'changed-untracked\n')

      const refused = restoreCheckpoint({
        cwd: fixture.repo,
        storageRoot: fixture.storageRoot,
        id: checkpoint.id,
      })
      expect(refused.ok).toBe(false)
      if (!('reason' in refused)) throw new Error('expected drift refusal')
      expect(refused.reason).toBe('workspace_drift')
      expect(refused.emergencyCheckpoint?.kind).toBe('emergency')
      expect(
        existsSync(
          getCheckpointDir({
            repoRoot: fixture.repo,
            storageRoot: fixture.storageRoot,
            id: refused.emergencyCheckpoint!.id,
          }),
        ),
      ).toBe(true)

      const restored = restoreCheckpoint({
        cwd: fixture.repo,
        storageRoot: fixture.storageRoot,
        id: checkpoint.id,
        force: true,
      })
      expect(restored.ok).toBe(true)
      expect(readFileSync(join(fixture.repo, 'staged.txt'), 'utf8')).toBe(
        'checkpoint-staged\n',
      )
      expect(readFileSync(join(fixture.repo, 'unstaged.txt'), 'utf8')).toBe(
        'checkpoint-unstaged\n',
      )
      expect(readFileSync(join(fixture.repo, 'new.txt'), 'utf8')).toBe(
        'checkpoint-untracked\n',
      )
      expect(
        git(fixture.repo, 'diff', '--cached', '--', 'staged.txt'),
      ).toContain('checkpoint-staged')
      expect(git(fixture.repo, 'diff', '--', 'unstaged.txt')).toContain(
        'checkpoint-unstaged',
      )
    } finally {
      rmSync(fixture.root, { recursive: true, force: true })
    }
  }, 20_000)

  test('rejects a checkpoint store nested in the target repository', () => {
    const fixture = createRepository()
    try {
      const nestedStore = join(fixture.repo, '.kode', 'checkpoints')
      expect(() =>
        captureCheckpoint({
          cwd: fixture.repo,
          storageRoot: nestedStore,
        }),
      ).toThrow('outside the target repository')
      expect(existsSync(nestedStore)).toBe(false)
    } finally {
      rmSync(fixture.root, { recursive: true, force: true })
    }
  })

  test('restores the emergency checkpoint when a target patch fails after reset', () => {
    const fixture = createRepository()
    try {
      writeFileSync(join(fixture.repo, 'unstaged.txt'), 'target-state\n')
      const checkpoint = captureCheckpoint({
        cwd: fixture.repo,
        storageRoot: fixture.storageRoot,
        id: 'corrupt-target',
      })
      writeFileSync(join(fixture.repo, 'unstaged.txt'), 'current-state\n')
      writeFileSync(
        join(
          getCheckpointDir({
            repoRoot: fixture.repo,
            storageRoot: fixture.storageRoot,
            id: checkpoint.id,
          }),
          checkpoint.worktreePatch,
        ),
        'this is not a valid git patch\n',
      )

      const result = restoreCheckpoint({
        cwd: fixture.repo,
        storageRoot: fixture.storageRoot,
        id: checkpoint.id,
        force: true,
      })
      expect(result.ok).toBe(false)
      if (!('reason' in result)) throw new Error('expected restore failure')
      expect(result.reason).toBe('restore_failed')
      expect(result.error).toContain('Emergency checkpoint')
      expect(readFileSync(join(fixture.repo, 'unstaged.txt'), 'utf8')).toBe(
        'current-state\n',
      )
    } finally {
      rmSync(fixture.root, { recursive: true, force: true })
    }
  }, 20_000)
})
