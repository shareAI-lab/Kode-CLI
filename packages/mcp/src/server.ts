import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  CallToolRequestSchema,
  type ContentBlock,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { readFile, readdir, stat } from 'node:fs/promises'
import { extname, join, relative, resolve, sep } from 'node:path'
import { setCwd } from '#runtime/cwd'
import { logError } from '@kode/logging/log/errors'
import { createAssistantMessage } from '#core/utils/messages'
import {
  resolveToolDescription,
  type Tool,
  type ToolUseContext,
} from '@kode/tool-interface/Tool'
import { MACRO } from '#core/constants/macros'
import { splitLegacyTool } from '#core/tooling/splitTool'
import {
  getMcpToolDescription,
  getMcpToolInputSchema,
} from '#core/tooling/mcpToolSchema'
import { LEGACY_ENV } from '#config/compat/legacyEnv'

const state: {
  readFileTimestamps: Record<string, number>
} = {
  readFileTimestamps: {},
}

const MCP_COMMANDS: unknown[] = []
const MCP_SERVER_PROGRESS_MESSAGE_MAX_LENGTH = 240
const MCP_SERVER_PROGRESS_MIN_INTERVAL_MS = 250

type McpProgressToken = string | number
type McpProgressNotification = {
  method: 'notifications/progress'
  params: {
    progressToken: McpProgressToken
    progress: number
    message?: string
  }
}

type McpProgressExtra = {
  _meta?: { progressToken?: unknown }
  sendNotification(notification: McpProgressNotification): Promise<void>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function stringifyForMcpText(value: unknown): string {
  if (typeof value === 'string') return value
  if (value === undefined) return ''
  try {
    const json = JSON.stringify(value)
    return json === undefined ? String(value) : json
  } catch {
    return String(value)
  }
}

function optionalRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function addCommonMcpContentFields<T extends ContentBlock>(
  block: T,
  source: Record<string, unknown>,
): T {
  const annotations = optionalRecord(source.annotations)
  const meta = optionalRecord(source._meta)
  const writable = block as T & Record<string, unknown>
  if (annotations) writable.annotations = annotations
  if (meta) writable._meta = meta
  return block
}

function convertToolPayloadItemToMcpContent(
  item: unknown,
): ContentBlock | null {
  if (typeof item === 'string') return { type: 'text', text: item }
  if (!isRecord(item)) return { type: 'text', text: stringifyForMcpText(item) }

  if (item.type === 'text' && typeof item.text === 'string') {
    return addCommonMcpContentFields({ type: 'text', text: item.text }, item)
  }

  const source = isRecord(item.source) ? item.source : null
  if (
    item.type === 'image' &&
    source?.type === 'base64' &&
    typeof source.data === 'string'
  ) {
    return addCommonMcpContentFields(
      {
        type: 'image',
        data: source.data,
        mimeType:
          typeof source.media_type === 'string'
            ? source.media_type
            : 'image/png',
      },
      item,
    )
  }

  if (
    item.type === 'image' &&
    typeof item.data === 'string' &&
    typeof item.mimeType === 'string'
  ) {
    return addCommonMcpContentFields(
      { type: 'image', data: item.data, mimeType: item.mimeType },
      item,
    )
  }

  if (
    item.type === 'audio' &&
    typeof item.data === 'string' &&
    typeof item.mimeType === 'string'
  ) {
    return addCommonMcpContentFields(
      { type: 'audio', data: item.data, mimeType: item.mimeType },
      item,
    )
  }

  if (item.type === 'resource_link' && typeof item.uri === 'string') {
    return addCommonMcpContentFields(
      {
        type: 'resource_link',
        uri: item.uri,
        title: optionalString(item.title),
        name: optionalString(item.name) ?? item.uri,
        description: optionalString(item.description),
        mimeType: optionalString(item.mimeType),
      },
      item,
    )
  }

  const resource = isRecord(item.resource) ? item.resource : null
  if (
    item.type === 'resource' &&
    resource &&
    typeof resource.uri === 'string'
  ) {
    const mimeType = optionalString(resource.mimeType)
    const commonResource = {
      uri: resource.uri,
      ...(mimeType ? { mimeType } : {}),
    }

    if (typeof resource.text === 'string') {
      return addCommonMcpContentFields(
        {
          type: 'resource',
          resource: {
            ...commonResource,
            text: resource.text,
          },
        },
        item,
      )
    }

    if (typeof resource.blob === 'string') {
      return addCommonMcpContentFields(
        {
          type: 'resource',
          resource: {
            ...commonResource,
            blob: resource.blob,
          },
        },
        item,
      )
    }
  }

  return { type: 'text', text: stringifyForMcpText(item) }
}

function convertToolPayloadToMcpContent(args: {
  payload: unknown
  fallback: unknown
}): ContentBlock[] {
  const { payload, fallback } = args

  if (typeof payload === 'string') return [{ type: 'text', text: payload }]

  if (Array.isArray(payload)) {
    const blocks = payload
      .map(convertToolPayloadItemToMcpContent)
      .filter((block): block is ContentBlock => block !== null)

    return blocks.length > 0
      ? blocks
      : [{ type: 'text', text: stringifyForMcpText(payload) }]
  }

  return [{ type: 'text', text: stringifyForMcpText(fallback) }]
}

export const __convertToolPayloadToMcpContentForTests =
  convertToolPayloadToMcpContent

function getMcpProgressToken(extra: McpProgressExtra): McpProgressToken | null {
  const token = extra._meta?.progressToken
  return typeof token === 'string' || typeof token === 'number' ? token : null
}

function sanitizeMcpProgressMessage(value: string): string | undefined {
  const cleaned = value
    .replace(/<\/?tool-progress>/g, '')
    .replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/\s+/g, ' ')
    .trim()

  if (!cleaned) return undefined
  if (cleaned.length <= MCP_SERVER_PROGRESS_MESSAGE_MAX_LENGTH) return cleaned
  return `${cleaned.slice(0, MCP_SERVER_PROGRESS_MESSAGE_MAX_LENGTH)}...`
}

function extractText(value: unknown, depth = 0): string | null {
  if (depth > 4) return null
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    const text = value
      .map(item => extractText(item, depth + 1))
      .filter((item): item is string => Boolean(item))
      .join('\n')
    return text || null
  }
  if (!isRecord(value)) return null

  if (typeof value.text === 'string') return value.text

  for (const key of ['content', 'message', 'event']) {
    const nested = extractText(value[key], depth + 1)
    if (nested) return nested
  }

  return null
}

function formatMcpProgressMessage(update: unknown, toolName: string): string {
  const record = isRecord(update) ? update : null
  const candidate = record?.content ?? record?.event ?? update
  const text =
    extractText(candidate) ??
    (() => {
      try {
        return JSON.stringify(candidate)
      } catch {
        return String(candidate)
      }
    })()

  return sanitizeMcpProgressMessage(text) ?? `Tool ${toolName} is running`
}

function createMcpProgressReporter(
  extra: McpProgressExtra,
  toolName: string,
): (update: unknown) => Promise<void> {
  const progressToken = getMcpProgressToken(extra)
  if (progressToken === null) return async () => {}

  let progress = 0
  let lastSentAt = 0

  return async update => {
    const now = Date.now()
    if (
      lastSentAt > 0 &&
      now - lastSentAt < MCP_SERVER_PROGRESS_MIN_INTERVAL_MS
    ) {
      return
    }

    progress += 1
    lastSentAt = now

    try {
      await extra.sendNotification({
        method: 'notifications/progress',
        params: {
          progressToken,
          progress,
          message: formatMcpProgressMessage(update, toolName),
        },
      })
    } catch (error) {
      logError(error)
    }
  }
}

export const __createMcpProgressReporterForTests = createMcpProgressReporter

function createLinkedMcpAbortController(signal: AbortSignal): {
  abortController: AbortController
  cleanup(): void
} {
  const abortController = new AbortController()
  const abort = () => {
    abortController.abort(signal.reason ?? new Error('MCP request cancelled'))
  }

  if (signal.aborted) {
    abort()
  } else {
    signal.addEventListener('abort', abort, { once: true })
  }

  return {
    abortController,
    cleanup() {
      signal.removeEventListener('abort', abort)
    },
  }
}

export const __createLinkedMcpAbortControllerForTests =
  createLinkedMcpAbortController

function getMcpServerName(): string {
  const raw =
    process.env.KODE_MCP_SERVER_NAME ??
    process.env.MCP_SERVER_NAME ??
    process.env[LEGACY_ENV.codeMcpServerName] ??
    ''
  const trimmed = typeof raw === 'string' ? raw.trim() : ''
  return trimmed || 'kode/tengu'
}

// ---------------------------------------------------------------------------
// Resources support (resources/list + resources/read)
// ---------------------------------------------------------------------------

const MCP_RESOURCES_MAX_FILES = 500
const MCP_RESOURCES_MAX_FILE_SIZE = 1024 * 1024 // 1 MiB per file
const MCP_RESOURCES_SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'coverage',
  '.next',
  '.cache',
  'vendor',
])

const TEXT_MIME_BY_EXT: Record<string, string> = {
  '.ts': 'text/x-typescript',
  '.tsx': 'text/x-typescript',
  '.js': 'text/javascript',
  '.jsx': 'text/javascript',
  '.json': 'application/json',
  '.md': 'text/markdown',
  '.html': 'text/html',
  '.css': 'text/css',
  '.py': 'text/x-python',
  '.go': 'text/x-go',
  '.rs': 'text/x-rust',
  '.java': 'text/x-java',
  '.yaml': 'text/yaml',
  '.yml': 'text/yaml',
  '.toml': 'text/toml',
  '.txt': 'text/plain',
  '.sh': 'text/x-shellscript',
}

function guessMimeType(filePath: string): string {
  return TEXT_MIME_BY_EXT[extname(filePath).toLowerCase()] ?? 'text/plain'
}

function fileUriForPath(rootDir: string, filePath: string): string {
  const rel = relative(rootDir, filePath).split(sep).join('/')
  return `file:///${rel}`
}

/**
 * Resolve a file:// resource URI back to an absolute path, enforcing that
 * the result stays inside rootDir (path traversal protection).
 */
function resolveResourceUri(rootDir: string, uri: string): string | null {
  if (!uri.startsWith('file:///')) return null
  const rel = decodeURIComponent(uri.slice('file:///'.length))
  const abs = resolve(rootDir, rel)
  const normalizedRoot = resolve(rootDir)
  if (abs !== normalizedRoot && !abs.startsWith(normalizedRoot + sep)) {
    return null
  }
  return abs
}

async function listProjectFiles(
  rootDir: string,
  maxFiles: number,
): Promise<string[]> {
  const out: string[] = []
  const queue: string[] = [rootDir]

  while (queue.length > 0 && out.length < maxFiles) {
    const dir = queue.shift()!
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (out.length >= maxFiles) break
      if (entry.name.startsWith('.') && entry.name !== '.env.example') continue
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (!MCP_RESOURCES_SKIP_DIRS.has(entry.name)) queue.push(full)
      } else if (entry.isFile()) {
        out.push(full)
      }
    }
  }

  return out
}

export async function startMCPServer(
  cwd: string,
  tools: Iterable<Tool>,
): Promise<void> {
  await setCwd(cwd)
  const MCP_TOOLS: Tool[] = [...tools]
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
        resources: {},
      },
    },
  )

  // -------------------------------------------------------------------------
  // resources/list — expose project files (bounded, skips vendored dirs)
  // -------------------------------------------------------------------------
  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    const files = await listProjectFiles(cwd, MCP_RESOURCES_MAX_FILES)
    return {
      resources: files.map(filePath => ({
        uri: fileUriForPath(cwd, filePath),
        name: relative(cwd, filePath),
        mimeType: guessMimeType(filePath),
      })),
    }
  })

  // -------------------------------------------------------------------------
  // resources/read — read a single project file (path traversal protected)
  // -------------------------------------------------------------------------
  server.setRequestHandler(ReadResourceRequestSchema, async request => {
    const uri = request.params.uri
    const filePath = resolveResourceUri(cwd, uri)
    if (!filePath) {
      throw new Error(`Invalid or out-of-project resource URI: ${uri}`)
    }

    const fileStat = await stat(filePath).catch((): null => null)
    if (!fileStat?.isFile()) {
      throw new Error(`Resource not found: ${uri}`)
    }
    if (fileStat.size > MCP_RESOURCES_MAX_FILE_SIZE) {
      throw new Error(
        `Resource too large (${fileStat.size} bytes > ${MCP_RESOURCES_MAX_FILE_SIZE} limit): ${uri}`,
      )
    }

    const text = await readFile(filePath, 'utf8')
    return {
      contents: [
        {
          uri,
          mimeType: guessMimeType(filePath),
          text,
        },
      ],
    }
  })

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

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
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

    const linkedAbort = createLinkedMcpAbortController(extra.signal)

    try {
      const toolInput: Record<string, unknown> =
        args && typeof args === 'object'
          ? (args as Record<string, unknown>)
          : {}
      if (linkedAbort.abortController.signal.aborted) {
        throw new Error('Tool request cancelled')
      }
      if (!(await tool.isEnabled())) {
        throw new Error(`Tool ${name} is not enabled`)
      }

      const toolUseContext: ToolUseContext = {
        abortController: linkedAbort.abortController,
        options: {
          commands: MCP_COMMANDS,
          tools: MCP_TOOLS,
          forkNumber: 0,
          messageLogName: 'mcp',
          maxThinkingTokens: 0,
          shouldAvoidPermissionPrompts: true,
          persistSession: false,
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
      const reportProgress = createMcpProgressReporter(extra, name)
      let finalResult:
        Awaited<ReturnType<typeof result.next>>['value'] | undefined

      for await (const update of result) {
        if (isRecord(update) && update.type === 'progress') {
          await reportProgress(update)
        }
        finalResult = update
      }

      if (!finalResult || finalResult.type !== 'result') {
        throw new Error(`Tool ${name} did not return a result`)
      }

      const payload =
        finalResult.resultForAssistant ??
        tool.renderResultForAssistant(finalResult.data)

      return {
        content: convertToolPayloadToMcpContent({
          payload,
          fallback: finalResult.data,
        }),
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
    } finally {
      linkedAbort.cleanup()
    }
  })

  async function runServer() {
    const transport = new StdioServerTransport()
    await server.connect(transport)
  }

  return await runServer()
}
