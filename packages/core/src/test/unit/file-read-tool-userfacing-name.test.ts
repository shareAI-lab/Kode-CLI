import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { setCwd, setOriginalCwd } from '#core/utils/state'
import { FileReadTool } from '#tools/tools/filesystem/FileReadTool/FileReadTool'

function sanitizeProjectKey(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-')
}

describe('FileReadTool userFacingName parity', () => {
  const runnerCwd = process.cwd()

  let configDir: string
  let projectDir: string
  let tmpClaude: string
  let previousKodeConfigDir: string | undefined
  let previousClaudeTmpDir: string | undefined
  let previousClaudeTmp: string | undefined
  let previousKodeProjectDir: string | undefined

  beforeEach(async () => {
    previousKodeConfigDir = process.env.KODE_CONFIG_DIR
    previousClaudeTmpDir = process.env.CLAUDE_TMPDIR
    previousClaudeTmp = process.env.CLAUDE_CODE_TMPDIR
    previousKodeProjectDir = process.env.KODE_PROJECT_DIR

    configDir = mkdtempSync(join(tmpdir(), 'kode-read-name-config-'))
    projectDir = mkdtempSync(join(tmpdir(), 'kode-read-name-proj-'))
    tmpClaude = mkdtempSync(join(tmpdir(), 'kode-read-name-tmp-'))

    process.env.KODE_CONFIG_DIR = configDir
    delete process.env.CLAUDE_TMPDIR
    process.env.CLAUDE_CODE_TMPDIR = tmpClaude
    process.env.KODE_PROJECT_DIR = projectDir
    setOriginalCwd(projectDir)
    await setCwd(projectDir)
  })

  afterEach(async () => {
    await setCwd(runnerCwd)
    setOriginalCwd(runnerCwd)
    if (previousKodeConfigDir === undefined) {
      delete process.env.KODE_CONFIG_DIR
    } else {
      process.env.KODE_CONFIG_DIR = previousKodeConfigDir
    }
    if (previousClaudeTmpDir === undefined) {
      delete process.env.CLAUDE_TMPDIR
    } else {
      process.env.CLAUDE_TMPDIR = previousClaudeTmpDir
    }
    if (previousClaudeTmp === undefined) {
      delete process.env.CLAUDE_CODE_TMPDIR
    } else {
      process.env.CLAUDE_CODE_TMPDIR = previousClaudeTmp
    }
    if (previousKodeProjectDir === undefined) {
      delete process.env.KODE_PROJECT_DIR
    } else {
      process.env.KODE_PROJECT_DIR = previousKodeProjectDir
    }
    rmSync(configDir, { recursive: true, force: true })
    rmSync(projectDir, { recursive: true, force: true })
    rmSync(tmpClaude, { recursive: true, force: true })
  })

  test('shows Reading Plan for plan directory paths', () => {
    const planPath = join(configDir, 'plans', 'abc.md')
    expect(FileReadTool.userFacingName?.({ file_path: planPath } as any)).toBe(
      'Reading Plan',
    )
  })

  test('shows Read agent output for Kode tasks/*.output paths', () => {
    const projectKey = sanitizeProjectKey(projectDir)
    const outputPath = join(configDir, projectKey, 'tasks', 'task_1.output')
    expect(
      FileReadTool.userFacingName?.({ file_path: outputPath } as any),
    ).toBe('Read agent output')
  })

  test('shows Read agent output for Claude tmpdir tasks/*.output paths', () => {
    const projectKey = sanitizeProjectKey(projectDir)
    const outputPath = join(
      tmpClaude,
      'claude',
      projectKey,
      'tasks',
      'task_2.output',
    )
    expect(
      FileReadTool.userFacingName?.({ file_path: outputPath } as any),
    ).toBe('Read agent output')
  })

  test('falls back to Read for ordinary files', () => {
    const regularPath = join(projectDir, 'README.md')
    expect(
      FileReadTool.userFacingName?.({ file_path: regularPath } as any),
    ).toBe('Read')
  })
})
