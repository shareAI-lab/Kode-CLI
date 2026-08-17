import { describe, expect, test } from 'bun:test'
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  type ManagedAgentInput,
  ManagedAgentStoreError,
  createManagedAgent,
  deleteManagedAgent,
  listManagedAgents,
  readManagedAgent,
  updateManagedAgent,
} from './managedStorage'

function withConfigDir<T>(callback: (root: string) => Promise<T>): Promise<T> {
  const root = mkdtempSync(join(tmpdir(), 'kode-managed-agent-'))
  const previous = process.env.KODE_CONFIG_DIR
  process.env.KODE_CONFIG_DIR = join(root, 'config')

  return callback(root).finally(() => {
    if (previous === undefined) delete process.env.KODE_CONFIG_DIR
    else process.env.KODE_CONFIG_DIR = previous
    rmSync(root, { recursive: true, force: true })
  })
}

const baseInput: ManagedAgentInput = {
  agentType: 'review-agent',
  whenToUse: 'Review changes for correctness and regressions.',
  systemPrompt: 'Review the requested change and report actionable findings.',
  tools: ['Read', 'Grep'],
  maxExecutionTimeMs: 45_000,
}

describe('managed agent storage', () => {
  test('uses revision-checked atomic writes and leaves no temporary files', async () => {
    await withConfigDir(async root => {
      const workspace = join(root, 'workspace')
      mkdirSync(workspace)

      const created = await createManagedAgent({
        source: 'userSettings',
        cwd: workspace,
        input: baseInput,
      })
      expect(created.revision).toMatch(/^[a-f0-9]{64}$/)
      expect(created.maxExecutionTimeMs).toBe(45_000)
      expect(
        listManagedAgents({ source: 'userSettings', cwd: workspace }),
      ).toEqual([created])

      const forked = await createManagedAgent({
        source: 'projectSettings',
        cwd: workspace,
        input: { ...baseInput, agentType: 'forked-agent', forkContext: true },
      })
      expect(forked.forkContext).toBe(true)
      expect(
        readManagedAgent({
          source: 'projectSettings',
          cwd: workspace,
          agentType: 'forked-agent',
        }),
      ).toMatchObject({ state: 'found', agent: { forkContext: true } })

      writeFileSync(
        join(workspace, '.kode', 'agents', 'invalid-timeout-agent.md'),
        [
          '---',
          'name: "invalid-timeout-agent"',
          'description: "Reject invalid execution deadlines."',
          'tools: ["Read"]',
          'maxExecutionTimeMs: 999',
          '---',
          '',
          'Do not silently fall back to a longer deadline.',
        ].join('\n'),
        'utf8',
      )
      expect(
        readManagedAgent({
          source: 'projectSettings',
          cwd: workspace,
          agentType: 'invalid-timeout-agent',
        }),
      ).toEqual({ state: 'invalid' })

      writeFileSync(
        join(workspace, '.kode', 'agents', 'boolean-fork-agent.md'),
        [
          '---',
          'name: "boolean-fork-agent"',
          'description: "Accept YAML booleans from existing Agent files."',
          'tools: ["Read"]',
          'forkContext: true',
          '---',
          '',
          'Keep the parent context.',
        ].join('\n'),
        'utf8',
      )
      expect(
        readManagedAgent({
          source: 'projectSettings',
          cwd: workspace,
          agentType: 'boolean-fork-agent',
        }),
      ).toMatchObject({ state: 'found', agent: { forkContext: true } })

      await expect(
        updateManagedAgent({
          source: 'userSettings',
          cwd: workspace,
          expectedRevision: '0'.repeat(64),
          input: { ...baseInput, color: 'blue' },
        }),
      ).rejects.toMatchObject({
        name: ManagedAgentStoreError.name,
        reason: 'revision_conflict',
      })

      const updates = await Promise.allSettled([
        updateManagedAgent({
          source: 'userSettings',
          cwd: workspace,
          expectedRevision: created.revision,
          input: { ...baseInput, color: 'blue' },
        }),
        updateManagedAgent({
          source: 'userSettings',
          cwd: workspace,
          expectedRevision: created.revision,
          input: { ...baseInput, color: 'green' },
        }),
      ])
      expect(
        updates.filter(update => update.status === 'fulfilled'),
      ).toHaveLength(1)
      expect(
        updates.filter(update => update.status === 'rejected'),
      ).toHaveLength(1)

      const stored = readManagedAgent({
        source: 'userSettings',
        cwd: workspace,
        agentType: baseInput.agentType,
      })
      expect(stored.state).toBe('found')
      if (stored.state !== 'found') throw new Error('Expected stored agent')
      expect(stored.agent.revision).not.toBe(created.revision)

      const configDir = join(root, 'config', 'agents')
      expect(readdirSync(configDir).some(name => name.includes('.tmp.'))).toBe(
        false,
      )

      await expect(
        createManagedAgent({
          source: 'userSettings',
          cwd: workspace,
          input: {
            ...baseInput,
            agentType: 'invalid-deadline',
            maxExecutionTimeMs: 999,
          },
        }),
      ).rejects.toMatchObject({ reason: 'invalid' })

      await deleteManagedAgent({
        source: 'userSettings',
        cwd: workspace,
        agentType: baseInput.agentType,
        expectedRevision: stored.agent.revision,
      })
      expect(
        readManagedAgent({
          source: 'userSettings',
          cwd: workspace,
          agentType: baseInput.agentType,
        }),
      ).toEqual({ state: 'missing' })
    })
  })

  test('keeps legacy project agents read-only and isolates project roots', async () => {
    await withConfigDir(async root => {
      const firstWorkspace = join(root, 'first')
      const secondWorkspace = join(root, 'second')
      const legacyDir = join(firstWorkspace, '.claude', 'agents')
      mkdirSync(legacyDir, { recursive: true })
      mkdirSync(secondWorkspace)
      writeFileSync(
        join(legacyDir, 'legacy-agent.md'),
        '---\nname: legacy-agent\ndescription: "Legacy read-only agent"\ntools: [Read]\n---\n\nLegacy prompt.\n',
        'utf8',
      )

      expect(
        readManagedAgent({
          source: 'projectSettings',
          cwd: firstWorkspace,
          agentType: 'legacy-agent',
        }),
      ).toEqual({ state: 'legacy_read_only' })
      await expect(
        createManagedAgent({
          source: 'projectSettings',
          cwd: firstWorkspace,
          input: { ...baseInput, agentType: 'legacy-agent' },
        }),
      ).rejects.toMatchObject({ reason: 'legacy_read_only' })

      const created = await createManagedAgent({
        source: 'projectSettings',
        cwd: firstWorkspace,
        input: baseInput,
      })
      expect(created.source).toBe('projectSettings')
      expect(
        listManagedAgents({
          source: 'projectSettings',
          cwd: secondWorkspace,
        }),
      ).toEqual([])
    })
  })
})
