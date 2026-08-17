import type {
  ImageBlockParam,
  MessageParam,
} from '@anthropic-ai/sdk/resources/index.mjs'
import { memoize, zipObject } from 'lodash-es'
import type { ListPromptsResult } from '@modelcontextprotocol/sdk/types.js'
import { ListPromptsResultSchema } from '@modelcontextprotocol/sdk/types.js'

import { logMCPError } from '@kode/logging/log/errors'

import { sanitizeMcpIdentifierPart } from './settings'
import { requestAllPages } from './request'
import type { ConnectedClient } from './types'
import { getMcpListChangedVersion } from './listChanged'

type AnthropicImageMediaType = Extract<
  ImageBlockParam['source'],
  { type: 'base64' }
>['media_type']

const ANTHROPIC_IMAGE_MEDIA_TYPES = new Set<AnthropicImageMediaType>([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
])

function normalizeAnthropicImageMediaType(
  mimeType: unknown,
): AnthropicImageMediaType {
  if (mimeType === 'image/jpg') return 'image/jpeg'
  if (
    typeof mimeType === 'string' &&
    ANTHROPIC_IMAGE_MEDIA_TYPES.has(mimeType as AnthropicImageMediaType)
  ) {
    return mimeType as AnthropicImageMediaType
  }
  return 'image/png'
}

export type McpPromptCommand = {
  type: 'prompt'
  name: string
  description: string
  isEnabled: boolean
  isHidden: boolean
  progressMessage: string
  argNames: string[]
  userFacingName(): string
  getPromptForCommand(args: string): Promise<MessageParam[]>
}

export const getMCPCommands = memoize(
  async (): Promise<McpPromptCommand[]> => {
    const results = await requestAllPages<
      ListPromptsResult,
      typeof ListPromptsResultSchema
    >({ method: 'prompts/list' }, ListPromptsResultSchema, 'prompts')

    return results.flatMap(({ client, results }) =>
      results
        .flatMap(result => result.prompts ?? [])
        .map(prompt => {
          const serverPart = sanitizeMcpIdentifierPart(client.name)
          const argNames = (prompt.arguments ?? []).map(arg => arg.name)

          return {
            type: 'prompt',
            name: `mcp__${serverPart}__${prompt.name}`,
            description: prompt.description ?? '',
            isEnabled: true,
            isHidden: false,
            progressMessage: 'running',
            userFacingName() {
              const title = prompt.title?.trim() || prompt.name
              return `${client.name}:${title} (MCP)`
            },
            argNames,
            async getPromptForCommand(args: string) {
              const argsArray = args.split(' ')
              return await runCommand(
                { name: prompt.name, client },
                zipObject(argNames, argsArray),
              )
            },
          }
        }),
    )
  },
  () => `prompts@${getMcpListChangedVersion('prompts')}`,
)

export async function runCommand(
  { name, client }: { name: string; client: ConnectedClient },
  args: Record<string, string>,
): Promise<MessageParam[]> {
  try {
    const result = await client.client.getPrompt({ name, arguments: args })

    return result.messages.map((message): MessageParam => {
      const content = message.content
      switch (content.type) {
        case 'text':
          return {
            role: message.role,
            content: [{ type: 'text', text: content.text }],
          }
        case 'image':
          return {
            role: message.role,
            content: [
              {
                type: 'image',
                source: {
                  type: 'base64',
                  data: content.data,
                  media_type: normalizeAnthropicImageMediaType(
                    content.mimeType,
                  ),
                },
              },
            ],
          }
        default:
          return {
            role: message.role,
            content: [
              {
                type: 'text',
                text: `Unsupported MCP content type ${content.type}`,
              },
            ],
          }
      }
    })
  } catch (error) {
    logMCPError(
      client.name,
      `Error running command '${name}': ${error instanceof Error ? error.message : String(error)}`,
    )
    throw error
  }
}
