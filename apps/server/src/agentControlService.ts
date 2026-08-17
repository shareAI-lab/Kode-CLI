import { createHash } from 'node:crypto'
import { resolve } from 'node:path'

import {
  ManagedAgentStoreError,
  clearAgentCache,
  createManagedAgent,
  deleteManagedAgent,
  getToolNameFromSpec,
  listManagedAgents,
  readManagedAgent,
  updateManagedAgent,
  type ManagedAgent,
  type ManagedAgentInput,
} from '@kode/agent'
import type {
  DaemonAgentDefinition,
  DaemonAgentMutationResponse,
  DaemonAgentSource,
  DaemonManagedAgent,
} from '@kode/protocol'
import { normalizePermissionMode } from '#core/types/PermissionMode'

import { appendAgentAuditRecord } from './agentAuditStore'

export type AgentControlFailure =
  | 'not_found'
  | 'legacy_read_only'
  | 'already_exists'
  | 'revision_conflict'
  | 'invalid'
  | 'persistence_failed'

export type AgentControlResult<T> =
  { ok: true; value: T } | { ok: false; reason: AgentControlFailure }

type AgentControlDependencies = {
  list: (args: { source: DaemonAgentSource; cwd: string }) => ManagedAgent[]
  read: (args: {
    source: DaemonAgentSource
    cwd: string
    agentType: string
  }) => ReturnType<typeof readManagedAgent>
  create: (args: {
    source: DaemonAgentSource
    cwd: string
    input: ManagedAgentInput
  }) => Promise<ManagedAgent>
  update: (args: {
    source: DaemonAgentSource
    cwd: string
    input: ManagedAgentInput
    expectedRevision: string
  }) => Promise<ManagedAgent>
  delete: (args: {
    source: DaemonAgentSource
    cwd: string
    agentType: string
    expectedRevision: string
  }) => Promise<void>
  clearCache: () => void
  listToolNames: () => readonly string[]
  audit: (args: {
    cwd: string
    action: 'create' | 'update' | 'delete'
    source: DaemonAgentSource
    agentType: string
    outcome: 'applied' | 'rejected'
    revision: string | null
    changedFields: string[]
    systemPromptHash: string | null
    reason?: string
  }) => void
}

function defaultDependencies(): AgentControlDependencies {
  return {
    list: listManagedAgents,
    read: readManagedAgent,
    create: createManagedAgent,
    update: updateManagedAgent,
    delete: deleteManagedAgent,
    clearCache: clearAgentCache,
    listToolNames: () => [],
    audit: appendAgentAuditRecord,
  }
}

function toProtocolAgent(agent: ManagedAgent): DaemonManagedAgent {
  const output: DaemonManagedAgent = {
    source: agent.source,
    agentType: agent.agentType,
    whenToUse: agent.whenToUse,
    systemPrompt: agent.systemPrompt,
    tools: agent.tools,
    revision: agent.revision,
  }
  if (agent.disallowedTools !== undefined) {
    output.disallowedTools = [...agent.disallowedTools]
  }
  if (agent.model !== undefined) output.model = agent.model
  if (agent.permissionMode !== undefined) {
    output.permissionMode = normalizePermissionMode(agent.permissionMode)
  }
  if (agent.forkContext === true) output.forkContext = true
  if (agent.maxExecutionTimeMs !== undefined) {
    output.maxExecutionTimeMs = agent.maxExecutionTimeMs
  }
  if (agent.color !== undefined) output.color = agent.color
  return output
}

function toStorageInput(input: DaemonAgentDefinition): ManagedAgentInput {
  const output: ManagedAgentInput = {
    agentType: input.agentType,
    whenToUse: input.whenToUse,
    systemPrompt: input.systemPrompt,
    tools: input.tools,
  }
  if (input.disallowedTools !== undefined) {
    output.disallowedTools = [...input.disallowedTools]
  }
  if (input.model !== undefined) output.model = input.model
  if (input.permissionMode !== undefined) {
    output.permissionMode = input.permissionMode
  }
  if (input.forkContext === true) output.forkContext = true
  if (input.maxExecutionTimeMs !== undefined) {
    output.maxExecutionTimeMs = input.maxExecutionTimeMs
  }
  if (input.color !== undefined) output.color = input.color
  return output
}

function promptHash(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function changedFields(
  previous: ManagedAgent | null,
  next: DaemonAgentDefinition | null,
): string[] {
  if (!previous && next) {
    return [
      'agentType',
      'whenToUse',
      'systemPrompt',
      'tools',
      'disallowedTools',
      'model',
      'permissionMode',
      'forkContext',
      'maxExecutionTimeMs',
      'color',
    ].filter(key => key in next)
  }
  if (previous && !next) return ['deleted']
  if (!previous || !next) return []

  const keys: Array<keyof DaemonAgentDefinition> = [
    'whenToUse',
    'systemPrompt',
    'tools',
    'disallowedTools',
    'model',
    'permissionMode',
    'forkContext',
    'maxExecutionTimeMs',
    'color',
  ]
  return keys.filter(key => {
    const before = previous[key as keyof ManagedAgent]
    const after = next[key]
    return JSON.stringify(before ?? null) !== JSON.stringify(after ?? null)
  })
}

/**
 * Workspace-explicit daemon Agent control. Changes are persisted to Kode-owned
 * user/project files and only apply when a subsequent TaskTool run snapshots
 * the refreshed configuration.
 */
export class AgentControlService {
  private readonly deps: AgentControlDependencies

  constructor(dependencies: Partial<AgentControlDependencies> = {}) {
    this.deps = { ...defaultDependencies(), ...dependencies }
  }

  list(args: { cwd: string }): DaemonManagedAgent[] {
    const cwd = resolve(args.cwd)
    return (['userSettings', 'projectSettings'] as const)
      .flatMap(source => this.deps.list({ source, cwd }))
      .map(toProtocolAgent)
      .sort(
        (left, right) =>
          left.agentType.localeCompare(right.agentType) ||
          left.source.localeCompare(right.source),
      )
  }

  get(args: {
    cwd: string
    source: DaemonAgentSource
    agentType: string
  }): AgentControlResult<DaemonManagedAgent> {
    const cwd = resolve(args.cwd)
    try {
      const current = this.deps.read({ ...args, cwd })
      if (current.state === 'found') {
        return { ok: true, value: toProtocolAgent(current.agent) }
      }
      return { ok: false, reason: this.reasonForRead(current.state) }
    } catch {
      return { ok: false, reason: 'invalid' }
    }
  }

  async create(args: {
    cwd: string
    source: DaemonAgentSource
    agent: DaemonAgentDefinition
  }): Promise<AgentControlResult<DaemonAgentMutationResponse>> {
    const cwd = resolve(args.cwd)
    const validation = this.validate(args.agent)
    if (validation) {
      return this.reject({ ...args, cwd, action: 'create', reason: validation })
    }

    try {
      const created = await this.deps.create({
        source: args.source,
        cwd,
        input: toStorageInput(args.agent),
      })
      this.refreshCache()
      const output = toProtocolAgent(created)
      this.safeAudit({
        cwd,
        action: 'create',
        source: args.source,
        agentType: output.agentType,
        outcome: 'applied',
        revision: output.revision,
        changedFields: changedFields(null, args.agent),
        systemPromptHash: promptHash(args.agent.systemPrompt),
      })
      return {
        ok: true,
        value: { agent: output, appliesTo: 'new_subagents' },
      }
    } catch (error) {
      return this.reject({
        ...args,
        cwd,
        action: 'create',
        reason: this.reasonForError(error),
      })
    }
  }

  async update(args: {
    cwd: string
    source: DaemonAgentSource
    agentType: string
    expectedRevision: string
    agent: DaemonAgentDefinition
  }): Promise<AgentControlResult<DaemonAgentMutationResponse>> {
    const cwd = resolve(args.cwd)
    if (args.agentType.trim() !== args.agent.agentType) {
      return this.reject({ ...args, cwd, action: 'update', reason: 'invalid' })
    }
    const validation = this.validate(args.agent)
    if (validation) {
      return this.reject({ ...args, cwd, action: 'update', reason: validation })
    }

    let previous: ManagedAgent | null = null
    try {
      const read = this.deps.read({
        source: args.source,
        cwd,
        agentType: args.agentType,
      })
      if (read.state !== 'found') {
        return this.reject({
          ...args,
          cwd,
          action: 'update',
          reason: this.reasonForRead(read.state),
        })
      }
      previous = read.agent
      const updated = await this.deps.update({
        source: args.source,
        cwd,
        input: toStorageInput(args.agent),
        expectedRevision: args.expectedRevision,
      })
      this.refreshCache()
      const output = toProtocolAgent(updated)
      this.safeAudit({
        cwd,
        action: 'update',
        source: args.source,
        agentType: output.agentType,
        outcome: 'applied',
        revision: output.revision,
        changedFields: changedFields(previous, args.agent),
        systemPromptHash:
          previous.systemPrompt === args.agent.systemPrompt
            ? null
            : promptHash(args.agent.systemPrompt),
      })
      return {
        ok: true,
        value: { agent: output, appliesTo: 'new_subagents' },
      }
    } catch (error) {
      return this.reject({
        ...args,
        cwd,
        action: 'update',
        reason: this.reasonForError(error),
        previous,
      })
    }
  }

  async delete(args: {
    cwd: string
    source: DaemonAgentSource
    agentType: string
    expectedRevision: string
  }): Promise<AgentControlResult<{ deleted: boolean }>> {
    const cwd = resolve(args.cwd)
    let previous: ManagedAgent | null = null
    try {
      const read = this.deps.read({
        source: args.source,
        cwd,
        agentType: args.agentType,
      })
      if (read.state !== 'found') {
        return this.reject({
          ...args,
          cwd,
          action: 'delete',
          reason: this.reasonForRead(read.state),
        })
      }
      previous = read.agent
      await this.deps.delete({
        source: args.source,
        cwd,
        agentType: args.agentType,
        expectedRevision: args.expectedRevision,
      })
      this.refreshCache()
      this.safeAudit({
        cwd,
        action: 'delete',
        source: args.source,
        agentType: args.agentType,
        outcome: 'applied',
        revision: previous.revision,
        changedFields: changedFields(previous, null),
        systemPromptHash: null,
      })
      return { ok: true, value: { deleted: true } }
    } catch (error) {
      return this.reject({
        ...args,
        cwd,
        action: 'delete',
        reason: this.reasonForError(error),
        previous,
      })
    }
  }

  private validate(agent: DaemonAgentDefinition): AgentControlFailure | null {
    if (
      agent.forkContext === true &&
      agent.model !== undefined &&
      agent.model !== 'inherit'
    ) {
      return 'invalid'
    }

    const validTools = new Set(this.deps.listToolNames())
    const specs = [
      ...(agent.tools === '*' ? [] : agent.tools),
      ...(agent.disallowedTools ?? []),
    ]
    for (const spec of specs) {
      let name: string
      try {
        name = getToolNameFromSpec(spec)
      } catch {
        return 'invalid'
      }
      if (validTools.size > 0 && !validTools.has(name)) return 'invalid'
    }
    return null
  }

  private reasonForRead(
    state: Exclude<ReturnType<typeof readManagedAgent>['state'], 'found'>,
  ): AgentControlFailure {
    switch (state) {
      case 'missing':
        return 'not_found'
      case 'legacy_read_only':
        return 'legacy_read_only'
      case 'invalid':
        return 'invalid'
    }
  }

  private reasonForError(error: unknown): AgentControlFailure {
    if (error instanceof ManagedAgentStoreError) {
      switch (error.reason) {
        case 'already_exists':
        case 'not_found':
        case 'legacy_read_only':
        case 'revision_conflict':
        case 'invalid':
          return error.reason
      }
    }
    return 'persistence_failed'
  }

  private reject(args: {
    cwd: string
    source: DaemonAgentSource
    agentType?: string
    agent?: DaemonAgentDefinition
    action?: 'create' | 'update' | 'delete'
    reason: AgentControlFailure
    previous?: ManagedAgent | null
  }): AgentControlResult<never> {
    const action = args.action ?? (args.agent ? 'create' : 'delete')
    const agentType = args.agent?.agentType ?? args.agentType ?? 'unknown'
    this.safeAudit({
      cwd: args.cwd,
      action,
      source: args.source,
      agentType,
      outcome: 'rejected',
      revision: args.previous?.revision ?? null,
      changedFields: [],
      systemPromptHash: null,
      reason: args.reason,
    })
    return { ok: false, reason: args.reason }
  }

  private refreshCache(): void {
    try {
      this.deps.clearCache()
    } catch {
      /* no-op */
    }
  }

  private safeAudit(
    args: Parameters<AgentControlDependencies['audit']>[0],
  ): void {
    try {
      this.deps.audit(args)
    } catch {
      /* no-op */
    }
  }
}
