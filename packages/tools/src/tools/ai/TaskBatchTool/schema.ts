import { z } from 'zod'

export const agentWorkModeSchema = z.enum(['read', 'write'])

export const voiceIntentSchema = z.strictObject({
  summary: z
    .string()
    .min(3)
    .max(1_200)
    .describe(
      'Normalized user goal in plain language; never paste raw ASR text.',
    ),
  explicit_facts: z
    .array(z.string().min(1).max(800))
    .min(1)
    .max(12)
    .describe(
      'Facts, targets, and constraints explicitly stated or confirmed by the user.',
    ),
  assumptions: z
    .array(z.string().min(1).max(500))
    .max(8)
    .default([])
    .describe(
      'Bounded assumptions the parent agent made from conversation context.',
    ),
  unresolved_questions: z
    .array(z.string().min(1).max(500))
    .max(8)
    .default([])
    .describe(
      'Material ambiguities. Must be empty before a voice task batch can run.',
    ),
})

export const agentWorkItemSchema = z.strictObject({
  id: z
    .string()
    .min(1)
    .max(120)
    .describe('Stable task identifier, unique within this batch.'),
  description: z
    .string()
    .min(3)
    .max(120)
    .describe('Short user-visible description of this subtask.'),
  prompt: z
    .string()
    .min(1)
    .max(20_000)
    .describe('Self-contained task prompt for the selected subagent.'),
  subagent_type: z.string().min(1).describe('Configured Kode agent type.'),
  mode: agentWorkModeSchema.describe(
    'read only if the selected agent has an explicitly read-only tool list; otherwise write.',
  ),
  depends_on: z
    .array(z.string().min(1).max(120))
    .max(32)
    .optional()
    .describe(
      'Task ids that must complete successfully before this task starts.',
    ),
  resume_agent_id: z
    .string()
    .min(1)
    .max(160)
    .optional()
    .describe(
      'Previously completed or inactive agent id to continue. The current task prompt and voice intent override older transcript assumptions.',
    ),
  model: z.enum(['sonnet', 'opus', 'haiku']).optional(),
  max_turns: z.number().int().positive().max(100).optional(),
})

export const inputSchema = z.strictObject({
  tasks: z
    .array(agentWorkItemSchema)
    .min(1)
    .max(12)
    .describe('A dependency-aware batch of already clarified agent tasks.'),
  max_parallelism: z
    .number()
    .int()
    .min(1)
    .max(8)
    .optional()
    .describe('Maximum concurrent verified read-only agents; default 4.'),
  voice_intent: voiceIntentSchema
    .optional()
    .describe(
      'Required for a voice-originated turn. It is the sole intent brief supplied to delegated agents.',
    ),
})

export type Input = z.infer<typeof inputSchema>
export type VoiceIntent = z.infer<typeof voiceIntentSchema>

export type Output = {
  status: 'completed' | 'partial'
  voiceIntentSummary?: string
  groups: Array<{
    index: number
    kind: 'parallel-read' | 'serial-write'
    taskIds: string[]
  }>
  tasks: Array<{
    id: string
    status: 'completed' | 'failed' | 'blocked'
    agentId?: string
    resumed?: boolean
    summary?: string
    reason?: string
  }>
}
