import * as React from 'react'
import type { SetToolJSXFn, ToolUseContext } from '@kode/tool-interface/Tool'
import { createAssistantMessage } from '#core/utils/messages'
import { BunShell } from '#runtime/shell'
import { assessWindowsExecution } from '#runtime/execution'
import { getBunShellSandboxPlan } from '#core/sandbox/bunShellSandboxPlan'
import { getCwd, getOriginalCwd } from '#core/utils/state'
import { getEffectiveSessionId } from '#core/utils/sessionId'
import { isBashCommandReadOnly } from '@kode/permissions/bash'
import {
  createDurableRun,
  finishDurableRun,
  getDurableRunProcessIdentity,
} from '#core/runs'
import { getBackgroundTaskOutputFilePath } from '#core/tasks/backgroundRegistry'
import { decideSystemSandboxForBashTool } from '#core/sandbox/systemSandbox'
import { getBashDestructiveCommandBlock } from '#core/sandbox/destructiveCommandGuard'
import { getPlanConversationKey } from '#core/utils/planMode'
import {
  formatBashLlmGateBlockMessage,
  runBashLlmSafetyGate,
} from '#core/safety/bash-gate/llmSafetyGate'
import {
  getBashGateFindings,
  shouldReviewBashCommand,
} from '#core/safety/bash-gate/dataLossRules'
import { getCommandSource } from './commandSource'
import type { Out } from './BashTool'
import { executeForegroundBash } from './executeForeground'
import { maybeAttachSandboxNetworkPorts } from './sandboxNetwork'
import { LlmGateProgress } from './LlmGateProgress'

type SetToolJSX = SetToolJSXFn<React.ReactNode>

type Input = {
  command: string
  timeout: number
  run_in_background?: boolean
  dangerouslyDisableSandbox?: boolean
  description?: string
}

type AssistantResult = string | unknown[]

export async function* callBashTool(
  input: Input,
  context: ToolUseContext,
  renderResultForAssistant: (output: Out) => AssistantResult,
): AsyncGenerator<
  | { type: 'progress'; content: unknown }
  | { type: 'result'; resultForAssistant: AssistantResult; data: Out }
> {
  const { abortController, readFileTimestamps } = context
  const hasSetToolJSX = (
    value: ToolUseContext,
  ): value is ToolUseContext & { setToolJSX: SetToolJSX } => {
    return typeof (value as { setToolJSX?: unknown }).setToolJSX === 'function'
  }
  const setToolJSX = hasSetToolJSX(context) ? context.setToolJSX : undefined

  const commandSource = getCommandSource(context)
  const safeMode = Boolean(context?.safeMode ?? context?.options?.safeMode)
  const userPrompt =
    typeof context?.options?.lastUserPrompt === 'string'
      ? context.options.lastUserPrompt.trim()
      : ''
  const commandDescription =
    typeof input.description === 'string' ? input.description.trim() : ''
  const sandboxDisabled = input.dangerouslyDisableSandbox === true
  const automationKind = context.options?.automationKind
  const executionPlatform =
    context.options?.__sandboxPlatform ?? process.platform

  if (
    executionPlatform === 'win32' &&
    (input.run_in_background === true || automationKind !== undefined)
  ) {
    const execution = assessWindowsExecution({
      command: input.command,
      cwd: getCwd(),
      mode: automationKind ? 'goal' : 'background',
      writesFilesystem: !isBashCommandReadOnly(input.command),
      // The normal tool-permission flow has already reached this call. This
      // flag does not bypass it; it lets the policy report the remaining
      // strong-isolation requirement accurately.
      approvalGranted: true,
      platform: executionPlatform,
    })
    if (!execution.allowed) {
      const message = [
        'Blocked by the Windows execution policy.',
        `Reason: ${execution.reason}.`,
        `Requirements: ${execution.requirements.join(', ')}.`,
      ].join(' ')
      const data: Out = {
        stdout: '',
        stdoutLines: 0,
        stderr: message,
        stderrLines: 1,
        interrupted: false,
        dangerouslyDisableSandbox: sandboxDisabled,
      }
      yield {
        type: 'result',
        resultForAssistant: renderResultForAssistant(data),
        data,
      }
      return
    }
  }

  const destructiveBlock = getBashDestructiveCommandBlock({
    command: input.command,
    cwd: getCwd(),
    originalCwd: getOriginalCwd(),
    commandSource,
    platform: process.platform,
  })
  if (destructiveBlock) {
    const data: Out = {
      stdout: '',
      stdoutLines: 0,
      stderr: destructiveBlock.message,
      stderrLines: destructiveBlock.message.split(/\r?\n/).length,
      interrupted: false,
      dangerouslyDisableSandbox: sandboxDisabled,
    }
    yield {
      type: 'result',
      resultForAssistant: renderResultForAssistant(data),
      data,
    }
    return
  }

  const systemSandboxDecision = decideSystemSandboxForBashTool({
    safeMode,
    commandSource,
    dangerouslyDisableSandbox: input.dangerouslyDisableSandbox === true,
  })

  const systemSandboxOptions = systemSandboxDecision.enabled
    ? {
        enabled: true,
        require: systemSandboxDecision.required,
        allowNetwork: systemSandboxDecision.allowNetwork,
        writableRoots: [getOriginalCwd()],
        chdir: getCwd(),
      }
    : undefined

  const sandboxPlan = getBunShellSandboxPlan({
    command: input.command,
    dangerouslyDisableSandbox: input.dangerouslyDisableSandbox === true,
    toolUseContext: context,
  })

  if (sandboxPlan.shouldBlockUnsandboxedCommand) {
    const data: Out = {
      stdout: '',
      stdoutLines: 0,
      stderr:
        'This command must run in the sandbox, but sandboxed execution is not available.',
      stderrLines: 1,
      interrupted: false,
      dangerouslyDisableSandbox: sandboxDisabled,
    }
    yield {
      type: 'result',
      resultForAssistant: renderResultForAssistant(data),
      data,
    }
    return
  }

  let sandboxOptions =
    sandboxPlan.settings.enabled === true
      ? sandboxPlan.bunShellSandboxOptions
      : systemSandboxOptions

  const bashLlmGateQuery = context.options?.bashLlmGateQuery

  // Check if command is HIGH severity (triggers LLM Gate)
  const findings = getBashGateFindings(input.command)
  const needsLlmGate = shouldReviewBashCommand(findings)

  // Show progress UI when LLM Gate is reviewing
  if (needsLlmGate && setToolJSX) {
    setToolJSX({
      jsx: <LlmGateProgress command={input.command} findings={findings} />,
      shouldHidePromptInput: false,
    })

    // Yield progress message
    yield {
      type: 'progress',
      content: createAssistantMessage(
        `<tool-progress>Reviewing: ${findings.map(f => f.title).join(', ')}</tool-progress>`,
      ),
    }
  }

  const llmGateResult = await runBashLlmSafetyGate({
    command: input.command,
    userPrompt,
    description: commandDescription,
    platform: process.platform,
    commandSource,
    safeMode,
    runInBackground: input.run_in_background === true,
    willSandbox: Boolean(sandboxOptions?.enabled),
    sandboxRequired: Boolean(sandboxOptions?.enabled && sandboxOptions.require),
    cwd: getCwd(),
    originalCwd: getOriginalCwd(),
    parentAbortSignal: abortController.signal,
    query: bashLlmGateQuery,
  })

  // Clear LLM Gate progress UI
  if (needsLlmGate && setToolJSX) {
    setToolJSX(null)
  }

  if (llmGateResult.decision === 'block') {
    const message = formatBashLlmGateBlockMessage(llmGateResult.verdict)
    const data: Out = {
      stdout: '',
      stdoutLines: 0,
      stderr: message,
      stderrLines: message.split(/\r?\n/).length,
      interrupted: false,
      dangerouslyDisableSandbox: sandboxDisabled,
    }
    yield {
      type: 'result',
      resultForAssistant: renderResultForAssistant(data),
      data,
    }
    return
  }

  if (llmGateResult.decision === 'error' && !llmGateResult.canFailOpen) {
    const userHint =
      llmGateResult.errorType === 'api'
        ? 'Fix your model connection (API key / network) and retry.'
        : llmGateResult.errorType === 'timeout'
          ? 'LLM intent gate timed out. Retry.'
          : 'LLM intent gate returned invalid output. Retry.'
    const userMessage = [
      llmGateResult.willSandbox
        ? 'Blocked: LLM intent gate failed (cannot verify command intent).'
        : 'Blocked: LLM intent gate failed and command would run unsandboxed.',
      `Error: ${llmGateResult.error}`,
      '',
      userHint,
    ]
      .filter(Boolean)
      .join('\n')

    // Keep user-only bypass instructions out of the model-facing tool result to avoid
    // encouraging the assistant to "solve" the problem by bypassing safety.
    const assistantMessage = [
      llmGateResult.willSandbox
        ? 'Blocked: LLM intent gate unavailable.'
        : 'Blocked: LLM intent gate unavailable (command would run unsandboxed).',
      `Error: ${llmGateResult.error}`,
      llmGateResult.errorType === 'invalid_output'
        ? 'Hint: Retry and include a short `description` for the Bash command.'
        : llmGateResult.errorType === 'timeout'
          ? 'Hint: Retry (or switch to a faster main model).'
          : '',
    ]
      .filter(Boolean)
      .join('\n')
    const data: Out = {
      stdout: '',
      stdoutLines: 0,
      stderr: userMessage,
      stderrLines: userMessage.split(/\r?\n/).length,
      interrupted: false,
      dangerouslyDisableSandbox: sandboxDisabled,
    }
    yield {
      type: 'result',
      resultForAssistant: assistantMessage,
      data,
    }
    return
  }

  sandboxOptions = await maybeAttachSandboxNetworkPorts({
    sandboxPlan,
    sandboxOptions,
    context,
  })

  // 🔧 Check if already cancelled before starting execution
  if (abortController.signal.aborted) {
    const data: Out = {
      stdout: '',
      stdoutLines: 0,
      stderr: 'Command cancelled before execution',
      stderrLines: 1,
      interrupted: true,
      dangerouslyDisableSandbox: sandboxDisabled,
    }

    yield {
      type: 'result',
      resultForAssistant: renderResultForAssistant(data),
      data,
    }
    return
  }

  try {
    if (input.run_in_background) {
      const { bashId, completion, pid } =
        BunShell.getInstance().execInBackground(input.command, input.timeout, {
          cwd: getCwd(),
          sandbox: sandboxOptions,
          backgroundTask: {
            sessionId: getEffectiveSessionId(),
          },
        })
      const durableProcess = getDurableRunProcessIdentity(pid)
      let durableRunCreated = false
      if (process.env.NODE_ENV !== 'test') {
        try {
          createDurableRun({
            id: bashId,
            kind: 'shell',
            cwd: getCwd(),
            command: input.command,
            sessionId: getEffectiveSessionId(),
            outputFile: getBackgroundTaskOutputFilePath(bashId),
            ...(durableProcess ? { process: durableProcess } : {}),
          })
          durableRunCreated = true
        } catch {
          // Background execution stays available if the journal is read-only.
        }
      }
      if (durableRunCreated) {
        void completion.then(result => {
          try {
            finishDurableRun({
              id: bashId,
              status:
                result.status === 'completed'
                  ? 'completed'
                  : result.status === 'killed'
                    ? 'cancelled'
                    : 'failed',
              ...(result.error ? { error: result.error } : {}),
            })
          } catch {
            // Do not turn a successful task completion into a tool failure.
          }
        })
      }
      const data: Out = {
        stdout: '',
        stdoutLines: 0,
        stderr: '',
        stderrLines: 0,
        interrupted: false,
        bashId,
        backgroundTaskId: bashId,
        dangerouslyDisableSandbox: sandboxDisabled,
      }
      yield {
        type: 'result',
        resultForAssistant: renderResultForAssistant(data),
        data,
      }
      return
    }

    yield* executeForegroundBash({
      command: input.command,
      timeout: input.timeout,
      abortController,
      readFileTimestamps,
      sandboxOptions,
      dangerouslyDisableSandbox: sandboxDisabled,
      setToolJSX,
      renderResultForAssistant,
      conversationKey: getPlanConversationKey(context),
      skipSummary: commandSource === 'user_bash_mode',
    })
  } catch (error) {
    const isAborted = abortController.signal.aborted
    const errorMessage = isAborted
      ? 'Command was cancelled by user'
      : `Command failed: ${error instanceof Error ? error.message : String(error)}`

    const data: Out = {
      stdout: '',
      stdoutLines: 0,
      stderr: errorMessage,
      stderrLines: 1,
      interrupted: isAborted,
      dangerouslyDisableSandbox: sandboxDisabled,
    }

    yield {
      type: 'result',
      resultForAssistant: renderResultForAssistant(data),
      data,
    }
  } finally {
    setToolJSX?.(null)
  }
}
