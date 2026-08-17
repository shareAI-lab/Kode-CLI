import { isBashCommandReadOnly } from '@kode/permissions/bash'
import { getBackgroundTaskSnapshot } from '#core/tasks/backgroundRegistry'
import type {
  Tool,
  WorkspaceMutationReceipt,
  WorkspaceMutationScope,
} from '@kode/tool-interface/Tool'
import { classifyVerificationCommand } from './receipt'

/**
 * These tools may mutate conversation/application state, but not project
 * files. Keeping this distinction prevents task lists, plan transitions, and
 * delegated research from forcing an unrelated code verification command.
 */
const NON_WORKSPACE_MUTATING_TOOL_NAMES = new Set([
  'Architect',
  'AskExpertModel',
  'AskUserQuestion',
  'EnterPlanMode',
  'ExitPlanMode',
  'Glob',
  'Grep',
  'LS',
  'LSP',
  'ListMcpResourcesTool',
  'MCPSearch',
  'Read',
  'ReadMcpResourceTool',
  'SessionMessage',
  'Skill',
  'SlashCommand',
  'Task',
  'TaskCreate',
  'TaskGet',
  'TaskGuide',
  'TaskList',
  'TaskMonitor',
  'TaskOutput',
  'TaskStop',
  'TaskUpdate',
  'Think',
  'TodoWrite',
  'WebFetch',
  'WebSearch',
  'web_search',
])

type WorkspaceAwareTool = Pick<Tool, 'name'> &
  Partial<Pick<Tool, 'isReadOnly' | 'workspaceMutationScope'>>

type TaskOutputLike = {
  retrieval_status?: unknown
  task?: {
    task_type?: unknown
    status?: unknown
    command?: unknown
  } | null
}

function isWorkspaceMutationScope(
  value: unknown,
): value is WorkspaceMutationScope {
  return value === 'none' || value === 'direct' || value === 'delegated'
}

function findTool(
  tools: readonly WorkspaceAwareTool[] | undefined,
  name: string,
): WorkspaceAwareTool | undefined {
  return tools?.find(tool => tool.name === name)
}

/**
 * Resolves a tool's workspace effect without conflating all application state
 * with project-file writes. Unknown or broken tool metadata remains fail-closed.
 */
export function resolveWorkspaceMutationScope(args: {
  name: string
  input: Record<string, unknown>
  output?: unknown
  tools?: readonly WorkspaceAwareTool[]
}): WorkspaceMutationScope {
  const tool = findTool(args.tools, args.name)

  if (args.name === 'Bash') {
    const output =
      args.output && typeof args.output === 'object'
        ? (args.output as Record<string, unknown>)
        : null
    // Starting or interactively promoting a command hands completion
    // ownership to TaskOutput. The launch itself is not a completed write.
    if (
      args.input.run_in_background === true ||
      typeof output?.backgroundTaskId === 'string' ||
      typeof output?.bashId === 'string'
    ) {
      return 'delegated'
    }

    const command = args.input.command
    if (typeof command !== 'string') return 'direct'
    // A recognized verification command is evidence rather than a later
    // source mutation. Commands with fix/write/update flags are rejected by
    // the verification classifier and remain direct mutations.
    if (classifyVerificationCommand(command) !== null) return 'none'
    return isBashCommandReadOnly(command) ? 'none' : 'direct'
  }

  if (args.name === 'TaskOutput') {
    const result =
      args.output && typeof args.output === 'object'
        ? (args.output as TaskOutputLike)
        : null
    const resultTask = result?.task
    let taskType = resultTask?.task_type
    let status = resultTask?.status
    let command = resultTask?.command

    if (taskType === undefined) {
      const taskId = args.input.task_id
      const snapshot =
        typeof taskId === 'string' ? getBackgroundTaskSnapshot(taskId) : null
      taskType = snapshot?.taskType
      status = snapshot?.status
      command =
        snapshot?.taskType === 'local_bash' ? snapshot.command : undefined
    }

    if (taskType !== 'local_bash') {
      return status === 'failed' || status === 'killed' ? 'direct' : 'delegated'
    }
    if (status === 'running' || status === 'pending') return 'delegated'
    if (typeof command !== 'string') return 'direct'
    if (classifyVerificationCommand(command) !== null) return 'none'
    return isBashCommandReadOnly(command) ? 'none' : 'direct'
  }

  if (typeof tool?.workspaceMutationScope === 'function') {
    try {
      const scope = tool.workspaceMutationScope(
        args.input as never,
        args.output as never,
      )
      return isWorkspaceMutationScope(scope) ? scope : 'direct'
    } catch {
      return 'direct'
    }
  }

  if (NON_WORKSPACE_MUTATING_TOOL_NAMES.has(args.name)) return 'none'

  if (typeof tool?.isReadOnly === 'function') {
    try {
      return tool.isReadOnly(args.input as never) ? 'none' : 'direct'
    } catch {
      return 'direct'
    }
  }

  return 'direct'
}

export function createWorkspaceMutationReceipt(args: {
  toolUseId: string
  scope: WorkspaceMutationScope
  basis?: WorkspaceMutationReceipt['basis']
}): WorkspaceMutationReceipt {
  return {
    version: 1,
    toolUseId: args.toolUseId,
    scope: args.scope,
    basis:
      args.basis ?? (args.scope === 'delegated' ? 'delegated' : 'declared'),
  }
}

/**
 * Deferred-result tools report work that may have completed before the
 * retrieval call started. Comparing only the retrieval window would erase
 * those earlier writes, so they must keep their declared result scope.
 */
export function canObserveWorkspaceMutationDuringCall(args: {
  name: string
  declaredScope: WorkspaceMutationScope
}): boolean {
  return args.declaredScope === 'direct' && args.name !== 'TaskOutput'
}

export function finalizeWorkspaceMutationReceipt(args: {
  toolUseId: string
  declaredScope: WorkspaceMutationScope
  beforeFingerprint: string | null
  afterFingerprint: string | null
}): WorkspaceMutationReceipt {
  if (
    args.declaredScope === 'direct' &&
    args.beforeFingerprint !== null &&
    args.afterFingerprint !== null
  ) {
    return createWorkspaceMutationReceipt({
      toolUseId: args.toolUseId,
      scope:
        args.beforeFingerprint === args.afterFingerprint ? 'none' : 'direct',
      basis: 'observed',
    })
  }
  return createWorkspaceMutationReceipt({
    toolUseId: args.toolUseId,
    scope: args.declaredScope,
  })
}

export function readWorkspaceMutationReceipt(
  value: unknown,
): WorkspaceMutationReceipt | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  if (
    record.version !== 1 ||
    typeof record.toolUseId !== 'string' ||
    !record.toolUseId ||
    !isWorkspaceMutationScope(record.scope) ||
    (record.basis !== 'declared' &&
      record.basis !== 'observed' &&
      record.basis !== 'delegated')
  ) {
    return null
  }
  return {
    version: 1,
    toolUseId: record.toolUseId,
    scope: record.scope,
    basis: record.basis,
  }
}
