import { describe, expect, test } from 'bun:test'

import type { AgentConfig } from '@kode/agent'

import {
  __taskBatchForTests,
  isVerifiedReadOnlyAgent,
  TaskBatchTool,
  validateTaskBatchInput,
} from './TaskBatchTool'

const readOnlyAgent: AgentConfig = {
  agentType: 'read-only',
  whenToUse: 'test',
  tools: ['Read', 'Grep(path:src)'],
  systemPrompt: '',
  source: 'built-in',
  location: 'built-in',
}

describe('TaskBatch safety boundaries', () => {
  test('allows only read-only batches through the parent concurrency lane', () => {
    const readTask = {
      id: 'inspect',
      description: 'Inspect files',
      prompt: 'Inspect files.',
      subagent_type: 'Explore',
      mode: 'read' as const,
    }
    const writeInput = {
      tasks: [{ ...readTask, id: 'edit', mode: 'write' as const }],
    }

    expect(TaskBatchTool.isConcurrencySafe({ tasks: [readTask] })).toBe(true)
    expect(TaskBatchTool.isConcurrencySafe(writeInput)).toBe(false)
    expect(TaskBatchTool.workspaceMutationScope(writeInput)).toBe('direct')
    expect(
      TaskBatchTool.workspaceMutationScope(writeInput, {
        status: 'partial',
        groups: [],
        tasks: [
          { id: 'edit', status: 'failed', reason: 'verification failed' },
        ],
      }),
    ).toBe('direct')
  })

  test('recognizes only explicit allowlisted tool sets as safely parallelizable', () => {
    expect(isVerifiedReadOnlyAgent(readOnlyAgent)).toBe(true)
    expect(isVerifiedReadOnlyAgent({ ...readOnlyAgent, tools: '*' })).toBe(
      false,
    )
    expect(
      isVerifiedReadOnlyAgent({ ...readOnlyAgent, tools: ['Read', 'Bash'] }),
    ).toBe(false)
    expect(__taskBatchForTests.toolName('Grep(path:src)')).toBe('Grep')
  })

  test('rejects an invalid dependency graph before loading or launching agents', async () => {
    await expect(
      validateTaskBatchInput({
        tasks: [
          {
            id: 'first',
            description: 'First task',
            prompt: 'First',
            subagent_type: 'missing-agent',
            mode: 'read',
            depends_on: ['second'],
          },
          {
            id: 'second',
            description: 'Second task',
            prompt: 'Second',
            subagent_type: 'missing-agent',
            mode: 'read',
            depends_on: ['first'],
          },
        ],
      }),
    ).resolves.toEqual({
      result: false,
      message: 'Agent work dependencies contain a cycle.',
    })
  })

  test('accepts the built-in Explore agent for a read-only batch', async () => {
    await expect(
      validateTaskBatchInput({
        tasks: [
          {
            id: 'inspect',
            description: 'Inspect architecture',
            prompt: 'Quickly inspect the project architecture.',
            subagent_type: 'Explore',
            mode: 'read',
          },
        ],
      }),
    ).resolves.toEqual({ result: true })
  })

  test('requires a complete intent brief before a voice turn can dispatch', async () => {
    const voiceContext = { options: { voiceTurn: true } } as any
    const baseTask = {
      id: 'inspect',
      description: 'Inspect architecture',
      prompt: 'Inspect the project architecture.',
      subagent_type: 'Explore',
      mode: 'read' as const,
    }
    await expect(
      validateTaskBatchInput({ tasks: [baseTask] }, voiceContext),
    ).resolves.toMatchObject({
      result: false,
      message: expect.stringContaining('requires voice_intent'),
    })
    await expect(
      validateTaskBatchInput(
        {
          tasks: [baseTask],
          voice_intent: {
            summary: 'Inspect the current project architecture.',
            explicit_facts: ['The user asked to inspect the current project.'],
            assumptions: [],
            unresolved_questions: ['Which subsystem should be prioritized?'],
          },
        },
        voiceContext,
      ),
    ).resolves.toMatchObject({
      result: false,
      message: expect.stringContaining('unresolved questions'),
    })
  })

  test('passes a normalized voice brief rather than an unstructured turn to an agent', async () => {
    const received: Array<{ prompt: string; prepared: unknown }> = []
    const context = {
      abortController: new AbortController(),
      readFileTimestamps: {},
      messageId: 'voice-batch-message',
      toolUseId: 'voice-batch',
      options: { voiceTurn: true },
      __testCallTaskTool: async function* (
        input: { prompt: string },
        nestedContext: { options?: { voiceIntentPrepared?: boolean } },
      ) {
        received.push({
          prompt: input.prompt,
          prepared: nestedContext.options?.voiceIntentPrepared,
        })
        yield {
          type: 'result' as const,
          data: {
            status: 'completed' as const,
            agentId: 'explore-agent',
            prompt: input.prompt,
            content: [{ type: 'text' as const, text: 'Done', citations: [] }],
            totalToolUseCount: 0,
            totalDurationMs: 1,
            totalTokens: 1,
            usage: {
              input_tokens: 0,
              output_tokens: 0,
              cache_creation_input_tokens: null,
              cache_read_input_tokens: null,
              server_tool_use: null,
              service_tier: null,
              cache_creation: null,
            },
          },
        }
      },
    }
    for await (const _event of TaskBatchTool.call(
      {
        tasks: [
          {
            id: 'inspect',
            description: 'Inspect architecture',
            prompt: 'List the project modules and their responsibilities.',
            subagent_type: 'Explore',
            mode: 'read',
          },
        ],
        voice_intent: {
          summary: 'Map the current project architecture.',
          explicit_facts: ['The request is limited to the current workspace.'],
          assumptions: ['A read-only report is sufficient.'],
          unresolved_questions: [],
        },
      },
      context,
    )) {
      // The dedicated assertions below inspect the nested prompt and capability.
    }
    expect(received).toEqual([
      expect.objectContaining({
        prepared: true,
        prompt: expect.stringContaining(
          'Organized user goal:\nMap the current project architecture.',
        ),
      }),
    ])
    expect(received[0]?.prompt).toContain(
      'The raw transcript is intentionally not provided.',
    )
  })

  test('resumes an inactive agent with the current voice brief taking precedence', async () => {
    const received: Array<{ prompt: string; resume?: string }> = []
    const context = {
      abortController: new AbortController(),
      readFileTimestamps: {},
      messageId: 'voice-resume-message',
      toolUseId: 'voice-resume-batch',
      options: { voiceTurn: true },
      __testCallTaskTool: async function* (input: {
        prompt: string
        resume?: string
      }) {
        received.push(input)
        yield {
          type: 'result' as const,
          data: {
            status: 'completed' as const,
            agentId: 'prior-explore-agent',
            prompt: input.prompt,
            content: [
              { type: 'text' as const, text: 'Updated report', citations: [] },
            ],
            totalToolUseCount: 0,
            totalDurationMs: 1,
            totalTokens: 1,
            usage: {
              input_tokens: 0,
              output_tokens: 0,
              cache_creation_input_tokens: null,
              cache_read_input_tokens: null,
              server_tool_use: null,
              service_tier: null,
              cache_creation: null,
            },
          },
        }
      },
    }

    const outputEvents = []
    for await (const event of TaskBatchTool.call(
      {
        tasks: [
          {
            id: 'continue-inspection',
            description: 'Continue inspection',
            prompt: 'Recheck the earlier report against the new requirement.',
            subagent_type: 'Explore',
            mode: 'read',
            resume_agent_id: 'prior-explore-agent',
          },
        ],
        voice_intent: {
          summary:
            'Continue the previous architecture inspection with the new requirement.',
          explicit_facts: [
            'The user explicitly asked to continue the previous agent.',
            'The newly stated requirement overrides the earlier direction.',
          ],
          assumptions: [],
          unresolved_questions: [],
        },
      },
      context,
    )) {
      outputEvents.push(event)
    }

    expect(received).toEqual([
      expect.objectContaining({
        resume: 'prior-explore-agent',
        prompt: expect.stringContaining('Continuation rule:'),
      }),
    ])
    expect(received[0]?.prompt).toContain('supersede any older assumptions')
    expect(
      TaskBatchTool.renderToolUseMessage({
        tasks: [
          {
            id: 'continue-inspection',
            description: 'Continue inspection',
            prompt: 'Recheck the earlier report against the new requirement.',
            subagent_type: 'Explore',
            mode: 'read',
            resume_agent_id: 'prior-explore-agent',
          },
        ],
      }),
    ).toContain('(1 continuation)')
    expect(outputEvents.at(-1)?.data).toMatchObject({
      status: 'completed',
      tasks: [
        {
          id: 'continue-inspection',
          resumed: true,
          agentId: 'prior-explore-agent',
        },
      ],
    })
  })

  test('runs independent reads together and waits before a dependent write', async () => {
    const events: string[] = []
    const context = {
      abortController: new AbortController(),
      readFileTimestamps: {},
      messageId: 'batch-test-message',
      toolUseId: 'batch-test',
      __testCallTaskTool: async function* (input: {
        description: string
        prompt: string
      }) {
        events.push(`start:${input.description}`)
        await new Promise(resolve => setTimeout(resolve, 5))
        events.push(`end:${input.description}`)
        yield {
          type: 'result' as const,
          data: {
            status: 'completed' as const,
            agentId: input.description,
            prompt: input.prompt,
            content: [
              {
                type: 'text' as const,
                text: `${input.description} done`,
                citations: [],
              },
            ],
            totalToolUseCount: 0,
            totalDurationMs: 1,
            totalTokens: 1,
            usage: {
              input_tokens: 0,
              output_tokens: 0,
              cache_creation_input_tokens: null,
              cache_read_input_tokens: null,
              server_tool_use: null,
              service_tier: null,
              cache_creation: null,
            },
          },
        }
      },
    }
    const outputEvents = []
    for await (const event of TaskBatchTool.call(
      {
        tasks: [
          {
            id: 'read-a',
            description: 'read-a',
            prompt: 'A',
            subagent_type: 'Explore',
            mode: 'read',
          },
          {
            id: 'read-b',
            description: 'read-b',
            prompt: 'B',
            subagent_type: 'Explore',
            mode: 'read',
          },
          {
            id: 'write-c',
            description: 'write-c',
            prompt: 'C',
            subagent_type: 'general-purpose',
            mode: 'write',
            depends_on: ['read-a', 'read-b'],
          },
        ],
        max_parallelism: 2,
      },
      context,
    )) {
      outputEvents.push(event)
    }
    expect(events.slice(0, 2)).toEqual(['start:read-a', 'start:read-b'])
    expect(events.indexOf('start:write-c')).toBeGreaterThan(
      events.indexOf('end:read-a'),
    )
    expect(events.indexOf('start:write-c')).toBeGreaterThan(
      events.indexOf('end:read-b'),
    )
    expect(outputEvents.map(event => event.type)).toEqual([
      'progress',
      'progress',
      'progress',
      'progress',
      'progress',
      'result',
    ])
    expect(outputEvents.at(-1)?.data).toMatchObject({ status: 'completed' })
  })

  test('preserves a delegated child failure reason in batch output', async () => {
    const context = {
      abortController: new AbortController(),
      readFileTimestamps: {},
      messageId: 'batch-failure-message',
      toolUseId: 'batch-failure',
      __testCallTaskTool: async function* (input: { prompt: string }) {
        yield {
          type: 'result' as const,
          data: {
            status: 'failed' as const,
            agentId: 'failed-agent',
            prompt: input.prompt,
            content: [],
            error: 'Child verification failed on the auth boundary.',
            totalToolUseCount: 0,
            totalDurationMs: 1,
            totalTokens: 0,
            usage: {
              input_tokens: 0,
              output_tokens: 0,
              cache_creation_input_tokens: null,
              cache_read_input_tokens: null,
              server_tool_use: null,
              service_tier: null,
              cache_creation: null,
            },
          },
        }
      },
    }
    const events = []
    for await (const event of TaskBatchTool.call(
      {
        tasks: [
          {
            id: 'inspect-auth',
            description: 'Inspect auth failure',
            prompt: 'Inspect auth.',
            subagent_type: 'Explore',
            mode: 'read',
          },
        ],
      },
      context,
    )) {
      events.push(event)
    }

    expect(events.at(-1)?.data).toMatchObject({
      status: 'partial',
      tasks: [
        {
          id: 'inspect-auth',
          status: 'failed',
          reason: 'Child verification failed on the auth boundary.',
        },
      ],
    })
  })
})
