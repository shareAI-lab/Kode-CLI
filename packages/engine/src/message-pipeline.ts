import { queryLLM } from '#core/ai/llmLazy'
import { getTotalCost } from '#core/cost-tracker'
import { finishDurableRun } from '#core/runs'
import { MaxBudgetUsdExceededError } from '#core/errors/maxBudgetUsd'
import { MaxTurnsExceededError } from '#protocol/maxTurns'
import { formatSystemPromptWithContext } from '#core/services/systemPrompt'
import { emitReminderEvent } from '#core/services/systemReminder'
import { addNotification } from '#core/services/notificationCenter'
import '#core/services/workspaceSafety'
import { markPhase } from '#core/utils/debugLogger'
import {
  createAssistantAPIErrorMessage,
  createAssistantMessage,
  createUserMessage,
} from './messages/create'
import {
  INTERRUPT_MESSAGE,
  INTERRUPT_MESSAGE_FOR_TOOL_USE,
} from './messages/constants'
import { normalizeMessagesForAPI } from './messages/api'
import {
  getPlanModeSystemPromptAdditions,
  hydratePlanSlugFromMessages,
} from '#core/utils/planMode'
import { setRequestStatus } from '#core/utils/requestStatus'
import {
  BunShell,
  renderBackgroundShellStatusAttachment,
  renderBashNotification,
} from '#runtime/shell'
import { getCwd } from '#core/utils/state'
import { getEffectiveSessionId } from '#core/utils/sessionId'
import {
  flushBackgroundAgentNotifications,
  renderBackgroundAgentNotification,
} from '#core/tasks'
import {
  extractLongTermMemories,
  formatMemoryContext,
  getRelevantMemories,
} from '#core/memory'
import { evaluateActiveGoalAfterTurn, GoalService } from '#core/goals'
import { checkAutoCompact } from '#core/utils/autoCompactCore'
import { checkMicroCompact } from '#core/utils/microCompactCore'
import { asRecord } from '@kode/hooks/types'
import {
  drainHookSystemPromptAdditions,
  getHookTranscriptPath,
  queueHookAdditionalContexts,
  queueHookSystemMessages,
  runStopHooks,
  runUserPromptSubmitHooks,
  updateHookTranscriptForMessages,
} from '@kode/hooks'
import { queryWithBinaryFeedback } from './query-executor'
import { ToolUseQueue } from './pipeline/tool-use-queue'
import type {
  AssistantMessage,
  BinaryFeedbackResult,
  EngineCanUseToolFn,
  ExtendedToolUseContext,
  Message,
  UserMessage,
} from './pipeline/types'
import { isToolUseLikeBlock } from './pipeline/types'
export type {
  AssistantMessage,
  BinaryFeedbackResult,
  EngineCanUseToolFn,
  ExtendedToolUseContext,
  Message,
  ProgressMessage,
  Response,
  UserMessage,
} from './pipeline/types'
export { __isToolUseLikeBlockForTests } from './pipeline/types'
export { __ToolUseQueueForTests } from './pipeline/tool-use-queue'
export { runToolUse } from './pipeline/tool-use'
export { normalizeToolInput } from './pipeline/tool-input'

type PipelineRetryState = {
  stopHookActive?: boolean
  stopHookAttempts?: number
  thinkingOnlyAttempts?: number
}

const MAX_THINKING_ONLY_RETRIES = 3

function createThinkingOnlyRetryPrompt(retryNumber: number): string {
  return [
    'The previous model response contained internal reasoning only, with no final assistant text and no tool call.',
    `Recovery attempt ${retryNumber} of ${MAX_THINKING_ONLY_RETRIES}.`,
    'Continue the same user request now with either the tool call needed to make progress or a user-facing assistant response.',
    'Do not emit another reasoning-only response, and do not repeat or expose internal reasoning.',
    'If you cannot continue, state the blocker or ask the user one concise question.',
  ].join(' ')
}

function createThinkingOnlyRecoveryMessage(retryNumber: number): UserMessage {
  return createUserMessage(
    [
      '<thinking-only-recovery>',
      `Recovery attempt ${retryNumber} of ${MAX_THINKING_ONLY_RETRIES}.`,
      'Continue the original task now. Do not describe a plan, repeat reasoning, or send a progress update.',
      'For a task that requires repository work, use an available tool immediately before giving a final response.',
      'If no tool is needed, return the final user-facing response now.',
      '</thinking-only-recovery>',
    ].join('\n'),
  )
}

function isThinkingOnlyRecoveryMessage(message: Message): boolean {
  return (
    message.type === 'user' &&
    typeof message.message.content === 'string' &&
    message.message.content.startsWith('<thinking-only-recovery>')
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function blockHasText(block: Record<string, unknown>): boolean {
  return (
    (typeof block.text === 'string' && block.text.trim().length > 0) ||
    (typeof block.content === 'string' && block.content.trim().length > 0)
  )
}

function isThinkingBlock(block: Record<string, unknown>): boolean {
  if (block.type !== 'thinking' && block.type !== 'reasoning') return false
  return (
    blockHasText(block) ||
    (typeof block.thinking === 'string' && block.thinking.trim().length > 0) ||
    (typeof block.summary === 'string' && block.summary.trim().length > 0)
  )
}

function isThinkingOnlyAssistantMessage(message: AssistantMessage): boolean {
  const content = message.message.content
  if (!Array.isArray(content) || content.length === 0) return false

  let hasThinking = false
  for (const block of content) {
    if (!isRecord(block)) return false
    if (isToolUseLikeBlock(block)) return false
    if (block.type === 'text' && blockHasText(block)) return false
    if (isThinkingBlock(block)) {
      hasThinking = true
      continue
    }
    if (block.type === 'text') continue
    return false
  }

  return hasThinking
}

function getAssistantTextForGoalEvaluation(message: AssistantMessage): string {
  const content = message.message.content
  if (!Array.isArray(content)) return ''
  return content
    .flatMap(block => {
      if (!isRecord(block) || block.type !== 'text') return []
      return typeof block.text === 'string' ? [block.text] : []
    })
    .join('\n')
    .trim()
}

function buildGoalContinuationPrompt(args: {
  objective: string
  acceptanceCriteria: string[]
  continuationPrompt: string
}): string {
  const criteria = args.acceptanceCriteria
    .map((criterion, index) => `${index + 1}. ${criterion}`)
    .join('\n')
  return [
    '<goal_run>',
    `Active objective: ${args.objective}`,
    criteria ? `Acceptance criteria:\n${criteria}` : '',
    'The independent goal evaluator has not accepted the prior response.',
    `Continue now: ${args.continuationPrompt}`,
    'Do not claim completion unless you can provide concrete evidence for every acceptance criterion.',
    '</goal_run>',
  ]
    .filter(Boolean)
    .join('\n')
}

export async function* messagePipeline(
  messages: Message[],
  systemPrompt: string[],
  context: { [k: string]: string },
  canUseTool: EngineCanUseToolFn,
  toolUseContext: ExtendedToolUseContext,
  getBinaryFeedbackResponse?: (
    m1: AssistantMessage,
    m2: AssistantMessage,
  ) => Promise<BinaryFeedbackResult>,
): AsyncGenerator<Message, void> {
  yield* messagePipelineCore(
    messages,
    systemPrompt,
    context,
    canUseTool,
    toolUseContext,
    getBinaryFeedbackResponse,
  )
}
async function* messagePipelineCore(
  messages: Message[],
  systemPrompt: string[],
  context: { [k: string]: string },
  canUseTool: EngineCanUseToolFn,
  toolUseContext: ExtendedToolUseContext,
  getBinaryFeedbackResponse?: (
    m1: AssistantMessage,
    m2: AssistantMessage,
  ) => Promise<BinaryFeedbackResult>,
  hookState?: PipelineRetryState,
): AsyncGenerator<Message, void> {
  setRequestStatus({ kind: 'thinking' })

  try {
    markPhase('QUERY_INIT')
    const stopHookActive = hookState?.stopHookActive === true
    const stopHookAttempts = hookState?.stopHookAttempts ?? 0
    const thinkingOnlyAttempts = hookState?.thinkingOnlyAttempts ?? 0

    const maxTurns = toolUseContext.options.maxTurns
    const normalizedMaxTurns =
      typeof maxTurns === 'number' && Number.isFinite(maxTurns) && maxTurns > 0
        ? Math.trunc(maxTurns)
        : undefined

    const turnsUsed = (() => {
      const raw = toolUseContext.turnCount
      if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0) {
        return 0
      }
      return Math.trunc(raw)
    })()
    toolUseContext.turnCount = turnsUsed

    if (normalizedMaxTurns !== undefined && turnsUsed >= normalizedMaxTurns) {
      throw new MaxTurnsExceededError({
        maxTurns: normalizedMaxTurns,
        turnCount: turnsUsed,
      })
    }

    const maxBudgetUsd = toolUseContext.options.maxBudgetUsd
    if (
      typeof maxBudgetUsd === 'number' &&
      Number.isFinite(maxBudgetUsd) &&
      maxBudgetUsd > 0
    ) {
      const totalCostUsd = getTotalCost()
      if (totalCostUsd >= maxBudgetUsd) {
        throw new MaxBudgetUsdExceededError({ maxBudgetUsd, totalCostUsd })
      }
    }

    // The execution layer needs to distinguish a user-driven foreground turn
    // from an unattended goal/loop turn, particularly on Windows where local
    // processes are not claimed to be strongly isolated.
    if (toolUseContext.agentId === 'main') {
      try {
        const activeGoal = new GoalService().findActiveGoal({
          cwd: getCwd(),
          sessionId: getEffectiveSessionId(),
        })
        toolUseContext.options.automationKind = activeGoal
          ? activeGoal.schedule.kind === 'interval'
            ? 'scheduled_loop'
            : 'goal'
          : undefined
      } catch {
        toolUseContext.options.automationKind = undefined
      }
    }

    // Micro-compact check (tool-result offload before auto-compact)
    {
      const microOutcome = await checkMicroCompact(messages, toolUseContext)
      if (microOutcome.boundaryMessage) {
        messages = microOutcome.messages
        yield microOutcome.boundaryMessage
        messages = [...messages, microOutcome.boundaryMessage]
      } else {
        messages = microOutcome.messages
      }
    }

    // Auto-compact check
    const { messages: processedMessages, wasCompacted } =
      await checkAutoCompact(messages, toolUseContext)
    if (wasCompacted) {
      messages = processedMessages
    }

    // Compatibility: task-notification + background_shell_status attachments.
    // We inject these as synthetic assistant messages so the model can decide when to call TaskOutput.
    if (toolUseContext.agentId === 'main') {
      const shell = BunShell.getInstance()

      const agentNotifications = flushBackgroundAgentNotifications({
        sessionId: getEffectiveSessionId(),
      })
      for (const notification of agentNotifications) {
        addNotification({
          title: 'Background agent',
          message: `${notification.description} — ${notification.status}. Output: ${notification.outputFile}`,
          source: 'system',
          kind: notification.status === 'failed' ? 'error' : 'info',
        })

        const text = renderBackgroundAgentNotification(notification)
        const msg = createAssistantMessage(text)
        messages = [...messages, msg]
        yield msg
      }

      const notifications = shell.flushBashNotifications()
      for (const notification of notifications) {
        const status = notification.status
        const exitCode = notification.exitCode
        try {
          finishDurableRun({
            id: notification.taskId,
            status:
              status === 'completed'
                ? 'completed'
                : status === 'killed'
                  ? 'cancelled'
                  : 'failed',
            ...(status === 'completed'
              ? {}
              : { error: `Background bash ${status}.` }),
          })
        } catch {
          // A shell notification must not fail a normal model turn if its
          // optional durable journal cannot be updated.
        }
        const summarySuffix =
          status === 'completed'
            ? `completed${exitCode !== undefined ? ` (exit ${exitCode})` : ''}`
            : status === 'failed'
              ? `failed${exitCode !== undefined ? ` (exit ${exitCode})` : ''}`
              : 'was killed'

        addNotification({
          title: 'Background bash',
          message: `${notification.description} — ${summarySuffix}. Output: ${notification.outputFile}`,
          source: 'system',
          kind: status === 'failed' ? 'error' : 'info',
        })

        const text = renderBashNotification(notification)
        if (text.trim().length === 0) continue
        const msg = createAssistantMessage(text)
        messages = [...messages, msg]
        yield msg
      }

      const attachments = shell.flushBackgroundShellStatusAttachments()
      for (const attachment of attachments) {
        const text = renderBackgroundShellStatusAttachment(attachment)
        if (text.trim().length === 0) continue
        const msg = createAssistantMessage(
          `<tool-progress>${text}</tool-progress>`,
        )
        messages = [...messages, msg]
        yield msg
      }
    }

    // Hooks: keep an up-to-date transcript for hook scripts.
    updateHookTranscriptForMessages(toolUseContext, messages)

    let latestUserPromptText: string | null = null

    // Hooks: UserPromptSubmit
    {
      const last = messages[messages.length - 1]
      let userPromptText: string | null = null
      if (last?.type === 'user') {
        const content = last.message.content
        if (typeof content === 'string') {
          userPromptText = content
        } else if (Array.isArray(content)) {
          const blocks = content as Array<{ type?: unknown; text?: unknown }>
          const hasToolResult = blocks.some(
            b => b && typeof b === 'object' && b.type === 'tool_result',
          )
          if (!hasToolResult) {
            userPromptText = blocks
              .filter(b => b && typeof b === 'object' && b.type === 'text')
              .map(b => String(b.text ?? ''))
              .join('')
          }
        }
      }

      if (userPromptText !== null) {
        latestUserPromptText = userPromptText
        // Keep a stable copy of the user's last prompt (pre-reminder injection) so
        // tools can do intent-alignment checks against the actual user request.
        toolUseContext.options.lastUserPrompt = userPromptText

        const promptOutcome = await runUserPromptSubmitHooks({
          prompt: userPromptText,
          permissionMode: toolUseContext.options?.toolPermissionContext?.mode,
          cwd: getCwd(),
          transcriptPath: getHookTranscriptPath(toolUseContext),
          safeMode: toolUseContext.options?.safeMode ?? false,
          signal: toolUseContext.abortController.signal,
        })

        queueHookSystemMessages(toolUseContext, promptOutcome.systemMessages)
        queueHookAdditionalContexts(
          toolUseContext,
          promptOutcome.additionalContexts,
        )

        if (promptOutcome.decision === 'block') {
          yield createAssistantMessage(promptOutcome.message)
          return
        }
      }
    }

    markPhase('SYSTEM_PROMPT_BUILD')

    // Best-effort: recover plan slug from previous tool results (for resume flows).
    hydratePlanSlugFromMessages(messages, toolUseContext)

    const { systemPrompt: fullSystemPrompt, reminders } =
      formatSystemPromptWithContext(
        systemPrompt,
        context,
        toolUseContext.agentId,
      )

    // Durable memory is deliberately conservative: only explicit preference /
    // convention-like statements are extracted, and ephemeral calls opt out by
    // setting persistSession to false. Retrieval stays local and bounded before
    // becoming a clearly delimited system-prompt addition.
    if (
      toolUseContext.agentId === 'main' &&
      latestUserPromptText !== null &&
      toolUseContext.options.persistSession !== false
    ) {
      try {
        extractLongTermMemories({
          cwd: getCwd(),
          text: latestUserPromptText,
          source: { kind: 'session', id: getEffectiveSessionId() },
        })
        const memoryContext = formatMemoryContext(
          getRelevantMemories({
            cwd: getCwd(),
            query: latestUserPromptText,
            limit: 6,
          }),
        )
        if (memoryContext) fullSystemPrompt.push(memoryContext)
      } catch {
        // Memory must never make a normal turn fail. Storage can be unavailable
        // on read-only or transient environments.
      }
    }

    // Default behavior: plan mode reminders are injected as system-level guidance.
    const planModeAdditions = getPlanModeSystemPromptAdditions(
      messages,
      toolUseContext,
    )
    if (planModeAdditions.length > 0) {
      fullSystemPrompt.push(...planModeAdditions)
    }

    const hookAdditions = drainHookSystemPromptAdditions(toolUseContext)
    if (hookAdditions.length > 0) {
      fullSystemPrompt.push(...hookAdditions)
    }

    // Inject custom system prompt additions (e.g., output style) for main agent
    if (toolUseContext.agentId === 'main') {
      const customAdditions =
        toolUseContext.options.getCustomSystemPromptAdditions?.() ?? []
      if (customAdditions.length > 0) {
        fullSystemPrompt.push(...customAdditions)
      }
    }

    // Emit session startup event (idempotent within the reminder service)
    emitReminderEvent('session:startup', {
      agentId: toolUseContext.agentId,
      sessionId: getEffectiveSessionId(),
      messages: messages.length,
      timestamp: Date.now(),
    })

    // Inject reminders into the latest user message
    if (reminders && messages.length > 0) {
      // Find the last user message
      for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i]
        if (msg?.type === 'user') {
          const lastUserMessage = msg as UserMessage
          messages[i] = {
            ...lastUserMessage,
            message: {
              ...lastUserMessage.message,
              content:
                typeof lastUserMessage.message.content === 'string'
                  ? reminders + lastUserMessage.message.content
                  : [
                      ...(Array.isArray(lastUserMessage.message.content)
                        ? lastUserMessage.message.content
                        : []),
                      { type: 'text', text: reminders },
                    ],
            },
          }
          break
        }
      }
    }

    markPhase('LLM_PREPARATION')

    function getAssistantResponse() {
      return queryLLM(
        normalizeMessagesForAPI(messages),
        fullSystemPrompt,
        toolUseContext.options.maxThinkingTokens,
        toolUseContext.options.tools,
        toolUseContext.abortController.signal,
        {
          safeMode: toolUseContext.options.safeMode ?? false,
          model: toolUseContext.options.model || 'main',
          prependCLISysprompt: true,
          toolUseContext: toolUseContext,
        },
      )
    }

    const result = await queryWithBinaryFeedback(
      toolUseContext,
      getAssistantResponse,
      getBinaryFeedbackResponse,
    )

    // If request was cancelled, return immediately with interrupt message
    if (toolUseContext.abortController.signal.aborted) {
      yield createAssistantMessage(INTERRUPT_MESSAGE)
      return
    }

    if (result.message === null) {
      yield createAssistantMessage(INTERRUPT_MESSAGE)
      return
    }

    const assistantMessage = result.message
    const shouldSkipPermissionCheck = result.shouldSkipPermissionCheck

    // @see https://docs.anthropic.com/en/docs/build-with-claude/tool-use
    // Note: stop_reason === 'tool_use' is unreliable -- it's not always set correctly
    const toolUseMessages =
      assistantMessage.message.content.filter(isToolUseLikeBlock)

    // If there's no more tool use, we're done
    if (!toolUseMessages.length) {
      if (isThinkingOnlyAssistantMessage(assistantMessage)) {
        if (thinkingOnlyAttempts < MAX_THINKING_ONLY_RETRIES) {
          const retryNumber = thinkingOnlyAttempts + 1
          // A reasoning-only response did not make progress. Do not add it to
          // the transcript or expose repeated internal planning in the UI;
          // send a concrete follow-up user instruction instead so models that
          // ignore appended system text receive an actionable next turn.
          yield* await messagePipelineCore(
            [
              ...messages.filter(
                message => !isThinkingOnlyRecoveryMessage(message),
              ),
              createThinkingOnlyRecoveryMessage(retryNumber),
            ],
            [...systemPrompt, createThinkingOnlyRetryPrompt(retryNumber)],
            context,
            canUseTool,
            toolUseContext,
            getBinaryFeedbackResponse,
            {
              ...hookState,
              thinkingOnlyAttempts: retryNumber,
            },
          )
          return
        }

        toolUseContext.turnCount = turnsUsed + 1
        yield createAssistantAPIErrorMessage(
          `API_ERROR: Model returned internal reasoning only for ${MAX_THINKING_ONLY_RETRIES + 1} consecutive attempts without a final response or tool call. Please retry or switch models.`,
        )
        return
      }

      toolUseContext.turnCount = turnsUsed + 1

      const stopHookEvent =
        toolUseContext.agentId && toolUseContext.agentId !== 'main'
          ? ('SubagentStop' as const)
          : ('Stop' as const)
      const record = asRecord(assistantMessage.message)
      const stopReason =
        (record && typeof record.stop_reason === 'string'
          ? record.stop_reason
          : '') ||
        (record && typeof record.stopReason === 'string'
          ? record.stopReason
          : '') ||
        'end_turn'

      const stopOutcome = await runStopHooks({
        hookEvent: stopHookEvent,
        reason: String(stopReason ?? ''),
        agentId: toolUseContext.agentId,
        permissionMode: toolUseContext.options?.toolPermissionContext?.mode,
        cwd: getCwd(),
        transcriptPath: getHookTranscriptPath(toolUseContext),
        safeMode: toolUseContext.options?.safeMode ?? false,
        stopHookActive,
        signal: toolUseContext.abortController.signal,
      })

      if (stopOutcome.systemMessages.length > 0) {
        queueHookSystemMessages(toolUseContext, stopOutcome.systemMessages)
      }
      if (stopOutcome.additionalContexts.length > 0) {
        queueHookAdditionalContexts(
          toolUseContext,
          stopOutcome.additionalContexts,
        )
      }

      if (stopOutcome.decision === 'block') {
        queueHookSystemMessages(toolUseContext, [stopOutcome.message])
        const MAX_STOP_HOOK_ATTEMPTS = 5
        if (stopHookAttempts < MAX_STOP_HOOK_ATTEMPTS) {
          yield* await messagePipelineCore(
            [...messages, assistantMessage],
            systemPrompt,
            context,
            canUseTool,
            toolUseContext,
            getBinaryFeedbackResponse,
            {
              stopHookActive: true,
              stopHookAttempts: stopHookAttempts + 1,
            },
          )
          return
        }
      }

      if (toolUseContext.agentId === 'main') {
        const goalOutcome = await evaluateActiveGoalAfterTurn({
          cwd: getCwd(),
          sessionId: getEffectiveSessionId(),
          assistantText: getAssistantTextForGoalEvaluation(assistantMessage),
          signal: toolUseContext.abortController.signal,
        })

        if (goalOutcome.action === 'continue' && goalOutcome.goal) {
          const continuationPrompt = buildGoalContinuationPrompt({
            objective: goalOutcome.goal.objective,
            acceptanceCriteria: goalOutcome.goal.acceptanceCriteria,
            continuationPrompt:
              goalOutcome.continuationPrompt ??
              'Continue working toward the active goal.',
          })

          yield assistantMessage
          yield* await messagePipelineCore(
            [...messages, assistantMessage],
            [...systemPrompt, continuationPrompt],
            context,
            canUseTool,
            toolUseContext,
            getBinaryFeedbackResponse,
            {
              // Fresh goal continuation must not inherit stop-hook counters.
              stopHookActive: false,
              stopHookAttempts: 0,
              thinkingOnlyAttempts: 0,
            },
          )
          return
        }

        if (
          goalOutcome.action === 'complete' ||
          goalOutcome.action === 'paused' ||
          goalOutcome.action === 'expired'
        ) {
          const status =
            goalOutcome.action === 'complete'
              ? 'completed'
              : goalOutcome.action === 'expired'
                ? 'expired'
                : 'paused'
          addNotification({
            title: 'Goal run',
            message: `Goal ${status}${goalOutcome.reason ? `: ${goalOutcome.reason}` : ''}`,
            source: 'system',
            kind: status === 'completed' ? 'info' : 'warning',
          })
        }
      }

      yield assistantMessage
      return
    }

    toolUseContext.turnCount = turnsUsed + 1
    yield assistantMessage
    const siblingToolUseIDs = new Set<string>(toolUseMessages.map(_ => _.id))
    const toolQueue = new ToolUseQueue({
      toolDefinitions: toolUseContext.options.tools,
      canUseTool,
      toolUseContext,
      siblingToolUseIDs,
      shouldSkipPermissionCheck,
    })

    for (const toolUse of toolUseMessages) {
      toolQueue.addTool(toolUse, assistantMessage)
    }

    const toolMessagesForNextTurn: (UserMessage | AssistantMessage)[] = []
    for await (const message of toolQueue.getRemainingResults()) {
      yield message
      if (message.type !== 'progress') {
        toolMessagesForNextTurn.push(message as UserMessage | AssistantMessage)
      }
    }

    toolUseContext = toolQueue.getUpdatedContext()

    if (toolUseContext.abortController.signal.aborted) {
      yield createAssistantMessage(INTERRUPT_MESSAGE_FOR_TOOL_USE)
      return
    }

    // Recursive query after tools: reset per-turn recovery counters so a
    // previous stop-hook or thinking-only streak cannot leak into the next turn.
    try {
      yield* await messagePipelineCore(
        [...messages, assistantMessage, ...toolMessagesForNextTurn],
        systemPrompt,
        context,
        canUseTool,
        toolUseContext,
        getBinaryFeedbackResponse,
        {
          stopHookActive: false,
          stopHookAttempts: 0,
          thinkingOnlyAttempts: 0,
        },
      )
    } catch (error) {
      // Re-throw the error to maintain the original behavior
      throw error
    }
  } finally {
    setRequestStatus({ kind: 'idle' })
  }
}

export * from '#core/query/agentEvents'
