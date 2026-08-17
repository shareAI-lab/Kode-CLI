import { last } from 'lodash-es'

import type { TextBlock } from '@anthropic-ai/sdk/resources/index.mjs'

import type { Message as ConversationMessage } from '#core/query'
import {
  getLastAssistantMessageId,
  createAssistantMessage,
  createUserMessage,
} from '#core/utils/messages'
import {
  getQueuedBackgroundAgentGuidanceIds,
  hasQueuedBackgroundAgentGuidance,
  upsertBackgroundAgentTask,
  updateBackgroundAgentActivity,
  type BackgroundAgentTaskRuntime,
} from '#core/utils/backgroundTasks'
import { saveAgentTranscript } from '#core/utils/agentTranscripts'
import { hasPermissionsToUseTool } from '#core/permissions'
import {
  appendBackgroundTaskOutput,
  flushBackgroundTaskOutput,
  touchBackgroundTaskOutputFile,
} from '#core/tasks/backgroundRegistry'
import type { AgentSupervisor } from '#core/utils/agentSupervisor'

import type { PreparedTaskToolRun } from './callTypes'
import type { Input, Output } from './schema'
import { asyncLaunchMessage } from './assistantText'
import {
  awaitAgentIteratorNext,
  BackgroundAgentLifecycle,
  runInPreparedAgentScope,
} from './backgroundLifecycle'

function isTextBlock(block: unknown): block is TextBlock {
  return (
    Boolean(block) &&
    typeof block === 'object' &&
    (block as { type?: unknown }).type === 'text' &&
    typeof (block as { text?: unknown }).text === 'string'
  )
}

export async function* callTaskToolBackground(
  input: Input,
  prepared: PreparedTaskToolRun,
  metadata?: {
    parentAgentId?: string
    parentToolUseId?: string
    subagentType?: string
    model?: string
    supervisor?: AgentSupervisor
  },
): AsyncGenerator<{
  type: 'result'
  data: Output
  resultForAssistant: string
}> {
  const bgAbortController = new AbortController()
  const outputFile = touchBackgroundTaskOutputFile(prepared.agentId)
  if (!metadata?.supervisor) {
    throw new Error('Background agent requires a supervisor')
  }
  const lifecycle = new BackgroundAgentLifecycle({
    agentId: prepared.agentId,
    description: input.description,
    cwd: prepared.cwd,
    sessionId: prepared.sessionId,
    outputFile,
    abortController: bgAbortController,
    supervisor: metadata.supervisor,
  })
  const bgMessages: ConversationMessage[] = [...prepared.messagesForQuery]
  const bgTranscriptMessages: ConversationMessage[] = [
    ...prepared.transcriptMessages,
  ]
  const runTranscriptStartIndex = bgTranscriptMessages.length

  const taskRecord: BackgroundAgentTaskRuntime = {
    type: 'async_agent',
    agentId: prepared.agentId,
    parentAgentId: metadata?.parentAgentId,
    parentToolUseId: metadata?.parentToolUseId,
    subagentType: metadata?.subagentType,
    model: metadata?.model,
    description: input.description,
    prompt: prepared.effectivePrompt,
    status: 'running',
    cwd: prepared.cwd,
    sessionId: prepared.sessionId,
    startedAt: Date.now(),
    lastActivityAt: Date.now(),
    turnCount: 0,
    guidance: [],
    messages: bgTranscriptMessages,
    abortController: bgAbortController,
    done: Promise.resolve(),
  }

  taskRecord.done = runInPreparedAgentScope(prepared, async () => {
    try {
      const childToolUseContext = {
        abortController: bgAbortController,
        options: prepared.queryOptions,
        messageId: getLastAssistantMessageId(bgMessages),
        agentId: prepared.agentId,
        readFileTimestamps: prepared.readFileTimestamps,
        setToolJSX: () => {},
        turnCount: 0,
      }

      // Guidance can arrive while the provider is producing a final answer.
      // Re-enter the same bounded context when that happens, so the instruction
      // is observed without resetting the hard turn cap.
      while (true) {
        const queuedAtTurnStart = getQueuedBackgroundAgentGuidanceIds(
          prepared.agentId,
        ).join(',')
        childToolUseContext.messageId = getLastAssistantMessageId(bgMessages)
        const queryStream = prepared.queryFn(
          bgMessages,
          prepared.systemPrompt,
          prepared.context,
          hasPermissionsToUseTool,
          childToolUseContext,
        )
        const queryIterator = queryStream[Symbol.asyncIterator]()
        let pendingNext = queryIterator.next()
        while (true) {
          const step = await awaitAgentIteratorNext(
            queryIterator,
            pendingNext,
            bgAbortController.signal,
          )
          if (step.done === true) break
          const msg = step.value
          bgMessages.push(msg)
          bgTranscriptMessages.push(msg)

          if (msg.type === 'assistant') {
            const content = msg.message.content
            const text =
              typeof content === 'string'
                ? content
                : Array.isArray(content)
                  ? content
                      .filter(isTextBlock)
                      .map(b => b.text)
                      .join('\n')
                  : ''
            if (text) {
              appendBackgroundTaskOutput(
                prepared.agentId,
                text.trimEnd() + '\n',
              )
            }
          }

          taskRecord.lastActivityAt = Date.now()
          taskRecord.turnCount = childToolUseContext.turnCount ?? 0
          upsertBackgroundAgentTask(taskRecord)
          lifecycle.heartbeat()
          pendingNext = queryIterator.next()
        }

        updateBackgroundAgentActivity({
          agentId: prepared.agentId,
          turnCount: childToolUseContext.turnCount ?? 0,
        })
        if (!hasQueuedBackgroundAgentGuidance(prepared.agentId)) break
        const queuedAtTurnEnd = getQueuedBackgroundAgentGuidanceIds(
          prepared.agentId,
        ).join(',')
        if (queuedAtTurnStart && queuedAtTurnStart === queuedAtTurnEnd) {
          throw new Error(
            'Background agent query adapter did not consume queued runtime guidance.',
          )
        }

        const continuation = createUserMessage(
          'Continue the task using the latest runtime guidance from the main agent.',
        )
        bgMessages.push(continuation)
        bgTranscriptMessages.push(continuation)
      }

      const lastAssistant = last(
        bgTranscriptMessages
          .slice(runTranscriptStartIndex)
          .filter(m => m.type === 'assistant'),
      )
      const content =
        lastAssistant?.type === 'assistant'
          ? lastAssistant.message.content.filter(isTextBlock)
          : []

      const resultText = content.map(b => b.text).join('\n')
      const childFailed =
        !lastAssistant || lastAssistant.isApiErrorMessage === true

      if (taskRecord.status !== 'killed') {
        taskRecord.status = childFailed ? 'failed' : 'completed'
        taskRecord.completedAt = Date.now()
        taskRecord.resultText = resultText
        if (childFailed) {
          taskRecord.error =
            resultText || 'Subagent ended without an assistant response.'
        }
      } else {
        taskRecord.completedAt = taskRecord.completedAt ?? Date.now()
        if (resultText) taskRecord.resultText = resultText
        appendBackgroundTaskOutput(
          prepared.agentId,
          '\n[task killed]\n'.replace(/^\n+/, ''),
        )
      }
      upsertBackgroundAgentTask(taskRecord)
      saveAgentTranscript(
        {
          agentId: prepared.agentId,
          cwd: prepared.cwd,
          sessionId: prepared.sessionId,
        },
        bgTranscriptMessages,
      )
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)

      if (taskRecord.status === 'killed') {
        taskRecord.status = 'killed'
        taskRecord.completedAt = taskRecord.completedAt ?? Date.now()
        taskRecord.error = taskRecord.error ?? (message || 'Killed by user')
        appendBackgroundTaskOutput(
          prepared.agentId,
          '\n[task killed]\n'.replace(/^\n+/, ''),
        )
      } else {
        taskRecord.status = 'failed'
        taskRecord.completedAt = Date.now()
        taskRecord.error = message
        appendBackgroundTaskOutput(
          prepared.agentId,
          `\n[error] ${message}\n`.replace(/^\n+/, ''),
        )
      }
      upsertBackgroundAgentTask(taskRecord)
    } finally {
      flushBackgroundTaskOutput(prepared.agentId)
      lifecycle.finish(
        taskRecord.status === 'completed'
          ? 'completed'
          : taskRecord.status === 'killed'
            ? 'cancelled'
            : 'failed',
        taskRecord.error,
      )
    }
  })

  upsertBackgroundAgentTask(taskRecord)

  const output: Output = {
    status: 'async_launched',
    agentId: prepared.agentId,
    description: input.description,
    prompt: prepared.effectivePrompt,
  }

  yield {
    type: 'result',
    data: output,
    resultForAssistant: asyncLaunchMessage(prepared.agentId),
  }
}
