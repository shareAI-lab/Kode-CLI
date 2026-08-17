import type {
  ExternalRuntimeToolCall,
  ExternalRuntimeToolResult,
} from '@kode/tool-interface/Tool'

import { createAssistantMessage, createUserMessage } from '../messages/create'
import { runToolUse } from './tool-use'
import type {
  EngineCanUseToolFn,
  ExtendedToolUseContext,
  Message,
} from './types'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringifyToolResultContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map(item => {
        if (
          item &&
          typeof item === 'object' &&
          'text' in item &&
          typeof item.text === 'string'
        ) {
          return item.text
        }
        try {
          return JSON.stringify(item)
        } catch {
          return '[Unserializable tool result]'
        }
      })
      .join('\n')
  }
  try {
    return JSON.stringify(content)
  } catch {
    return String(content)
  }
}

function toExternalToolResult(
  messages: Message[],
  toolUseId: string,
): ExternalRuntimeToolResult {
  for (const message of messages) {
    if (message.type !== 'user' || !Array.isArray(message.message.content)) {
      continue
    }
    for (const block of message.message.content) {
      if (block.type === 'tool_result' && block.tool_use_id === toolUseId) {
        return {
          success: block.is_error !== true,
          content: stringifyToolResultContent(block.content),
        }
      }
    }
  }

  return {
    success: false,
    content: 'Kode tool execution completed without a result.',
  }
}

function createExternalToolUseMessage(call: ExternalRuntimeToolCall) {
  const message = createAssistantMessage('')
  return {
    ...message,
    message: {
      ...message.message,
      content: [
        {
          type: 'tool_use' as const,
          id: call.toolUseId,
          name: call.toolName,
          input: call.input,
        },
      ],
    },
  }
}

/**
 * Runs dynamic external-runtime tool calls through the same engine path as
 * provider-native tool_use blocks. This preserves input validation,
 * permissions, hooks, mutation receipts, and result size limits.
 */
export function createExternalToolCallBridge(args: {
  canUseTool: EngineCanUseToolFn
  toolUseContext: ExtendedToolUseContext
}): (call: ExternalRuntimeToolCall) => Promise<ExternalRuntimeToolResult> {
  const execute = async (
    call: ExternalRuntimeToolCall,
  ): Promise<ExternalRuntimeToolResult> => {
    const tool = args.toolUseContext.options.tools.find(
      candidate => candidate.name === call.toolName,
    )
    if (!tool) {
      return {
        success: false,
        content: `No such Kode tool is available: ${call.toolName}.`,
      }
    }

    if (!isRecord(call.input)) {
      return {
        success: false,
        content:
          'This dynamic tool call did not provide an object-shaped Kode input.',
      }
    }
    const input = call.input

    if (tool.requiresUserInteraction?.(input as never)) {
      return {
        success: false,
        content:
          'The Codex OAuth dynamic tool bridge cannot run interactive Kode tools.',
      }
    }
    const messages: Message[] = [createExternalToolUseMessage(call)]
    try {
      for await (const message of runToolUse(
        {
          type: 'tool_use',
          id: call.toolUseId,
          name: call.toolName,
          input,
        },
        new Set([call.toolUseId]),
        createAssistantMessage(''),
        args.canUseTool,
        args.toolUseContext,
        undefined,
        false,
      )) {
        messages.push(message)
      }
      args.toolUseContext.externalToolMessages ??= []
      args.toolUseContext.externalToolMessages.push(...messages)
      return toExternalToolResult(messages, call.toolUseId)
    } catch (error) {
      messages.push(
        createUserMessage([
          {
            type: 'tool_result',
            content: `Kode tool execution failed: ${
              error instanceof Error ? error.message : String(error)
            }`,
            is_error: true,
            tool_use_id: call.toolUseId,
          },
        ]),
      )
      args.toolUseContext.externalToolMessages ??= []
      args.toolUseContext.externalToolMessages.push(...messages)
      return {
        success: false,
        content: `Kode tool execution failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      }
    }
  }

  // Codex can issue multiple server requests before earlier calls have
  // completed. Serialize them so external calls cannot bypass the engine's
  // ordering and permission/UI assumptions.
  let previousCall = Promise.resolve()
  return call => {
    args.toolUseContext.options.externalToolCallCount =
      (args.toolUseContext.options.externalToolCallCount ?? 0) + 1
    const result = previousCall.then(() => execute(call))
    previousCall = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }
}
