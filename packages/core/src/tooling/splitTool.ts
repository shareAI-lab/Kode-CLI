import type {
  Tool,
  AnyZodSchema,
  ToolMetadata,
  ToolPresenter as CoreToolPresenter,
  ToolRunner as CoreToolRunner,
} from './Tool'

export type ToolSpec<
  TInput extends AnyZodSchema = AnyZodSchema,
  TOutput = any,
> = ToolMetadata<TInput, TOutput>

export type SplitTool<
  TInput extends AnyZodSchema = AnyZodSchema,
  TOutput = any,
> = {
  spec: ToolSpec<TInput, TOutput>
  runner: CoreToolRunner<TInput, TOutput>
  presenter: CoreToolPresenter<TInput, TOutput>
}

export function splitLegacyTool<
  TInput extends AnyZodSchema = AnyZodSchema,
  TOutput = any,
>(tool: Tool<TInput, TOutput>): SplitTool<TInput, TOutput> {
  const spec: ToolSpec<TInput, TOutput> = {
    name: tool.name,
    // Tool descriptions may be async functions; adapters/spec consumers must not receive a Promise-returning function here.
    // Prefer the cached (resolved) string description when available.
    description:
      tool.cachedDescription ??
      (typeof tool.description === 'string' ? tool.description : undefined),
    inputSchema: tool.inputSchema,
    inputJSONSchema: tool.inputJSONSchema,
    readModeAccess: tool.readModeAccess,
    readModeInputSchema: tool.readModeInputSchema,
    prompt: tool.prompt,
    userFacingName: tool.userFacingName,
    cachedDescription: tool.cachedDescription,
    isEnabled: tool.isEnabled,
    isReadOnly: tool.isReadOnly,
    isConcurrencySafe: tool.isConcurrencySafe,
    needsPermissions: tool.needsPermissions,
    requiresUserInteraction: tool.requiresUserInteraction,
    validateInput: tool.validateInput,
    renderResultForAssistant: tool.renderResultForAssistant,
  }

  const runner: CoreToolRunner<TInput, TOutput> = {
    name: tool.name,
    call: (input, context) => tool.call(input, context),
  }

  const presenter: CoreToolPresenter<TInput, TOutput> = {
    name: tool.name,
    renderToolUseMessage: (input, options) =>
      tool.renderToolUseMessage(input, options),
    renderToolUseRejectedMessage: tool.renderToolUseRejectedMessage
      ? (...args) => tool.renderToolUseRejectedMessage!(...args)
      : undefined,
    renderToolResultMessage: tool.renderToolResultMessage
      ? (output, options) => tool.renderToolResultMessage!(output, options)
      : undefined,
  }

  return { spec, runner, presenter }
}
