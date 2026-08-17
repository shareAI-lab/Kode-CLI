import { queryLLM } from '#core/ai/llmLazy'
import { getTotalCost } from '#core/cost-tracker'
import { finishDurableRun } from '#core/runs'
import { MaxBudgetUsdExceededError } from '#core/errors/maxBudgetUsd'
import { MaxTurnsExceededError } from '#protocol/maxTurns'
import {
  acknowledgeSessionMessages,
  claimSessionMessages,
  formatSessionMessagesForContext,
  releaseSessionMessageClaims,
  type SessionMessage,
} from '#protocol/sessionMessaging'
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
import { getCwd, getOriginalCwd } from '#core/utils/state'
import { getEffectiveSessionId } from '#core/utils/sessionId'
import {
  flushBackgroundAgentNotifications,
  renderBackgroundAgentNotification,
} from '#core/tasks'
import {
  acknowledgeBackgroundAgentGuidance,
  claimBackgroundAgentGuidance,
  formatBackgroundAgentGuidanceForContext,
  releaseBackgroundAgentGuidance,
  type BackgroundAgentGuidance,
} from '#core/utils/backgroundTasks'
import {
  extractLongTermMemories,
  formatMemoryContext,
  getRelevantMemories,
} from '#core/memory'
import {
  formatProjectLearningContext,
  getRelevantProjectLearnings,
} from '#core/projectLearning'
import { evaluateActiveGoalAfterTurn, GoalService } from '#core/goals'
import { checkAutoCompact } from '#core/utils/autoCompactCore'
import { checkMicroCompact } from '#core/utils/microCompactCore'
import {
  collectGoalVerificationEvidence,
  getTurnVerificationState,
} from './verification/evidence'
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
import { createExternalToolCallBridge } from './pipeline/external-tool-bridge'
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
  requiredToolUseAttempts?: number
  verificationAttempts?: number
}

const MAX_THINKING_ONLY_RETRIES = 3
const MAX_REQUIRED_TOOL_USE_RECOVERIES = 1
const MAX_VERIFICATION_RECOVERIES = 1

const TOOL_USE_INTENT_PATTERNS = [
  /(?:查看|看看|检查|检视|浏览|读取|搜索|查找|分析|审查|审阅|排查).{0,20}(?:项目|工程|代码库|代码|仓库|文件|目录|工作区)/u,
  /(?:运行|执行|测试|构建|编译|打包|安装|提交|推送|部署|修复|修改|编辑).{0,20}(?:项目|工程|代码|仓库|文件|目录|测试|构建|编译|打包|安装|提交|推送|部署)/u,
  /\b(?:inspect|explore|search|find|read|look\s+at|check|review|analy[sz]e)\b[\s\S]{0,48}\b(?:project|repository|repo|codebase|source|files?|directories?|workspace)\b/i,
  /\b(?:run|execute|test|build|compile|package|install|commit|push|deploy|edit|modify|fix)\b[\s\S]{0,48}\b(?:project|repository|repo|codebase|source|files?|directories?|workspace|tests?|build|compile|package)\b/i,
]

const TOOL_USE_NEGATION_PATTERN =
  /(?:不要|无需|不必|别|不用).{0,16}(?:查看|看看|检查|检视|浏览|读取|搜索|查找|分析|审查|审阅|排查|运行|执行|测试|构建|编译|打包|安装|提交|推送|部署|修复|修改|编辑)|\b(?:do not|don't|no need to|without)\b[\s\S]{0,32}\b(?:inspect|explore|search|find|read|check|review|run|execute|test|build|compile|package|install|commit|push|deploy|edit|modify|fix)\b/i

const TOOL_USE_ADVISORY_QUESTION_PATTERN =
  /^\s*(?:what|which)\b[\s\S]{0,96}\b(?:should|would|could)\b[\s\S]{0,64}\b(?:use|choose|prefer|recommend)\b\s*\??\s*$/i

function hasExplicitToolUseIntent(prompt: string | null): boolean {
  if (!prompt?.trim()) return false
  if (TOOL_USE_NEGATION_PATTERN.test(prompt)) return false
  if (TOOL_USE_ADVISORY_QUESTION_PATTERN.test(prompt)) return false
  return TOOL_USE_INTENT_PATTERNS.some(pattern => pattern.test(prompt))
}

function requiresToolUseForPrompt(
  prompt: string | null,
  availableToolCount: number,
): boolean {
  return availableToolCount > 0 && hasExplicitToolUseIntent(prompt)
}

function createRequiredToolUseInstruction(): string {
  return [
    '<tool_use_requirement>',
    'The user explicitly requested local project inspection or an action.',
    'Before giving a final answer, call at least one appropriate available tool.',
    'For inspection, begin with a read-only discovery tool. For an action, use the relevant tool and report only evidence from its result.',
    'Do not invent project details or claim the request was completed without a tool result.',
    '</tool_use_requirement>',
  ].join('\n')
}

function createRequiredToolUseRecoveryMessage(): UserMessage {
  return createUserMessage(
    [
      '<tool_use_recovery>',
      'The previous response did not call a tool despite the user explicitly requesting project inspection or an action.',
      'Call an appropriate available tool now before replying. Do not provide a plan, recollection, or unverified answer.',
      '</tool_use_recovery>',
    ].join('\n'),
  )
}

function isRequiredToolUseRecoveryMessage(message: Message): boolean {
  return (
    message.type === 'user' &&
    typeof message.message.content === 'string' &&
    message.message.content.startsWith('<tool_use_recovery>')
  )
}

export function __getInitialRequestStatusDetailForTests(
  messages: Message[],
): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message?.type !== 'user') continue

    const detail = message.options?.requestStatusDetail?.trim()
    if (detail) return detail
  }

  return undefined
}

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

function createVerificationRecoveryMessage(): UserMessage {
  return createUserMessage(
    [
      '<verification-recovery>',
      'A direct workspace-writing tool completed in this turn, but no trusted terminal verification result was recorded after the latest write.',
      'Run the narrowest applicable deterministic test, typecheck, lint, build, or check now. Prefer a focused command over a broad suite, and read project instructions first if the command is unclear.',
      'If verification fails, fix the issue when it is in scope and rerun the relevant check. If verification is blocked, report the exact blocker and do not claim that checks passed.',
      'Do not make unrelated changes.',
      '</verification-recovery>',
    ].join('\n'),
  )
}

function appendVerificationUnavailableNotice(
  assistantMessage: AssistantMessage,
): AssistantMessage {
  const content = [...assistantMessage.message.content]
  const assistantText = content
    .filter(block => block.type === 'text')
    .map(block => (block.type === 'text' ? block.text : ''))
    .join('\n')
  const notice = /[\u3400-\u9fff]/u.test(assistantText)
    ? '本次会话没有可信终端工具，因此未运行自动验证。工具实际应用的工作区改动仍会保留；依赖该结果前，请手动验证或使用可信执行工具重新运行。'
    : 'Automated verification was not run because this session has no trusted terminal tool. Any workspace changes applied by tools remain in place; verify them manually or rerun with a trusted execution tool before relying on the result.'
  let lastTextIndex = -1
  for (let index = content.length - 1; index >= 0; index -= 1) {
    if (content[index]?.type !== 'text') continue
    lastTextIndex = index
    break
  }

  if (lastTextIndex >= 0) {
    const block = content[lastTextIndex]
    if (block?.type === 'text') {
      content[lastTextIndex] = {
        ...block,
        text: `${block.text.trimEnd()}\n\n${notice}`,
      }
    }
  } else {
    content.push({ type: 'text', text: notice, citations: [] })
  }

  return {
    ...assistantMessage,
    message: { ...assistantMessage.message, content },
  }
}

function isVerificationRecoveryMessage(message: Message): boolean {
  return (
    message.type === 'user' &&
    typeof message.message.content === 'string' &&
    message.message.content.startsWith('<verification-recovery>')
  )
}

function isEngineRecoveryMessage(message: Message): boolean {
  return (
    isRequiredToolUseRecoveryMessage(message) ||
    isThinkingOnlyRecoveryMessage(message) ||
    isVerificationRecoveryMessage(message)
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
  setRequestStatus({
    kind: 'waiting',
    detail: __getInitialRequestStatusDetailForTests(messages),
    inputTokens: undefined,
    outputTokens: undefined,
  })

  try {
    markPhase('QUERY_INIT')
    const stopHookActive = hookState?.stopHookActive === true
    const stopHookAttempts = hookState?.stopHookAttempts ?? 0
    const thinkingOnlyAttempts = hookState?.thinkingOnlyAttempts ?? 0
    const requiredToolUseAttempts = hookState?.requiredToolUseAttempts ?? 0
    const verificationAttempts = hookState?.verificationAttempts ?? 0

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
    // Defer compaction while the active turn has written to the workspace
    // without terminal verification evidence: compaction replaces the
    // transcript with a summary, which would silently discard the mutation and
    // verification receipts the completion gate relies on. The gate resolves
    // within the same turn (recovery or a hard error), so the deferral is
    // bounded and cannot grow the transcript unboundedly.
    const preCompactVerificationState = getTurnVerificationState(messages)
    const shouldDeferAutoCompact =
      preCompactVerificationState.hasMutation &&
      !preCompactVerificationState.hasTerminalEvidence
    const { messages: processedMessages, wasCompacted } = shouldDeferAutoCompact
      ? { messages, wasCompacted: false as const }
      : await checkAutoCompact(messages, toolUseContext)
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
      if (last?.type === 'user' && !isEngineRecoveryMessage(last)) {
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

    const hasExplicitToolUseIntentForTurn =
      requiredToolUseAttempts > 0 ||
      hasExplicitToolUseIntent(latestUserPromptText)
    const availableToolCount = toolUseContext.options.tools.length

    // Never let an explicit project action silently degrade into a text-only
    // answer when startup/configuration failed to provide the core tool set.
    // Retrying the model cannot repair a request that contains no tools.
    if (hasExplicitToolUseIntentForTurn && availableToolCount === 0) {
      yield createAssistantAPIErrorMessage(
        'API_ERROR: No local tools are available in this session, so the requested project inspection or action was not executed. Restart Kode or run /capabilities; if this persists, check the model endpoint and tool configuration.',
      )
      return
    }

    const currentSessionId = getEffectiveSessionId()
    let claimedSessionMessages: SessionMessage[] = []
    let claimedAgentGuidance: BackgroundAgentGuidance[] = []
    const guidanceAgentId =
      toolUseContext.agentId && toolUseContext.agentId !== 'main'
        ? toolUseContext.agentId
        : null
    if (toolUseContext.agentId === 'main') {
      try {
        claimedSessionMessages = await claimSessionMessages({
          cwd: getCwd(),
          sessionId: currentSessionId,
        })
        for (const message of claimedSessionMessages) {
          const preview = message.body.replace(/\s+/g, ' ').trim()
          addNotification({
            id: `session-message-${message.messageId}`,
            title: 'Session message received',
            message: `From ${message.senderSessionId}: ${
              preview.length > 160 ? `${preview.slice(0, 159)}…` : preview
            }`,
            source: 'system',
            kind: 'info',
            channel: 'session-message',
          })
        }
      } catch {
        // Mailbox storage is cooperative infrastructure. A transient local
        // filesystem failure must not block the user's normal model turn.
      }
    } else if (guidanceAgentId) {
      claimedAgentGuidance = claimBackgroundAgentGuidance({
        agentId: guidanceAgentId,
      })
    }

    const { systemPrompt: fullSystemPrompt, reminders: standardReminders } =
      formatSystemPromptWithContext(
        systemPrompt,
        context,
        toolUseContext.agentId,
      )
    const reminders =
      formatSessionMessagesForContext(claimedSessionMessages) +
      formatBackgroundAgentGuidanceForContext(claimedAgentGuidance) +
      standardReminders

    const releaseClaimedSessionMessages = async (): Promise<void> => {
      if (claimedSessionMessages.length === 0) return
      try {
        await releaseSessionMessageClaims({
          cwd: getCwd(),
          sessionId: currentSessionId,
          messageIds: claimedSessionMessages.map(message => message.messageId),
        })
      } catch {
        // An expired claim is recoverable by the mailbox lease scanner.
      }
    }

    const requiresToolUse =
      requiredToolUseAttempts > 0 ||
      requiresToolUseForPrompt(latestUserPromptText, availableToolCount)
    if (requiresToolUse) {
      fullSystemPrompt.push(createRequiredToolUseInstruction())
    }

    // External runtimes such as Codex app-server request dynamic tool calls
    // while their turn is still in flight. Give them a bridge into the same
    // Kode execution path instead of letting them bypass permissions.
    toolUseContext.options.executeExternalToolCall ??=
      createExternalToolCallBridge({ canUseTool, toolUseContext })

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
        // Long-term memory must never make a normal turn fail. Storage can be
        // unavailable on read-only or transient environments.
      }

      try {
        const learningContext = formatProjectLearningContext(
          getRelevantProjectLearnings({
            cwd: getOriginalCwd(),
            query: latestUserPromptText,
            limit: 4,
          }),
        )
        if (learningContext) fullSystemPrompt.push(learningContext)
      } catch {
        // Project learning is independently best-effort: an unavailable
        // learning store must not suppress regular durable memory either.
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

    // Dynamic external-runtime tool calls run while the provider turn is in
    // flight. Each provider request starts with a fresh counter and transcript
    // buffer so required-tool and verification checks describe this turn only.
    toolUseContext.options.externalToolCallCount = 0
    toolUseContext.externalToolMessages = []

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

    let result: Awaited<ReturnType<typeof queryWithBinaryFeedback>>
    try {
      result = await queryWithBinaryFeedback(
        toolUseContext,
        getAssistantResponse,
        getBinaryFeedbackResponse,
      )
    } catch (error) {
      await releaseClaimedSessionMessages()
      if (claimedAgentGuidance.length > 0 && guidanceAgentId) {
        releaseBackgroundAgentGuidance({
          agentId: guidanceAgentId,
          guidanceIds: claimedAgentGuidance.map(item => item.guidanceId),
        })
      }
      throw error
    }

    // If request was cancelled, return immediately with interrupt message
    if (toolUseContext.abortController.signal.aborted) {
      await releaseClaimedSessionMessages()
      if (claimedAgentGuidance.length > 0 && guidanceAgentId) {
        releaseBackgroundAgentGuidance({
          agentId: guidanceAgentId,
          guidanceIds: claimedAgentGuidance.map(item => item.guidanceId),
        })
      }
      yield createAssistantMessage(INTERRUPT_MESSAGE)
      return
    }

    if (result.message === null) {
      await releaseClaimedSessionMessages()
      if (claimedAgentGuidance.length > 0 && guidanceAgentId) {
        releaseBackgroundAgentGuidance({
          agentId: guidanceAgentId,
          guidanceIds: claimedAgentGuidance.map(item => item.guidanceId),
        })
      }
      yield createAssistantMessage(INTERRUPT_MESSAGE)
      return
    }

    const assistantMessage = result.message
    // Count every completed model request before any internal recovery recurs.
    // This keeps --max-turns and SDK num_turns aligned with actual provider
    // calls instead of allowing hidden retries to bypass the configured cap.
    toolUseContext.turnCount = turnsUsed + 1

    const externalToolMessages = toolUseContext.externalToolMessages ?? []
    toolUseContext.externalToolMessages = []
    if (externalToolMessages.length > 0) {
      // Progress rows are rendered for the active turn only. Persist the
      // corresponding tool-use/result messages for future context and
      // verification, matching the regular ToolUseQueue behavior.
      messages = [
        ...messages,
        ...externalToolMessages.filter(message => message.type !== 'progress'),
      ]
      for (const message of externalToolMessages) {
        yield message
      }
    }

    // Provider/stream errors are already classified by the LLM adapter. Never
    // execute tool blocks from an error response, and preserve the original
    // evidence instead of rewriting it as a misleading no-tool failure.
    if (assistantMessage.isApiErrorMessage) {
      await releaseClaimedSessionMessages()
      if (claimedAgentGuidance.length > 0 && guidanceAgentId) {
        releaseBackgroundAgentGuidance({
          agentId: guidanceAgentId,
          guidanceIds: claimedAgentGuidance.map(item => item.guidanceId),
        })
      }
      yield assistantMessage
      return
    }

    if (claimedSessionMessages.length > 0) {
      try {
        await acknowledgeSessionMessages({
          cwd: getCwd(),
          sessionId: currentSessionId,
          messageIds: claimedSessionMessages.map(message => message.messageId),
        })
      } catch (error) {
        await releaseClaimedSessionMessages()
        if (claimedAgentGuidance.length > 0 && guidanceAgentId) {
          releaseBackgroundAgentGuidance({
            agentId: guidanceAgentId,
            guidanceIds: claimedAgentGuidance.map(item => item.guidanceId),
          })
        }
        throw error
      }
    }

    if (claimedAgentGuidance.length > 0 && guidanceAgentId) {
      acknowledgeBackgroundAgentGuidance({
        agentId: guidanceAgentId,
        guidanceIds: claimedAgentGuidance.map(item => item.guidanceId),
      })
    }

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

        yield createAssistantAPIErrorMessage(
          `API_ERROR: Model returned internal reasoning only for ${MAX_THINKING_ONLY_RETRIES + 1} consecutive attempts without a final response or tool call. Please retry or switch models.`,
        )
        return
      }

      if (
        requiresToolUse &&
        (toolUseContext.options.externalToolCallCount ?? 0) === 0
      ) {
        if (requiredToolUseAttempts < MAX_REQUIRED_TOOL_USE_RECOVERIES) {
          yield* await messagePipelineCore(
            [
              ...messages.filter(
                message => !isRequiredToolUseRecoveryMessage(message),
              ),
              createRequiredToolUseRecoveryMessage(),
            ],
            [...systemPrompt, createRequiredToolUseInstruction()],
            context,
            canUseTool,
            toolUseContext,
            getBinaryFeedbackResponse,
            {
              ...hookState,
              requiredToolUseAttempts: requiredToolUseAttempts + 1,
            },
          )
          return
        }

        yield createAssistantAPIErrorMessage(
          'The model did not request a tool after an automatic retry. This project request was not executed; retry or switch to a model with reliable tool calling.',
        )
        return
      }

      const hasTrustedVerificationTool = toolUseContext.options.tools.some(
        tool => tool.name === 'Bash' && tool.isTrustedExecutionTool === true,
      )
      const verificationState = getTurnVerificationState(
        messages,
        toolUseContext.options.tools,
      )
      if (
        verificationState.hasMutation &&
        !verificationState.hasTerminalEvidence
      ) {
        if (
          hasTrustedVerificationTool &&
          verificationAttempts < MAX_VERIFICATION_RECOVERIES
        ) {
          yield* await messagePipelineCore(
            [
              ...messages.filter(
                message => !isVerificationRecoveryMessage(message),
              ),
              assistantMessage,
              createVerificationRecoveryMessage(),
            ],
            systemPrompt,
            context,
            canUseTool,
            toolUseContext,
            getBinaryFeedbackResponse,
            {
              ...hookState,
              verificationAttempts: verificationAttempts + 1,
            },
          )
          return
        }

        if (!hasTrustedVerificationTool) {
          yield appendVerificationUnavailableNotice(assistantMessage)
          return
        }

        yield createAssistantAPIErrorMessage(
          'Verification incomplete: a direct workspace-writing tool ran, but the model still did not record a completed test, typecheck, lint, build, or check after the latest write. The workspace is unchanged by this warning; run a focused check or retry the turn.',
        )
        return
      }

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
          verificationEvidence: collectGoalVerificationEvidence(
            messages,
            toolUseContext.options.tools,
          ),
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
        verificationAttempts,
      },
    )
  } finally {
    setRequestStatus({ kind: 'idle' })
  }
}

export * from '#core/query/agentEvents'
