import type { Tool, ToolUseContext } from '@kode/tool-interface/Tool'
import { getAvailableAgentTypes } from '@kode/agent'
import { getAgentTranscript } from '#core/utils/agentTranscripts'
import { getCwd } from '#core/utils/state'
import { getKodeAgentSessionId } from '#protocol/utils/kodeAgentSessionId'
import { loadKodeAgentSidechainMessagesForResume } from '#protocol/utils/kodeAgentSessionLoad'

import { TOOL_NAME } from './constants'
import { getPrompt } from './prompt'
import { callTaskTool, getVoiceTaskDispatchError } from './call'
import { inputSchema, type Input, type Output } from './schema'
import {
  renderTaskToolResultForAssistant,
  renderTaskToolResultMessage,
  renderTaskToolUseMessage,
} from './render'

export const TaskTool = {
  name: TOOL_NAME,
  inputSchema,
  async description() {
    return 'Launch a new task'
  },
  async prompt(options?: { safeMode?: boolean }) {
    return await getPrompt(options?.safeMode ?? false)
  },
  userFacingName(input?: Partial<Input>) {
    if (input?.subagent_type && input.subagent_type !== 'general-purpose') {
      return input.subagent_type
    }
    return 'Task'
  },
  async isEnabled() {
    return true
  },
  isReadOnly() {
    // A standalone Task can select an arbitrary agent configuration. It must
    // therefore be treated as mutating until a constrained read-only task is
    // represented explicitly (TaskBatch has that input-level check).
    return false
  },
  workspaceMutationScope(_input?: Input, output?: Output) {
    // The child pipeline owns mutation detection and verification. Requiring
    // the parent to verify the Task invocation duplicates that gate and turns
    // read-only Explore/Plan tasks into false workspace writes. A failed child
    // may have left partial writes, so the parent takes verification ownership.
    return output?.status === 'failed'
      ? ('direct' as const)
      : ('delegated' as const)
  },
  isConcurrencySafe() {
    // A standalone Task has no declared read/write mode and may select an
    // unrestricted agent. Serialize it at the parent scheduler boundary.
    // Explicitly verified read-only parallelism is available via TaskBatch.
    return false
  },
  needsPermissions() {
    return false
  },
  async validateInput(input: Input, context?: ToolUseContext) {
    const voiceDispatchError = context
      ? getVoiceTaskDispatchError(context)
      : null
    if (voiceDispatchError) {
      return { result: false, message: voiceDispatchError }
    }
    if (!input.description || typeof input.description !== 'string') {
      return {
        result: false,
        message: 'Description is required and must be a string',
      }
    }
    if (!input.prompt || typeof input.prompt !== 'string') {
      return {
        result: false,
        message: 'Prompt is required and must be a string',
      }
    }

    const availableTypes = await getAvailableAgentTypes()
    if (!availableTypes.includes(input.subagent_type)) {
      return {
        result: false,
        message: `Agent type '${input.subagent_type}' not found. Available agents: ${availableTypes.join(', ')}`,
        meta: { subagent_type: input.subagent_type, availableTypes },
      }
    }

    if (input.resume) {
      const owner = {
        agentId: input.resume,
        cwd: getCwd(),
        sessionId: getKodeAgentSessionId(),
      }
      const transcript = getAgentTranscript(owner)
      if (!transcript) {
        try {
          const disk = loadKodeAgentSidechainMessagesForResume({
            ...owner,
          })
          if (disk.length === 0) {
            return {
              result: false,
              message: `No transcript found for agent ID: ${input.resume}`,
              meta: { resume: input.resume },
            }
          }
        } catch {
          return {
            result: false,
            message: `No transcript found for agent ID: ${input.resume}`,
            meta: { resume: input.resume },
          }
        }
      }
    }

    return { result: true }
  },
  renderToolUseMessage: renderTaskToolUseMessage,
  renderToolResultMessage: renderTaskToolResultMessage,
  renderResultForAssistant: renderTaskToolResultForAssistant,
  call: callTaskTool,
} satisfies Tool<typeof inputSchema, Output>
