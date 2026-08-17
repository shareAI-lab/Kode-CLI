import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

import type { AgentConfig } from '@kode/agent'
import { getCwd, setCwd } from '#core/utils/state'

import { deleteAgent, updateAgent } from './storage'

describe('agents/storage Kode-first writes', () => {
  let originalCwd: string
  let projectDir: string

  beforeEach(async () => {
    originalCwd = getCwd()
    projectDir = mkdtempSync(join(tmpdir(), 'kode-agent-storage-'))
    await setCwd(projectDir)
  })

  afterEach(async () => {
    await setCwd(originalCwd)
    rmSync(projectDir, { recursive: true, force: true })
  })

  function projectAgent(agentType: string): AgentConfig {
    return {
      agentType,
      whenToUse: 'Use this agent when testing storage behavior.',
      tools: '*',
      systemPrompt: 'You are a storage behavior test agent.',
      source: 'projectSettings',
      location: 'project',
      disallowedTools: ['Write'],
      skills: ['security-review'],
      permissionMode: 'plan',
      forkContext: true,
      maxExecutionTimeMs: 45_000,
    }
  }

  test('updateAgent writes a primary .kode override instead of modifying legacy .claude', async () => {
    const legacyDir = join(projectDir, '.claude', 'agents')
    const legacyPath = join(legacyDir, 'legacy-agent.md')
    const primaryPath = join(projectDir, '.kode', 'agents', 'legacy-agent.md')
    mkdirSync(legacyDir, { recursive: true })
    writeFileSync(
      legacyPath,
      '---\nname: legacy-agent\ndescription: "legacy"\n---\n\nLegacy prompt\n',
    )

    await updateAgent(
      projectAgent('legacy-agent'),
      'Use this agent when editing legacy agents.',
      ['Read'],
      'You are an updated primary agent prompt.',
    )

    expect(existsSync(primaryPath)).toBe(true)
    expect(readFileSync(primaryPath, 'utf8')).toContain('\ntools: Read')
    expect(readFileSync(primaryPath, 'utf8')).toContain(
      '\ndisallowedTools: ["Write"]',
    )
    expect(readFileSync(primaryPath, 'utf8')).toContain(
      '\nskills: ["security-review"]',
    )
    expect(readFileSync(primaryPath, 'utf8')).toContain(
      '\npermissionMode: plan',
    )
    expect(readFileSync(primaryPath, 'utf8')).toContain('\nforkContext: true')
    expect(readFileSync(primaryPath, 'utf8')).toContain(
      '\nmaxExecutionTimeMs: 45000',
    )
    if (process.platform !== 'win32') {
      expect(statSync(join(projectDir, '.kode', 'agents')).mode & 0o777).toBe(
        0o700,
      )
      expect(statSync(primaryPath).mode & 0o777).toBe(0o600)
    }
    expect(readFileSync(legacyPath, 'utf8')).toContain('Legacy prompt')
  })

  test('deleteAgent removes only primary files and rejects legacy-only deletes', async () => {
    const primaryDir = join(projectDir, '.kode', 'agents')
    const legacyDir = join(projectDir, '.claude', 'agents')
    const primaryPath = join(primaryDir, 'demo-agent.md')
    const legacyPath = join(legacyDir, 'demo-agent.md')
    mkdirSync(primaryDir, { recursive: true })
    mkdirSync(legacyDir, { recursive: true })
    writeFileSync(
      primaryPath,
      '---\nname: demo-agent\ndescription: "primary"\n---\n\nPrimary prompt\n',
    )
    writeFileSync(
      legacyPath,
      '---\nname: demo-agent\ndescription: "legacy"\n---\n\nLegacy prompt\n',
    )

    await deleteAgent(projectAgent('demo-agent'))
    expect(existsSync(primaryPath)).toBe(false)
    expect(existsSync(legacyPath)).toBe(true)

    await expect(deleteAgent(projectAgent('demo-agent'))).rejects.toThrow(
      'Cannot delete legacy agent "demo-agent" from .claude',
    )
    expect(existsSync(legacyPath)).toBe(true)
  })
})
