import { describe, expect, test } from 'bun:test'

import {
  ManagedAgentStoreError,
  type ManagedAgent,
  type ManagedAgentInput,
} from '@kode/agent'
import { type DaemonAgentSource } from '@kode/protocol'

import { AgentControlService } from './agentControlService'

const revision = (seed: string) => seed.repeat(64).slice(0, 64)

const definition = {
  agentType: 'review-agent',
  whenToUse: 'Review a change for correctness and regressions.',
  systemPrompt: 'Review the requested change and report concrete findings.',
  tools: ['Read', 'Grep'],
  permissionMode: 'plan' as const,
  maxExecutionTimeMs: 45_000,
}

function key(
  source: DaemonAgentSource,
  cwd: string,
  agentType: string,
): string {
  return `${source}:${cwd}:${agentType}`
}

function createHarness() {
  const entries = new Map<string, ManagedAgent>()
  const audits: Array<Record<string, unknown>> = []
  let cacheRefreshes = 0
  let nextRevision = 0
  const service = new AgentControlService({
    list: ({ source, cwd }) =>
      Array.from(entries.values()).filter(
        entry =>
          entry.source === source && (entry as { cwd?: string }).cwd === cwd,
      ),
    read: ({ source, cwd, agentType }) => {
      const entry = entries.get(key(source, cwd, agentType))
      return entry
        ? { state: 'found' as const, agent: entry }
        : { state: 'missing' as const }
    },
    create: async ({ source, cwd, input }) => {
      const id = key(source, cwd, input.agentType)
      if (entries.has(id)) throw new ManagedAgentStoreError('already_exists')
      const agent = toStored({
        source,
        cwd,
        input,
        revision: revision(String(++nextRevision)),
      })
      entries.set(id, agent)
      return agent
    },
    update: async ({ source, cwd, input, expectedRevision }) => {
      const id = key(source, cwd, input.agentType)
      const current = entries.get(id)
      if (!current) throw new ManagedAgentStoreError('not_found')
      if (current.revision !== expectedRevision) {
        throw new ManagedAgentStoreError('revision_conflict')
      }
      const agent = toStored({
        source,
        cwd,
        input,
        revision: revision(String(++nextRevision)),
      })
      entries.set(id, agent)
      return agent
    },
    delete: async ({ source, cwd, agentType, expectedRevision }) => {
      const id = key(source, cwd, agentType)
      const current = entries.get(id)
      if (!current) throw new ManagedAgentStoreError('not_found')
      if (current.revision !== expectedRevision) {
        throw new ManagedAgentStoreError('revision_conflict')
      }
      entries.delete(id)
    },
    clearCache: () => {
      cacheRefreshes += 1
    },
    listToolNames: () => ['Read', 'Grep', 'Bash'],
    audit: record => {
      audits.push(record as unknown as Record<string, unknown>)
    },
  })

  return { entries, audits, service, cacheRefreshes: () => cacheRefreshes }
}

function toStored(args: {
  source: DaemonAgentSource
  cwd: string
  input: ManagedAgentInput
  revision: string
}): ManagedAgent & { cwd: string } {
  return {
    source: args.source,
    cwd: args.cwd,
    revision: args.revision,
    ...args.input,
  }
}

describe('AgentControlService', () => {
  test('creates a validated Agent, refreshes future-task cache, and audits without a prompt', async () => {
    const harness = createHarness()
    const result = await harness.service.create({
      cwd: '/workspace',
      source: 'projectSettings',
      agent: definition,
    })

    expect(result).toMatchObject({
      ok: true,
      value: {
        appliesTo: 'new_subagents',
        agent: {
          source: 'projectSettings',
          agentType: definition.agentType,
          maxExecutionTimeMs: 45_000,
        },
      },
    })
    expect(harness.cacheRefreshes()).toBe(1)
    expect(harness.audits).toHaveLength(1)
    expect(harness.audits[0]).toMatchObject({
      action: 'create',
      outcome: 'applied',
      changedFields: expect.arrayContaining(['systemPrompt']),
    })
    expect(JSON.stringify(harness.audits[0])).not.toContain(
      definition.systemPrompt,
    )
  })

  test('rejects unavailable or malformed tools and incompatible fork context before writing', async () => {
    const harness = createHarness()
    const unavailable = await harness.service.create({
      cwd: '/workspace',
      source: 'userSettings',
      agent: { ...definition, tools: ['UnknownTool'] },
    })
    expect(unavailable).toEqual({ ok: false, reason: 'invalid' })

    const malformed = await harness.service.create({
      cwd: '/workspace',
      source: 'userSettings',
      agent: { ...definition, tools: ['Read()'] },
    })
    expect(malformed).toEqual({ ok: false, reason: 'invalid' })

    const incompatible = await harness.service.create({
      cwd: '/workspace',
      source: 'userSettings',
      agent: { ...definition, forkContext: true, model: 'opus' },
    })
    expect(incompatible).toEqual({ ok: false, reason: 'invalid' })
    expect(harness.entries.size).toBe(0)
    expect(harness.cacheRefreshes()).toBe(0)
  })

  test('uses source plus revision as the mutation identity', async () => {
    const harness = createHarness()
    const created = await harness.service.create({
      cwd: '/workspace',
      source: 'projectSettings',
      agent: definition,
    })
    if (!created.ok) throw new Error('Expected create to succeed')

    const stale = await harness.service.update({
      cwd: '/workspace',
      source: 'projectSettings',
      agentType: definition.agentType,
      expectedRevision: revision('0'),
      agent: { ...definition, color: 'blue' },
    })
    expect(stale).toEqual({ ok: false, reason: 'revision_conflict' })

    const updated = await harness.service.update({
      cwd: '/workspace',
      source: 'projectSettings',
      agentType: definition.agentType,
      expectedRevision: created.value.agent.revision,
      agent: { ...definition, color: 'blue' },
    })
    expect(updated).toMatchObject({
      ok: true,
      value: { agent: { color: 'blue' } },
    })
    expect(harness.cacheRefreshes()).toBe(2)

    const otherSource = harness.service.get({
      cwd: '/workspace',
      source: 'userSettings',
      agentType: definition.agentType,
    })
    expect(otherSource).toEqual({ ok: false, reason: 'not_found' })
  })
})
