import OpenAI from 'openai'

export function isGPT5Model(modelName: string): boolean {
  return modelName.startsWith('gpt-5')
}

export function isMiMoModel(modelName: string): boolean {
  return modelName.toLowerCase().startsWith('mimo-')
}

/**
 * MiMo defaults to on-device/server thinking that counts against
 * max_completion_tokens. Enable only when the caller explicitly asks for
 * medium/high effort and is not in a tool-capable turn (tool_calls get
 * incomplete under thinking).
 */
export function shouldDisableMiMoThinking(args: {
  toolSchemasLength: number
  reasoningEffort?: string | null
}): boolean {
  if (args.toolSchemasLength > 0) return true
  const effort = args.reasoningEffort
  return effort !== 'medium' && effort !== 'high'
}

export function buildOpenAIChatCompletionCreateParams(args: {
  model: string
  maxTokens: number
  messages: OpenAI.ChatCompletionMessageParam[]
  temperature: number
  stream: boolean
  toolSchemas: OpenAI.ChatCompletionTool[]
  stopSequences?: string[]
  reasoningEffort?: any
}): OpenAI.ChatCompletionCreateParams {
  const isGPT5 = isGPT5Model(args.model)
  const isMiMo = isMiMoModel(args.model)

  const opts: OpenAI.ChatCompletionCreateParams = {
    model: args.model,
    ...(isGPT5 || isMiMo
      ? { max_completion_tokens: args.maxTokens }
      : { max_tokens: args.maxTokens }),
    messages: args.messages,
    temperature: args.temperature,
  }
  if (args.stopSequences && args.stopSequences.length > 0) {
    opts.stop = args.stopSequences
  }
  if (args.stream) {
    ;(opts as OpenAI.ChatCompletionCreateParams).stream = true
    opts.stream_options = {
      include_usage: true,
    }
  }

  if (args.toolSchemas.length > 0) {
    opts.tools = args.toolSchemas
    opts.tool_choice = 'auto'
  }

  if (
    isMiMo &&
    shouldDisableMiMoThinking({
      toolSchemasLength: args.toolSchemas.length,
      reasoningEffort: args.reasoningEffort,
    })
  ) {
    ;(
      opts as OpenAI.ChatCompletionCreateParams & {
        thinking?: { type: 'disabled' }
      }
    ).thinking = { type: 'disabled' }
  }

  if (args.reasoningEffort) {
    opts.reasoning_effort = args.reasoningEffort
  }

  return opts
}
