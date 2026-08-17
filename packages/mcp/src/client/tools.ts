import type {
  ImageBlockParam,
  ToolResultBlockParam,
} from '@anthropic-ai/sdk/resources/index.mjs'
import type { RequestOptions } from '@modelcontextprotocol/sdk/shared/protocol.js'
import {
  CallToolResultSchema,
  type ListToolsResult,
  ListToolsResultSchema,
} from '@modelcontextprotocol/sdk/types.js'
import Ajv, { type ValidateFunction } from 'ajv'
import { memoize } from 'lodash-es'
import { z } from 'zod'

import type { Tool } from '@kode/tool-interface/Tool'
import { logMCPError } from '@kode/logging/log/errors'
import { createAssistantMessage } from '#core/utils/messages'

import {
  IDE_MCP_TOOL_ALLOWLIST,
  getMcpToolTimeoutMs,
  sanitizeMcpIdentifierPart,
} from './settings'
import { requestAllPages } from './request'
import { createTimeoutSignal, mergeAbortSignals } from './timeouts'
import type { ConnectedClient } from './types'
import { isRecord } from './utils'
import { getMcpListChangedVersion } from './listChanged'

const MCP_PROGRESS_MESSAGE_MAX_LENGTH = 240
const MCP_PROGRESS_LABEL_MAX_LENGTH = 80
const mcpOutputSchemaValidators = new WeakMap<object, ValidateFunction>()
const mcpOutputSchemaAjv = new Ajv({ allErrors: true, strict: false })

type AnthropicImageMediaType = Extract<
  ImageBlockParam['source'],
  { type: 'base64' }
>['media_type']

type NormalizedMcpProgress = {
  progress?: number
  total?: number
  message?: string
}

function isTextBlock(value: unknown): value is { type: 'text'; text: string } {
  return (
    isRecord(value) && value.type === 'text' && typeof value.text === 'string'
  )
}

function isImageBlock(value: unknown): value is { type: 'image' } {
  return isRecord(value) && value.type === 'image'
}

function renderToolUseMessage(input: unknown): string {
  if (!isRecord(input)) return String(input ?? '')
  return Object.entries(input)
    .map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
    .join(', ')
}

function renderToolResultMessage(output: unknown): string {
  if (Array.isArray(output)) {
    return output
      .map(item => {
        if (!item || typeof item !== 'object') return String(item ?? '')
        if (isImageBlock(item)) return '[Image]'
        if (isTextBlock(item)) return item.text
        return JSON.stringify(item)
      })
      .join('\n')
  }
  if (!output) return '(No content)'
  return typeof output === 'string' ? output : JSON.stringify(output)
}

function renderResultForAssistant(content: unknown): string | unknown[] {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content
  if (!content) return ''
  try {
    return JSON.stringify(content)
  } catch {
    return String(content)
  }
}

function getMcpToolOutputSchema(tool: unknown): Record<string, unknown> | null {
  if (!isRecord(tool)) return null
  return isRecord(tool.outputSchema) ? tool.outputSchema : null
}

function getMcpOutputSchemaValidator(
  outputSchema: Record<string, unknown>,
): ValidateFunction {
  const cached = mcpOutputSchemaValidators.get(outputSchema)
  if (cached) return cached

  const validator = mcpOutputSchemaAjv.compile(outputSchema)
  mcpOutputSchemaValidators.set(outputSchema, validator)
  return validator
}

function formatMcpSchemaValidationErrors(validator: ValidateFunction): string {
  return mcpOutputSchemaAjv.errorsText(validator.errors, { separator: '; ' })
}

function formatProgressNumber(value: unknown): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  return Number.isInteger(value)
    ? String(value)
    : String(Number(value.toFixed(2)))
}

function sanitizeProgressText(
  value: unknown,
  maxLength: number,
): string | undefined {
  if (typeof value !== 'string') return undefined

  const cleaned = value
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/\s+/g, ' ')
    .trim()

  if (!cleaned) return undefined
  if (cleaned.length <= maxLength) return cleaned
  return `${cleaned.slice(0, maxLength)}...`
}

function sanitizeProgressMessage(value: unknown): string | undefined {
  return sanitizeProgressText(value, MCP_PROGRESS_MESSAGE_MAX_LENGTH)
}

function sanitizeProgressLabel(value: unknown, fallback: string): string {
  return sanitizeProgressText(value, MCP_PROGRESS_LABEL_MAX_LENGTH) ?? fallback
}

function normalizeProgressNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function normalizeMcpProgress(progress: unknown): NormalizedMcpProgress {
  const record = isRecord(progress) ? progress : {}
  const normalized: NormalizedMcpProgress = {}
  const current = normalizeProgressNumber(record.progress)
  const total = normalizeProgressNumber(record.total)
  const message = sanitizeProgressMessage(record.message)

  if (current !== undefined) normalized.progress = current
  if (total !== undefined) normalized.total = total
  if (message !== undefined) normalized.message = message

  return normalized
}

function formatMcpToolProgress(args: {
  server: string
  tool: string
  progress: NormalizedMcpProgress
}): string {
  const server = sanitizeProgressLabel(args.server, 'server')
  const tool = sanitizeProgressLabel(args.tool, 'tool')
  const message = args.progress.message ?? ''
  const current = formatProgressNumber(args.progress.progress)
  const total = formatProgressNumber(args.progress.total)
  const ratio = current && total ? `${current}/${total}` : current
  const detail = [message, ratio ? `(${ratio})` : ''].filter(Boolean).join(' ')

  return detail
    ? `MCP ${server}/${tool}: ${detail}`
    : `MCP ${server}/${tool}: progress update`
}

export const getMCPTools = memoize(
  async (): Promise<Tool[]> => {
    const toolsList = await requestAllPages<
      ListToolsResult,
      typeof ListToolsResultSchema
    >({ method: 'tools/list' }, ListToolsResultSchema, 'tools')

    const inputSchema = z.object({}).passthrough()

    return toolsList.flatMap(({ client, results }) => {
      const serverPart = sanitizeMcpIdentifierPart(client.name)
      const tools = results.flatMap(result => result.tools ?? [])

      return tools
        .map((tool): Tool | null => {
          const toolPart = sanitizeMcpIdentifierPart(tool.name)
          const name = `mcp__${serverPart}__${toolPart}`

          if (
            name.startsWith('mcp__ide__') &&
            !IDE_MCP_TOOL_ALLOWLIST.has(name)
          ) {
            return null
          }

          return {
            name,
            isMcp: true,
            cachedDescription: tool.description ?? '',
            async isEnabled() {
              return true
            },
            // MCP annotations are untrusted server hints, not local safety facts.
            isConcurrencySafe() {
              return false
            },
            isReadOnly() {
              return false
            },
            async description() {
              return tool.description ?? ''
            },
            async prompt() {
              return tool.description ?? ''
            },
            inputSchema,
            inputJSONSchema: tool.inputSchema as Tool['inputJSONSchema'],
            needsPermissions() {
              return true
            },
            async validateInput() {
              return { result: true }
            },
            renderToolUseMessage,
            renderToolUseRejectedMessage() {
              return null
            },
            renderToolResultMessage,
            renderResultForAssistant,
            async *call(args: Record<string, unknown>, context) {
              let pendingProgressText: string | null = null
              let lastProgressText: string | null = null
              let progressAvailableResolve: (() => void) | null = null
              let data: ToolResultBlockParam['content'] | undefined
              let callError: unknown
              let callDone = false

              const wakeProgressLoop = () => {
                const resolve = progressAvailableResolve
                if (!resolve) return
                progressAvailableResolve = null
                resolve()
              }

              const callPromise = callMcpTool({
                client,
                tool: tool.name,
                args,
                outputSchema: getMcpToolOutputSchema(tool),
                toolUseId: context.toolUseId,
                signal: context.abortController.signal,
                onProgress: progress => {
                  const normalizedProgress = normalizeMcpProgress(progress)
                  context.options?.onStreamEvent?.({
                    type: 'mcp_progress',
                    server: sanitizeProgressLabel(client.name, 'server'),
                    tool: sanitizeProgressLabel(tool.name, 'tool'),
                    toolUseId: context.toolUseId,
                    progress: normalizedProgress,
                  })

                  const progressText = formatMcpToolProgress({
                    server: client.name,
                    tool: tool.name,
                    progress: normalizedProgress,
                  })
                  if (progressText === lastProgressText) return
                  lastProgressText = progressText
                  pendingProgressText = progressText
                  wakeProgressLoop()
                },
              })
                .then(result => {
                  data = result
                })
                .catch(error => {
                  callError = error
                })
                .finally(() => {
                  callDone = true
                  wakeProgressLoop()
                })

              while (!callDone || pendingProgressText) {
                while (pendingProgressText) {
                  const progressText = pendingProgressText
                  pendingProgressText = null
                  yield {
                    type: 'progress' as const,
                    content: createAssistantMessage(
                      `<tool-progress>${progressText}</tool-progress>`,
                    ),
                  }
                }

                if (callDone) break

                await new Promise<void>(resolve => {
                  progressAvailableResolve = resolve
                })
              }

              await callPromise

              if (callError) throw callError

              yield {
                type: 'result' as const,
                data,
                resultForAssistant: data,
              }
            },
            userFacingName() {
              const title = tool.title?.trim() || tool.name
              return `${client.name} - ${title} (MCP)`
            },
          }
        })
        .filter((tool): tool is Tool => tool !== null)
    })
  },
  () => `tools@${getMcpListChangedVersion('tools')}`,
)

function createMcpToolMeta(
  toolUseId: string | undefined,
): Record<string, string> | undefined {
  const progressToken = toolUseId?.trim()
  if (!progressToken) return undefined

  return {
    progressToken,
    'kode/toolUseId': progressToken,
    'claudecode/toolUseId': progressToken,
  }
}

function convertMcpContentToToolResultBlocks(
  content: Array<Record<string, unknown>>,
): Array<{ type: 'text'; text: string } | ImageBlockParam> {
  const blocks: Array<{ type: 'text'; text: string } | ImageBlockParam> = []

  for (const item of content) {
    switch (item.type) {
      case 'text':
        if (typeof item.text === 'string') {
          blocks.push({ type: 'text', text: item.text })
        }
        break
      case 'image':
        if (
          typeof item.data === 'string' &&
          typeof item.mimeType === 'string'
        ) {
          blocks.push({
            type: 'image',
            source: {
              type: 'base64',
              data: item.data,
              media_type: item.mimeType as AnthropicImageMediaType,
            },
          })
        }
        break
      default: {
        let text = ''
        try {
          text = JSON.stringify(item)
        } catch {
          text = String(item)
        }
        blocks.push({ type: 'text', text })
        break
      }
    }
  }

  return blocks
}

async function callMcpTool({
  client: { client, name },
  tool,
  args,
  outputSchema,
  toolUseId,
  signal,
  onProgress,
}: {
  client: ConnectedClient
  tool: string
  args: Record<string, unknown>
  outputSchema?: Record<string, unknown> | null
  toolUseId?: string
  signal?: AbortSignal
  onProgress?: (progress: unknown) => void
}): Promise<ToolResultBlockParam['content']> {
  const timeoutMs = getMcpToolTimeoutMs()
  const timeoutSignal = timeoutMs ? createTimeoutSignal(timeoutMs) : null
  const merged = mergeAbortSignals([signal, timeoutSignal?.signal])
  const meta = createMcpToolMeta(toolUseId)

  try {
    const options: RequestOptions | undefined =
      merged?.signal || onProgress
        ? {
            ...(merged?.signal ? { signal: merged.signal } : {}),
            onprogress: onProgress,
          }
        : undefined

    const rawResult = await client.callTool(
      {
        name: tool,
        arguments: args,
        ...(meta ? { _meta: meta } : {}),
      },
      CallToolResultSchema,
      options,
    )

    const result = CallToolResultSchema.parse(rawResult)

    if (result.isError) {
      const contentText = result.content.find(item => item.type === 'text')

      const extraError =
        isRecord(rawResult) && typeof rawResult.error === 'string'
          ? rawResult.error
          : isRecord(result) && typeof result.error === 'string'
            ? result.error
            : ''

      const message =
        contentText?.text?.trim() || extraError || `Error calling tool ${tool}`

      logMCPError(name, `Error calling tool ${tool}: ${message}`)
      throw new Error(message)
    }

    const toolResult =
      isRecord(rawResult) && rawResult.toolResult !== undefined
        ? rawResult.toolResult
        : isRecord(result) && result.toolResult !== undefined
          ? result.toolResult
          : undefined
    if (toolResult !== undefined) return String(toolResult)

    let blocks: Array<{ type: 'text'; text: string } | ImageBlockParam> | null =
      null
    const getBlocks = () => {
      blocks ??= convertMcpContentToToolResultBlocks(
        result.content as Array<Record<string, unknown>>,
      )
      return blocks
    }

    if (result.structuredContent !== undefined) {
      if (outputSchema) {
        let validate: ValidateFunction
        try {
          validate = getMcpOutputSchemaValidator(outputSchema)
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          logMCPError(
            name,
            `Unable to validate structured content from tool ${tool}: ${message}`,
          )
          const fallbackBlocks = getBlocks()
          if (fallbackBlocks.length > 0) return fallbackBlocks
          throw error
        }

        if (!validate(result.structuredContent)) {
          const errorText = formatMcpSchemaValidationErrors(validate)
          logMCPError(
            name,
            `Structured content from tool ${tool} failed outputSchema validation: ${errorText}`,
          )
          const fallbackBlocks = getBlocks()
          if (fallbackBlocks.length > 0) return fallbackBlocks
          throw new Error(
            `Structured content from MCP tool ${tool} failed outputSchema validation: ${errorText}`,
          )
        }
      }

      return JSON.stringify(result.structuredContent)
    }

    const fallbackBlocks = getBlocks()
    return fallbackBlocks.length > 0 ? fallbackBlocks : '(No content)'
  } finally {
    merged?.cleanup()
    timeoutSignal?.cleanup()
  }
}
