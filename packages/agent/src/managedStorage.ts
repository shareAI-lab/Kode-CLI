import { createHash, randomUUID } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'

import { getClaudeCompatRoots, getKodeRoot } from '#config/dataRoots'
import { LEGACY_CONFIG_SUBDIRS } from '#core/compat/legacyPaths'

import type { AgentConfig, AgentModel, AgentPermissionMode } from './types'
import { parseAgentFromFile } from './validator'

export type MutableAgentSource = 'userSettings' | 'projectSettings'

export type ManagedAgentInput = {
  agentType: string
  whenToUse: string
  systemPrompt: string
  tools: string[] | '*'
  disallowedTools?: string[]
  model?: AgentModel
  permissionMode?: AgentPermissionMode
  forkContext?: boolean
  maxExecutionTimeMs?: number
  color?: string
}

export type ManagedAgent = ManagedAgentInput & {
  source: MutableAgentSource
  revision: string
}

export type ManagedAgentReadResult =
  | { state: 'found'; agent: ManagedAgent }
  | { state: 'missing' }
  | { state: 'legacy_read_only' }
  | { state: 'invalid' }

export type ManagedAgentStoreFailure =
  | 'already_exists'
  | 'not_found'
  | 'legacy_read_only'
  | 'revision_conflict'
  | 'invalid'

export class ManagedAgentStoreError extends Error {
  constructor(readonly reason: ManagedAgentStoreFailure) {
    super(`Managed agent storage failed: ${reason}`)
    this.name = 'ManagedAgentStoreError'
  }
}

const AGENTS_DIR = 'agents'
const AGENT_TYPE_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9-]*[a-zA-Z0-9]$/
const writeLocks = new Map<string, Promise<void>>()

function assertAgentType(agentType: string): string {
  const normalized = agentType.trim()
  if (
    normalized.length < 3 ||
    normalized.length > 50 ||
    !AGENT_TYPE_PATTERN.test(normalized)
  ) {
    throw new ManagedAgentStoreError('invalid')
  }
  return normalized
}

function revisionFor(content: string): string {
  return createHash('sha256').update(content).digest('hex')
}

function primaryDirectory(args: {
  source: MutableAgentSource
  cwd: string
}): string {
  return args.source === 'userSettings'
    ? join(getKodeRoot(), AGENTS_DIR)
    : join(resolve(args.cwd), '.kode', AGENTS_DIR)
}

function legacyPaths(args: {
  source: MutableAgentSource
  cwd: string
  agentType: string
}): string[] {
  const filename = `${args.agentType}.md`
  if (args.source === 'userSettings') {
    return getClaudeCompatRoots().map(root => join(root, AGENTS_DIR, filename))
  }
  return [join(resolve(args.cwd), LEGACY_CONFIG_SUBDIRS.agents, filename)]
}

export function getManagedAgentFilePath(args: {
  source: MutableAgentSource
  cwd: string
  agentType: string
}): string {
  return join(primaryDirectory(args), `${assertAgentType(args.agentType)}.md`)
}

function toManagedAgent(args: {
  source: MutableAgentSource
  content: string
  config: AgentConfig
}): ManagedAgent {
  const agent: ManagedAgent = {
    source: args.source,
    agentType: args.config.agentType,
    whenToUse: args.config.whenToUse,
    systemPrompt: args.config.systemPrompt,
    tools: args.config.tools,
    revision: revisionFor(args.content),
  }
  if (args.config.disallowedTools !== undefined) {
    agent.disallowedTools = [...args.config.disallowedTools]
  }
  if (args.config.model !== undefined) agent.model = args.config.model
  if (args.config.permissionMode !== undefined) {
    agent.permissionMode = args.config.permissionMode
  }
  if (args.config.forkContext === true) agent.forkContext = true
  if (args.config.maxExecutionTimeMs !== undefined) {
    agent.maxExecutionTimeMs = args.config.maxExecutionTimeMs
  }
  if (args.config.color !== undefined) agent.color = args.config.color
  return agent
}

function readPrimaryAgent(args: {
  source: MutableAgentSource
  cwd: string
  agentType: string
}): ManagedAgentReadResult {
  const agentType = assertAgentType(args.agentType)
  const filePath = getManagedAgentFilePath({ ...args, agentType })
  if (!existsSync(filePath)) {
    if (legacyPaths({ ...args, agentType }).some(existsSync)) {
      return { state: 'legacy_read_only' }
    }
    return { state: 'missing' }
  }

  try {
    const content = readFileSync(filePath, 'utf8')
    const config = parseAgentFromFile({
      filePath,
      baseDir: dirname(filePath),
      source: args.source,
    })
    if (!config || config.agentType !== agentType) return { state: 'invalid' }
    return {
      state: 'found',
      agent: toManagedAgent({ source: args.source, content, config }),
    }
  } catch {
    return { state: 'invalid' }
  }
}

export function readManagedAgent(args: {
  source: MutableAgentSource
  cwd: string
  agentType: string
}): ManagedAgentReadResult {
  return readPrimaryAgent(args)
}

export function listManagedAgents(args: {
  source: MutableAgentSource
  cwd: string
}): ManagedAgent[] {
  const directory = primaryDirectory(args)
  if (!existsSync(directory)) return []

  const agents: ManagedAgent[] = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue
    const agentType = entry.name.slice(0, -'.md'.length)
    let result: ManagedAgentReadResult
    try {
      result = readPrimaryAgent({ ...args, agentType })
    } catch {
      continue
    }
    if (result.state === 'found') agents.push(result.agent)
  }
  return agents.sort((a, b) => a.agentType.localeCompare(b.agentType))
}

function stringifyString(value: string): string {
  return JSON.stringify(value)
}

function formatAgentFile(input: ManagedAgentInput): string {
  const tools = input.tools === '*' ? ['*'] : input.tools
  const lines = [
    '---',
    `name: ${stringifyString(input.agentType)}`,
    `description: ${stringifyString(input.whenToUse)}`,
    `tools: ${JSON.stringify(tools)}`,
  ]
  if (input.disallowedTools !== undefined) {
    lines.push(`disallowedTools: ${JSON.stringify(input.disallowedTools)}`)
  }
  if (input.model !== undefined)
    lines.push(`model: ${stringifyString(input.model)}`)
  if (input.permissionMode !== undefined) {
    lines.push(`permissionMode: ${stringifyString(input.permissionMode)}`)
  }
  if (input.forkContext === true) {
    lines.push(`forkContext: ${stringifyString('true')}`)
  }
  if (input.maxExecutionTimeMs !== undefined) {
    lines.push(`maxExecutionTimeMs: ${input.maxExecutionTimeMs}`)
  }
  if (input.color !== undefined)
    lines.push(`color: ${stringifyString(input.color)}`)
  lines.push('---', '', input.systemPrompt.trim(), '')
  return lines.join('\n')
}

function assertInput(input: ManagedAgentInput): ManagedAgentInput {
  const agentType = assertAgentType(input.agentType)
  if (!input.whenToUse.trim() || !input.systemPrompt.trim()) {
    throw new ManagedAgentStoreError('invalid')
  }
  if (
    input.tools !== '*' &&
    (!Array.isArray(input.tools) ||
      input.tools.some(tool => typeof tool !== 'string' || !tool.trim()))
  ) {
    throw new ManagedAgentStoreError('invalid')
  }
  if (
    input.disallowedTools !== undefined &&
    input.disallowedTools.some(tool => typeof tool !== 'string' || !tool.trim())
  ) {
    throw new ManagedAgentStoreError('invalid')
  }
  if (
    input.maxExecutionTimeMs !== undefined &&
    (!Number.isSafeInteger(input.maxExecutionTimeMs) ||
      input.maxExecutionTimeMs < 1_000 ||
      input.maxExecutionTimeMs > 3_600_000)
  ) {
    throw new ManagedAgentStoreError('invalid')
  }
  return { ...input, agentType }
}

function writeAtomically(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  try {
    chmodSync(dirname(path), 0o700)
  } catch {
    /* no-op */
  }

  const temporaryPath = `${path}.tmp.${process.pid}.${randomUUID()}`
  let descriptor: number | null = null
  try {
    descriptor = openSync(temporaryPath, 'wx', 0o600)
    writeFileSync(descriptor, content, 'utf8')
    fsyncSync(descriptor)
    closeSync(descriptor)
    descriptor = null
    renameSync(temporaryPath, path)
    try {
      chmodSync(path, 0o600)
    } catch {
      /* no-op */
    }
  } catch (error) {
    if (descriptor !== null) {
      try {
        closeSync(descriptor)
      } catch {
        /* no-op */
      }
    }
    try {
      unlinkSync(temporaryPath)
    } catch {
      /* no-op */
    }
    throw error
  }
}

async function withWriteLock<T>(path: string, action: () => T): Promise<T> {
  const previous = writeLocks.get(path) ?? Promise.resolve()
  // Assigned synchronously by the Promise executor below.
  let release!: () => void
  const gate = new Promise<void>(resolve => {
    release = resolve
  })
  const queued = previous.then(() => gate)
  writeLocks.set(path, queued)
  await previous
  try {
    return action()
  } finally {
    release()
    if (writeLocks.get(path) === queued) writeLocks.delete(path)
  }
}

function requireFound(
  value: ManagedAgentReadResult,
): Extract<ManagedAgentReadResult, { state: 'found' }> {
  if (value.state === 'found') return value
  throw new ManagedAgentStoreError(
    value.state === 'legacy_read_only' ? value.state : 'invalid',
  )
}

export async function createManagedAgent(args: {
  source: MutableAgentSource
  cwd: string
  input: ManagedAgentInput
}): Promise<ManagedAgent> {
  const input = assertInput(args.input)
  const path = getManagedAgentFilePath({ ...args, agentType: input.agentType })
  return withWriteLock(path, () => {
    const current = readPrimaryAgent({
      ...args,
      agentType: input.agentType,
    })
    if (current.state === 'found') {
      throw new ManagedAgentStoreError('already_exists')
    }
    if (current.state === 'legacy_read_only') {
      throw new ManagedAgentStoreError('legacy_read_only')
    }
    if (current.state === 'invalid') throw new ManagedAgentStoreError('invalid')
    writeAtomically(path, formatAgentFile(input))
    return requireFound(
      readPrimaryAgent({ ...args, agentType: input.agentType }),
    ).agent
  })
}

export async function updateManagedAgent(args: {
  source: MutableAgentSource
  cwd: string
  input: ManagedAgentInput
  expectedRevision: string
}): Promise<ManagedAgent> {
  const input = assertInput(args.input)
  const path = getManagedAgentFilePath({ ...args, agentType: input.agentType })
  return withWriteLock(path, () => {
    const current = readPrimaryAgent({
      ...args,
      agentType: input.agentType,
    })
    if (current.state === 'missing')
      throw new ManagedAgentStoreError('not_found')
    if (current.state === 'legacy_read_only') {
      throw new ManagedAgentStoreError('legacy_read_only')
    }
    if (current.state === 'invalid') throw new ManagedAgentStoreError('invalid')
    if (current.agent.revision !== args.expectedRevision) {
      throw new ManagedAgentStoreError('revision_conflict')
    }
    writeAtomically(path, formatAgentFile(input))
    return requireFound(
      readPrimaryAgent({ ...args, agentType: input.agentType }),
    ).agent
  })
}

export async function deleteManagedAgent(args: {
  source: MutableAgentSource
  cwd: string
  agentType: string
  expectedRevision: string
}): Promise<void> {
  const agentType = assertAgentType(args.agentType)
  const path = getManagedAgentFilePath({ ...args, agentType })
  await withWriteLock(path, () => {
    const current = readPrimaryAgent({ ...args, agentType })
    if (current.state === 'missing')
      throw new ManagedAgentStoreError('not_found')
    if (current.state === 'legacy_read_only') {
      throw new ManagedAgentStoreError('legacy_read_only')
    }
    if (current.state === 'invalid') throw new ManagedAgentStoreError('invalid')
    if (current.agent.revision !== args.expectedRevision) {
      throw new ManagedAgentStoreError('revision_conflict')
    }
    try {
      unlinkSync(path)
    } catch {
      throw new ManagedAgentStoreError('invalid')
    }
  })
}
