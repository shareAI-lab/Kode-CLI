import type { Tool, ToolUseContext } from '@kode/tool-interface/Tool'
import { assessWindowsExecution } from '#runtime/execution'
import { getCwd } from '#core/utils/state'
import { logError } from '#core/utils/log'
import type { ToolResultBlockParam } from '@anthropic-ai/sdk/resources/index.mjs'
import {
  createAssistantMessage,
  createProgressMessage,
  createUserMessage,
} from '../messages/create'
import { maybePersistOversizedToolResult } from '#core/utils/toolResultPersistence'
import {
  attachVerificationReceipt,
  createVerificationReceipt,
  formatVerificationSystemMessage,
} from '../verification/receipt'
import {
  canObserveWorkspaceMutationDuringCall,
  finalizeWorkspaceMutationReceipt,
  resolveWorkspaceMutationScope,
} from '../verification/mutation'
import { captureWorkspaceFingerprint } from '../verification/workspaceFingerprint'
import {
  getHookTranscriptPath,
  queueHookAdditionalContexts,
  queueHookSystemMessages,
  runPostToolUseHooks,
  runPreToolUseHooks,
} from '@kode/hooks'
import { runBuiltinPreToolUseGuards } from '@kode/hooks/builtin/preToolUse'

import type { AssistantMessage, EngineCanUseToolFn, Message } from './types'
import { normalizeToolInput, preprocessToolInput } from './tool-input'

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object') return null
  return value as Record<string, unknown>
}

function getReadModeValidationError(
  tool: Tool,
  input: Record<string, unknown>,
  enforceReadMode: boolean,
): string | null {
  if (!enforceReadMode) return null
  if (!tool.readModeAccess) {
    return 'This tool is not available in the Kode read-only tool profile.'
  }

  const parsed = (tool.readModeInputSchema ?? tool.inputSchema).safeParse(input)
  const readModeInput = parsed.success ? asRecord(parsed.data) : null
  if (!readModeInput) {
    return 'This tool call does not satisfy the Kode read-only input contract.'
  }

  try {
    return tool.isReadOnly(readModeInput as never)
      ? null
      : 'This tool call is not read-only and was blocked by the Kode read-only tool profile.'
  } catch {
    return 'Kode could not verify that this tool call is read-only.'
  }
}

function isPipelineMessage(value: unknown): value is Message {
  const record = asRecord(value)
  if (!record) return false
  return (
    record.type === 'user' ||
    record.type === 'assistant' ||
    record.type === 'progress'
  )
}

function toToolResultContent(
  value: unknown,
): NonNullable<ToolResultBlockParam['content']> {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    return value as NonNullable<ToolResultBlockParam['content']>
  }
  return String(value)
}

function getWindowsAutomationPolicyBlock(
  tool: Tool,
  input: Record<string, unknown>,
  context: ToolUseContext,
): string | null {
  const automationKind = context.options?.automationKind
  const platform = context.options?.__sandboxPlatform ?? process.platform
  if (
    !automationKind ||
    platform !== 'win32' ||
    tool.isReadOnly(input as never)
  ) {
    return null
  }

  // A goal/loop is unattended execution. Treat every non-read-only tool as a
  // write-capable side effect so allowlisted filesystem permissions cannot
  // accidentally turn a local Windows process into a claimed sandbox.
  const decision = assessWindowsExecution({
    command: `tool:${tool.name}`,
    cwd: getCwd(),
    mode: 'goal',
    writesFilesystem: true,
    approvalGranted: true,
    platform,
  })
  if (decision.allowed) return null
  return [
    'Blocked by the Windows execution policy.',
    `Reason: ${decision.reason}.`,
    `Requirements: ${decision.requirements.join(', ')}.`,
  ].join(' ')
}

export async function* checkPermissionsAndCallTool(
  tool: Tool,
  toolUseID: string,
  siblingToolUseIDs: Set<string>,
  input: Record<string, unknown>,
  context: ToolUseContext,
  canUseTool: EngineCanUseToolFn,
  assistantMessage: AssistantMessage,
  shouldSkipPermissionCheck?: boolean,
  enforceReadMode = false,
): AsyncGenerator<Message, void> {
  const preprocessedInput = preprocessToolInput(tool, input)
  const isValidInput = tool.inputSchema.safeParse(preprocessedInput)
  if (!isValidInput.success) {
    let errorMessage = `InputValidationError: ${isValidInput.error.message}`

    if (tool.name === 'Read' && Object.keys(preprocessedInput).length === 0) {
      errorMessage =
        'Error: The Read tool requires a \'file_path\' parameter to specify which file to read. Please provide the absolute path to the file you want to read. For example: {"file_path": "/path/to/file.txt"}'
    }

    yield createUserMessage([
      {
        type: 'tool_result',
        content: errorMessage,
        is_error: true,
        tool_use_id: toolUseID,
      },
    ])
    return
  }

  let normalizedInput = normalizeToolInput(tool, isValidInput.data)

  const initialReadModeValidationError = getReadModeValidationError(
    tool,
    normalizedInput,
    enforceReadMode,
  )
  if (initialReadModeValidationError) {
    yield createUserMessage([
      {
        type: 'tool_result',
        content: initialReadModeValidationError,
        is_error: true,
        tool_use_id: toolUseID,
      },
    ])
    return
  }

  const windowsAutomationBlock = getWindowsAutomationPolicyBlock(
    tool,
    normalizedInput,
    context,
  )
  if (windowsAutomationBlock) {
    yield createUserMessage([
      {
        type: 'tool_result',
        content: windowsAutomationBlock,
        is_error: true,
        tool_use_id: toolUseID,
      },
    ])
    return
  }

  const builtinOutcome = runBuiltinPreToolUseGuards({
    toolName: tool.name,
    toolInput: normalizedInput,
    cwd: getCwd(),
  })
  if (builtinOutcome?.kind === 'block') {
    yield createUserMessage([
      {
        type: 'tool_result',
        content: builtinOutcome.message,
        is_error: true,
        tool_use_id: toolUseID,
      },
    ])
    return
  }

  const isValidCall = await tool.validateInput?.(
    normalizedInput as never,
    context,
  )
  if (isValidCall?.result === false) {
    yield createUserMessage([
      {
        type: 'tool_result',
        content: isValidCall.message,
        is_error: true,
        tool_use_id: toolUseID,
      },
    ])
    return
  }

  const hookOutcome = await runPreToolUseHooks({
    toolName: tool.name,
    toolInput: normalizedInput,
    toolUseId: toolUseID,
    permissionMode: context.options?.toolPermissionContext?.mode,
    cwd: getCwd(),
    transcriptPath: getHookTranscriptPath(context),
    safeMode: context.options?.safeMode ?? false,
    signal: context.abortController.signal,
  })
  if (hookOutcome.kind === 'block') {
    yield createUserMessage([
      {
        type: 'tool_result',
        content: hookOutcome.message,
        is_error: true,
        tool_use_id: toolUseID,
      },
    ])
    return
  }
  if (hookOutcome.warnings.length > 0) {
    const warningText = hookOutcome.warnings.join('\n')
    yield createProgressMessage(
      toolUseID,
      siblingToolUseIDs,
      createAssistantMessage(warningText),
      [],
      context.options?.tools ?? [],
    )
  }

  if (hookOutcome.systemMessages && hookOutcome.systemMessages.length > 0) {
    queueHookSystemMessages(context, hookOutcome.systemMessages)
  }
  if (
    hookOutcome.additionalContexts &&
    hookOutcome.additionalContexts.length > 0
  ) {
    queueHookAdditionalContexts(context, hookOutcome.additionalContexts)
  }

  if (hookOutcome.updatedInput) {
    const merged = { ...normalizedInput, ...hookOutcome.updatedInput }
    const parsed = tool.inputSchema.safeParse(merged)
    if (!parsed.success) {
      yield createUserMessage([
        {
          type: 'tool_result',
          content: `Hook updatedInput failed validation: ${parsed.error.message}`,
          is_error: true,
          tool_use_id: toolUseID,
        },
      ])
      return
    }
    normalizedInput = normalizeToolInput(tool, parsed.data)
    const hookReadModeValidationError = getReadModeValidationError(
      tool,
      normalizedInput,
      enforceReadMode,
    )
    if (hookReadModeValidationError) {
      yield createUserMessage([
        {
          type: 'tool_result',
          content: hookReadModeValidationError,
          is_error: true,
          tool_use_id: toolUseID,
        },
      ])
      return
    }
    const isValidUpdate = await tool.validateInput?.(
      normalizedInput as never,
      context,
    )
    if (isValidUpdate?.result === false) {
      yield createUserMessage([
        {
          type: 'tool_result',
          content: isValidUpdate.message,
          is_error: true,
          tool_use_id: toolUseID,
        },
      ])
      return
    }
  }

  const hookPermissionDecision =
    hookOutcome.kind === 'allow' ? hookOutcome.permissionDecision : undefined

  const effectiveShouldSkipPermissionCheck =
    hookPermissionDecision === 'allow'
      ? true
      : hookPermissionDecision === 'ask'
        ? false
        : shouldSkipPermissionCheck

  const permissionContextForCall =
    hookPermissionDecision === 'ask' &&
    context.options?.toolPermissionContext &&
    context.options.toolPermissionContext.mode !== 'cautious'
      ? ({
          ...context,
          options: {
            ...context.options,
            toolPermissionContext: {
              ...context.options.toolPermissionContext,
              mode: 'cautious',
            },
          },
        } as const)
      : context

  const permissionResult = effectiveShouldSkipPermissionCheck
    ? ({ result: true } as const)
    : await canUseTool(
        tool,
        normalizedInput,
        { ...permissionContextForCall, toolUseId: toolUseID },
        assistantMessage,
      )

  if (permissionResult.result === false) {
    yield createUserMessage([
      {
        type: 'tool_result',
        content: permissionResult.message,
        is_error: true,
        tool_use_id: toolUseID,
      },
    ])
    return
  }

  const updatedInput =
    'updatedInput' in permissionResult
      ? permissionResult.updatedInput
      : undefined

  if (updatedInput) {
    const parsed = tool.inputSchema.safeParse(updatedInput)
    if (!parsed.success) {
      yield createUserMessage([
        {
          type: 'tool_result',
          content: `Permission updatedInput failed validation: ${parsed.error.message}`,
          is_error: true,
          tool_use_id: toolUseID,
        },
      ])
      return
    }
    normalizedInput = normalizeToolInput(tool, parsed.data)
    const permissionReadModeValidationError = getReadModeValidationError(
      tool,
      normalizedInput,
      enforceReadMode,
    )
    if (permissionReadModeValidationError) {
      yield createUserMessage([
        {
          type: 'tool_result',
          content: permissionReadModeValidationError,
          is_error: true,
          tool_use_id: toolUseID,
        },
      ])
      return
    }
    const isValidUpdate = await tool.validateInput?.(
      normalizedInput as never,
      context,
    )
    if (isValidUpdate?.result === false) {
      yield createUserMessage([
        {
          type: 'tool_result',
          content: isValidUpdate.message,
          is_error: true,
          tool_use_id: toolUseID,
        },
      ])
      return
    }
  }

  const workspaceAwareTools = [
    tool,
    ...(context.options?.tools ?? []).filter(candidate => candidate !== tool),
  ]
  const declaredMutationScope = resolveWorkspaceMutationScope({
    name: tool.name,
    input: normalizedInput,
    tools: workspaceAwareTools,
  })
  const observesMutationDuringCall = canObserveWorkspaceMutationDuringCall({
    name: tool.name,
    declaredScope: declaredMutationScope,
  })
  const workspaceFingerprintBefore = observesMutationDuringCall
    ? captureWorkspaceFingerprint(getCwd())
    : null
  const mutationReceipt = (output?: unknown) => {
    const completedMutationScope = resolveWorkspaceMutationScope({
      name: tool.name,
      input: normalizedInput,
      output,
      tools: workspaceAwareTools,
    })
    return finalizeWorkspaceMutationReceipt({
      toolUseId: toolUseID,
      declaredScope: completedMutationScope,
      beforeFingerprint: workspaceFingerprintBefore,
      afterFingerprint:
        completedMutationScope === 'direct' && observesMutationDuringCall
          ? captureWorkspaceFingerprint(getCwd())
          : null,
    })
  }

  try {
    const generator = tool.call(normalizedInput as never, {
      ...context,
      toolUseId: toolUseID,
    })

    for await (const result of generator) {
      switch (result.type) {
        case 'result': {
          const workspaceMutation = mutationReceipt(result.data)
          const verificationReceipt = createVerificationReceipt({
            toolName: tool.name,
            isTrustedExecutionTool: tool.isTrustedExecutionTool === true,
            toolUseId: toolUseID,
            input: normalizedInput,
            output: result.data,
          })
          const data = attachVerificationReceipt(
            result.data,
            verificationReceipt,
          )
          if (verificationReceipt) {
            queueHookSystemMessages(context, [
              formatVerificationSystemMessage(verificationReceipt),
            ])
          }
          const rawContent =
            result.resultForAssistant ??
            tool.renderResultForAssistant(result.data as never)
          const content = maybePersistOversizedToolResult({
            cwd: getCwd(),
            toolUseId: toolUseID,
            content: toToolResultContent(rawContent),
            maxResultSizeChars: tool.maxResultSizeChars,
          })
          const newMessages = Array.isArray(result.newMessages)
            ? result.newMessages.filter(isPipelineMessage)
            : []

          const postOutcome = await runPostToolUseHooks({
            toolName: tool.name,
            toolInput: normalizedInput,
            toolResult: data,
            toolUseId: toolUseID,
            permissionMode: context.options?.toolPermissionContext?.mode,
            cwd: getCwd(),
            transcriptPath: getHookTranscriptPath(context),
            safeMode: context.options?.safeMode ?? false,
            signal: context.abortController.signal,
          })

          if (postOutcome.systemMessages.length > 0) {
            queueHookSystemMessages(context, postOutcome.systemMessages)
          }
          if (postOutcome.additionalContexts.length > 0) {
            queueHookAdditionalContexts(context, postOutcome.additionalContexts)
          }
          if (postOutcome.warnings.length > 0) {
            const warningText = postOutcome.warnings.join('\n')
            yield createProgressMessage(
              toolUseID,
              siblingToolUseIDs,
              createAssistantMessage(warningText),
              [],
              context.options?.tools ?? [],
            )
          }

          yield createUserMessage(
            [
              {
                type: 'tool_result',
                content,
                tool_use_id: toolUseID,
              },
            ],
            {
              data,
              resultForAssistant: content,
              metadata: { workspaceMutation },
              ...(newMessages.length > 0 ? { newMessages } : {}),
              ...(result.contextModifier
                ? { contextModifier: result.contextModifier }
                : {}),
            },
          )

          for (const message of newMessages) {
            yield message
          }

          return
        }
        case 'progress':
          yield createProgressMessage(
            toolUseID,
            siblingToolUseIDs,
            result.content,
            result.normalizedMessages || [],
            result.tools || [],
          )
          break
      }
    }
  } catch (error) {
    const content = formatError(error)
    logError(error)

    const workspaceMutation = mutationReceipt()
    yield createUserMessage(
      [
        {
          type: 'tool_result',
          content,
          is_error: true,
          tool_use_id: toolUseID,
        },
      ],
      {
        data: {},
        resultForAssistant: content,
        metadata: { workspaceMutation },
      },
    )
  }
}

function formatError(error: unknown): string {
  if (!(error instanceof Error)) return String(error)

  const parts = [error.message]
  if ('stderr' in error && typeof error.stderr === 'string') {
    parts.push(error.stderr)
  }
  if ('stdout' in error && typeof error.stdout === 'string') {
    parts.push(error.stdout)
  }

  const fullMessage = parts.filter(Boolean).join('\n')
  if (fullMessage.length <= 10000) return fullMessage

  const halfLength = 5000
  const start = fullMessage.slice(0, halfLength)
  const end = fullMessage.slice(-halfLength)
  return `${start}\n\n... [${fullMessage.length - 10000} characters truncated] ...\n\n${end}`
}
