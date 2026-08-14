import type { z } from 'zod'
import type { CommandSource } from './commandSource'
import type { PermissionMode, ToolPermissionContext } from './permissions'

export type ToolRenderOutput = unknown
export type AnyZodSchema = z.ZodType<any, any>

/**
 * Declares whether a tool may be exposed in a model-facing read-only profile.
 *
 * `always` tools are read-only for every valid input. `conditional` tools
 * need their concrete input checked at call time (for example, Bash).
 * Absence means the tool is not safe to expose in a read-only profile.
 */
export type ReadModeToolAccess = 'always' | 'conditional'

/**
 * Describes who owns verification for a tool that can affect project files.
 *
 * - `none`: the tool does not write the project workspace.
 * - `direct`: the current agent may have changed the workspace and must verify.
 * - `delegated`: a nested execution owns its own mutation/verification gate.
 */
export type WorkspaceMutationScope = 'none' | 'direct' | 'delegated'

export type WorkspaceMutationReceipt = Readonly<{
  version: 1
  toolUseId: string
  scope: WorkspaceMutationScope
  basis: 'declared' | 'observed' | 'delegated'
}>

export type ToolResultMetadata = Readonly<{
  workspaceMutation?: WorkspaceMutationReceipt
}>

export type ToolKeypress = Readonly<{
  ctrl: boolean
  meta: boolean
  shift: boolean
}>

export type ToolKeypressHandler = (
  input: string,
  key: ToolKeypress,
) => boolean | void

/** A tool invocation requested by an external model runtime. */
export type ExternalRuntimeToolCall = Readonly<{
  toolUseId: string
  toolName: string
  input: Record<string, unknown>
}>

/** A serializable result returned to an external model runtime. */
export type ExternalRuntimeToolResult = Readonly<{
  success: boolean
  content: string
}>

export type AssistantStreamUpdate =
  | {
      type: 'start'
      agentId?: string
      requestId?: string
    }
  | {
      /**
       * Provider-supplied reasoning that the provider also returns as an
       * assistant thinking block. Consumers must not fabricate thinking data.
       */
      type: 'thinking_delta'
      delta: string
      agentId?: string
      requestId?: string
    }
  | {
      type: 'text_delta'
      delta: string
      agentId?: string
      requestId?: string
    }

export type SetToolJSXFn<TRenderable = ToolRenderOutput> = (
  jsx: {
    jsx: TRenderable | null
    shouldHidePromptInput: boolean
    displayMode?: 'inline' | 'fullscreen'
    onKeypress?: ToolKeypressHandler
  } | null,
) => void

export interface ToolUseContext {
  messageId: string | undefined
  toolUseId?: string
  agentId?: string
  requestId?: string
  safeMode?: boolean
  commandSource?: CommandSource
  abortController: AbortController
  readFileTimestamps: { [filePath: string]: number }
  readFileHashes?: { [filePath: string]: string }
  options?: {
    commands?: any[]
    tools?: any[]
    verbose?: boolean
    slowAndCapableModel?: string
    safeMode?: boolean
    permissionMode?: PermissionMode
    toolPermissionContext?: ToolPermissionContext
    lastUserPrompt?: string
    /** True only for a user turn submitted from the reviewed voice UI. */
    voiceTurn?: boolean
    /** Internal capability granted by TaskBatch after validating a voice brief. */
    voiceIntentPrepared?: boolean
    getCustomSystemPromptAdditions?: () => string[]
    openMessageSelector?: () => void
    onStreamEvent?: (event: unknown) => void
    onAssistantStreamUpdate?: (
      event: AssistantStreamUpdate,
    ) => void | Promise<void>
    maxBudgetUsd?: number
    maxTurns?: number
    forkNumber?: number
    messageLogName?: string
    forceForkContext?: boolean
    maxThinkingTokens?: any
    thinkingMode?: 'auto' | 'enabled' | 'disabled'
    model?: string
    commandAllowedTools?: string[]
    isKodingRequest?: boolean
    kodingContext?: string
    isCustomCommand?: boolean
    mcpClients?: any[]
    bashLlmGateQuery?: (args: {
      systemPrompt: string[]
      userInput: string
      signal: AbortSignal
      model?: 'quick' | 'main'
    }) => Promise<string>
    disableSlashCommands?: boolean
    persistSession?: boolean
    /** Marks an engine-managed automation turn for stricter execution policies. */
    automationKind?: 'goal' | 'scheduled_loop'
    shouldAvoidPermissionPrompts?: boolean
    requestToolUsePermission?: (
      request: {
        tool: any
        description: string
        input: { [key: string]: unknown }
        commandPrefix: any | null
        suggestions?: any[]
        riskScore: number | null
      },
      toolUseContext: ToolUseContext,
    ) => Promise<
      | { result: true; type: 'permanent' | 'temporary' }
      | { result: false; rejectionMessage?: string }
    >
    __sandboxProjectDir?: string
    __sandboxHomeDir?: string
    __sandboxPlatform?: NodeJS.Platform
    __sandboxBwrapPath?: string | null
    __sandboxSocatPath?: string | null
    __sandboxApplySeccompPath?: string | null
    __sandboxSeccompBpfPath?: string | null
    askUserQuestionAnswersByToolUseId?: Record<string, Record<string, string>>
    askUserQuestionAnswers?: Record<string, string>
    /**
     * Lets an external model runtime invoke Kode tools through the engine's
     * normal validation, permission, hook, and result-persistence path.
     */
    executeExternalToolCall?: (
      call: ExternalRuntimeToolCall,
    ) => Promise<ExternalRuntimeToolResult>
    /** Number of external-runtime tool calls completed in the current turn. */
    externalToolCallCount?: number
  }
  responseState?: {
    previousResponseId?: string
    conversationId?: string
  }
}

export interface ExtendedToolUseContext extends ToolUseContext {
  setToolJSX: SetToolJSXFn
}

export interface ValidationResult {
  result: boolean
  message?: string
  errorCode?: number
  meta?: any
}

export interface ToolMetadata<
  TInput extends AnyZodSchema = AnyZodSchema,
  TOutput = any,
> {
  name: string
  maxResultSizeChars?: number
  isMcp?: boolean
  /**
   * Marks a built-in execution tool whose result data is produced by the local
   * runtime, rather than by an extension or an MCP server. The engine uses
   * this boundary before creating durable execution receipts.
   */
  isTrustedExecutionTool?: boolean
  description?: string | ((input?: z.infer<TInput>) => Promise<string>)
  inputSchema: TInput
  inputJSONSchema?: Record<string, unknown>
  /**
   * Explicit exposure policy for a model-facing read-only tool profile.
   * This is intentionally separate from `isReadOnly`, which can only be
   * determined after a tool call supplies its input.
   */
  readModeAccess?: ReadModeToolAccess
  /**
   * Optional narrower schema for read-only mode. It is validated before the
   * regular tool schema and prevents mode-incompatible parameters reaching the
   * tool runner.
   */
  readModeInputSchema?: AnyZodSchema
  prompt: (options?: { safeMode?: boolean; tools?: Tool[] }) => Promise<string>
  userFacingName?: (input?: z.infer<TInput>) => string
  cachedDescription?: string
  isEnabled: () => Promise<boolean>
  isReadOnly: (input?: z.infer<TInput>) => boolean
  /**
   * Optional workspace-specific classification. This is intentionally
   * separate from `isReadOnly`: task bookkeeping or sending a message changes
   * application state without changing project files.
   */
  workspaceMutationScope?: (
    input?: z.infer<TInput>,
    output?: TOutput,
  ) => WorkspaceMutationScope
  isConcurrencySafe: (input?: z.infer<TInput>) => boolean
  needsPermissions: (input?: z.infer<TInput>) => boolean
  requiresUserInteraction?: (input?: z.infer<TInput>) => boolean
  validateInput?: (
    input: z.infer<TInput>,
    context?: ToolUseContext,
  ) => Promise<ValidationResult>
  renderResultForAssistant: (output: TOutput) => string | any[]
}

export interface ToolPresenter<
  TInput extends AnyZodSchema = AnyZodSchema,
  TOutput = any,
> {
  name: string
  renderToolUseMessage: (
    input: z.infer<TInput>,
    options: { verbose: boolean },
  ) => ToolRenderOutput
  renderToolUseRejectedMessage?: (...args: any[]) => ToolRenderOutput
  renderToolResultMessage?: (
    output: TOutput,
    options: { verbose: boolean },
  ) => ToolRenderOutput
}

export interface ToolRunner<
  TInput extends AnyZodSchema = AnyZodSchema,
  TOutput = any,
> {
  name: string
  call: (
    input: z.infer<TInput>,
    context: ToolUseContext,
  ) => AsyncGenerator<
    | {
        type: 'result'
        data: TOutput
        resultForAssistant?: string | any[]
        newMessages?: unknown[]
        contextModifier?: {
          modifyContext: (ctx: ToolUseContext) => ToolUseContext
        }
      }
    | {
        type: 'progress'
        content: any
        normalizedMessages?: any[]
        tools?: any[]
      },
    void,
    unknown
  >
}

export interface Tool<TInput extends AnyZodSchema = AnyZodSchema, TOutput = any>
  extends
    ToolMetadata<TInput, TOutput>,
    ToolPresenter<TInput, TOutput>,
    ToolRunner<TInput, TOutput> {}

export async function resolveToolDescription<
  TInput extends AnyZodSchema = AnyZodSchema,
>(tool: Tool<TInput>, input?: z.infer<TInput>): Promise<string> {
  if (input === undefined && tool.cachedDescription) {
    return tool.cachedDescription
  }

  if (typeof tool.description === 'string') {
    if (input === undefined && !tool.cachedDescription) {
      tool.cachedDescription = tool.description
    }
    return tool.description
  }

  if (typeof tool.description === 'function') {
    try {
      const resolved = await tool.description(input)
      const description =
        typeof resolved === 'string' && resolved.trim()
          ? resolved
          : `Tool: ${tool.name}`
      if (input === undefined) {
        tool.cachedDescription = description
      }
      return description
    } catch {
      // Fall through to a safe fallback.
    }
  }

  const fallback = `Tool: ${tool.name}`
  if (input === undefined && !tool.cachedDescription) {
    tool.cachedDescription = fallback
  }
  return fallback
}

export function getToolDescription(tool: Tool): string {
  if (tool.cachedDescription) {
    return tool.cachedDescription
  }

  if (typeof tool.description === 'string') {
    return tool.description
  }

  return `Tool: ${tool.name}`
}
