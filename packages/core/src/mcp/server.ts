import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { setCwd } from '#core/utils/state'
import { logError } from '#core/utils/log'
import { createAssistantMessage } from '#core/utils/messages'
import {
  resolveToolDescription,
  type Tool,
  type ToolUseContext,
} from '#core/tooling/Tool'
import { getAllTools } from '#tools'
import { lastX } from '#core/utils/generators'
import { MACRO } from '#core/constants/macros'
import { splitLegacyTool } from '#core/tooling/splitTool'
import {
  getMcpToolDescription,
  getMcpToolInputSchema,
} from '#core/tooling/mcpToolSchema'
import { LEGACY_ENV } from '#core/compat/legacyEnv'
import { loadToolPermissionContextFromDisk } from '#core/permissions/toolPermissionSettings'

const state: {
  readFileTimestamps: Record<string, number>
} = {
  readFileTimestamps: {},
}

const MCP_COMMANDS: unknown[] = []
const MCP_TOOLS: Tool[] = [...getAllTools()]

function getMcpServerName(): string {
  const raw =
    process.env.KODE_MCP_SERVER_NAME ??
    process.env.MCP_SERVER_NAME ??
    process.env[LEGACY_ENV.codeMcpServerName] ??
    ''
  const trimmed = typeof raw === 'string' ? raw.trim() : ''
  return trimmed || 'kode/tengu'
}

export async function startMCPServer(cwd: string): Promise<void> {
  await setCwd(cwd)
  const toolPermissionContext = loadToolPermissionContextFromDisk({
    projectDir: cwd,
  })
  await Promise.all(MCP_TOOLS.map(tool => resolveToolDescription(tool)))
  const server = new Server(
    {
      // Allow legacy clients to override the server identifier while keeping a Kode-first default.
      name: getMcpServerName(),
      version: MACRO.VERSION,
    },
    {
      capabilities: {
        tools: {},
      },
    },
  )

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: await Promise.all(
      MCP_TOOLS.map(async tool => {
        const spec = splitLegacyTool(tool).spec
        return {
          name: spec.name,
          description: getMcpToolDescription(spec),
          inputSchema: getMcpToolInputSchema(spec),
        }
      }),
    ),
  }))

  server.setRequestHandler(CallToolRequestSchema, async request => {
    const { name, arguments: args } = request.params
    const tool = MCP_TOOLS.find(_ => _.name === name)
    if (!tool) {
      return {
        isError: true,
        content: [
          { type: 'text' as const, text: `Error: Tool ${name} not found` },
        ],
      }
    }

    try {
      const toolInput: Record<string, unknown> =
        args && typeof args === 'object'
          ? (args as Record<string, unknown>)
          : {}
      if (!(await tool.isEnabled())) {
        throw new Error(`Tool ${name} is not enabled`)
      }

      const toolUseContext: ToolUseContext = {
        abortController: new AbortController(),
        options: {
          commands: MCP_COMMANDS,
          tools: MCP_TOOLS,
          forkNumber: 0,
          messageLogName: 'mcp',
          maxThinkingTokens: 0,
          shouldAvoidPermissionPrompts: true,
          persistSession: false,
          toolPermissionContext,
        },
        messageId: undefined,
        readFileTimestamps: state.readFileTimestamps,
      }

      const validationResult = await tool.validateInput?.(
        toolInput as never,
        toolUseContext,
      )
      if (validationResult && !validationResult.result) {
        throw new Error(
          `Tool ${name} input is invalid: ${validationResult.message}`,
        )
      }

      // Permission policy lives in core and is tool-aware; MCP is headless, so prompts must fail closed.
      const assistantMessage = createAssistantMessage('')
      const permission = await (
        await import('#core/permissions')
      ).hasPermissionsToUseTool(
        tool,
        toolInput,
        toolUseContext,
        assistantMessage,
      )
      if (permission.result !== true) {
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: `Error: ${permission.message ?? 'Permission denied'}`,
            },
          ],
        }
      }

      const result = tool.call(toolInput as never, toolUseContext)
      const finalResult = await lastX(result)

      if (!finalResult || finalResult.type !== 'result') {
        throw new Error(`Tool ${name} did not return a result`)
      }

      const payload =
        finalResult.resultForAssistant ??
        tool.renderResultForAssistant(finalResult.data)

      const text =
        typeof payload === 'string'
          ? payload
          : Array.isArray(payload)
            ? JSON.stringify(payload)
            : JSON.stringify(finalResult.data)

      return {
        content: [{ type: 'text' as const, text }],
      }
    } catch (error) {
      logError(error)
      return {
        isError: true,
        content: [
          {
            type: 'text' as const,
            text: `Error: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      }
    }
  })

  async function runServer() {
    const transport = new StdioServerTransport()
    await server.connect(transport)
  }

  return await runServer()
}
