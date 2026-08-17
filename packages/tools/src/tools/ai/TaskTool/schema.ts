import type { TextBlock } from '@anthropic-ai/sdk/resources/index.mjs'
import { z } from 'zod'

export const inputSchema = z.object({
  description: z
    .string()
    .describe('A short (3-5 word) description of the task'),
  prompt: z.string().describe('The task for the agent to perform'),
  subagent_type: z
    .string()
    .describe('The type of specialized agent to use for this task'),
  model: z
    .enum(['sonnet', 'opus', 'haiku'])
    .optional()
    .describe(
      'Optional model to use for this agent. If not specified, inherits from parent. Prefer haiku for quick, straightforward tasks to minimize cost and latency.',
    ),
  resume: z
    .string()
    .optional()
    .describe(
      'Optional agent ID to resume from. If provided, the agent will continue from the previous execution transcript.',
    ),
  run_in_background: z
    .boolean()
    .optional()
    .describe(
      'Set to true to run this agent in the background. Use TaskOutput to read the output later.',
    ),
  max_turns: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      'Maximum number of agentic turns (API round-trips) before stopping. Used internally for warmup.',
    ),
})

export type Input = z.infer<typeof inputSchema>
export type TaskModel = NonNullable<Input['model']>

export type TaskUsage = {
  input_tokens: number
  output_tokens: number
  cache_creation_input_tokens: number | null
  cache_read_input_tokens: number | null
  server_tool_use: {
    web_search_requests: number
    web_fetch_requests: number
  } | null
  service_tier: 'standard' | 'priority' | 'batch' | null
  cache_creation: {
    ephemeral_1h_input_tokens: number
    ephemeral_5m_input_tokens: number
  } | null
}

export type Output =
  | {
      status: 'async_launched'
      agentId: string
      description: string
      prompt: string
    }
  | {
      status: 'completed'
      agentId: string
      prompt: string
      content: TextBlock[]
      totalToolUseCount: number
      totalDurationMs: number
      totalTokens: number
      usage: TaskUsage
    }
  | {
      status: 'failed'
      agentId: string
      prompt: string
      content: TextBlock[]
      error: string
      totalToolUseCount: number
      totalDurationMs: number
      totalTokens: number
      usage: TaskUsage
    }
