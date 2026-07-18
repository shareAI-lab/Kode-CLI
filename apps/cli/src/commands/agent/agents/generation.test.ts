import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import {
  __parseGeneratedAgentResponseForTests,
  __setAgentGenerationQueryForTests,
  generateAgentWithModel,
  generateAgentFileContent,
  validateAgentConfig,
  validateAgentType,
} from './generation'

type AgentGenerationQuery = Exclude<
  Parameters<typeof __setAgentGenerationQueryForTests>[0],
  null
>

let queryModelImpl: AgentGenerationQuery

const generatedAgent = {
  identifier: 'code-reviewer',
  whenToUse: 'Use this agent when reviewing recently written code changes.',
  systemPrompt:
    'You are a senior code reviewer. Focus on correctness, regressions, and missing validation.',
}

describe('agents/generation', () => {
  beforeEach(() => {
    queryModelImpl = (async () =>
      ({
        message: {
          content: [
            {
              type: 'text',
              text: JSON.stringify(generatedAgent),
            },
          ],
        },
      }) as Awaited<ReturnType<AgentGenerationQuery>>) as AgentGenerationQuery
    __setAgentGenerationQueryForTests(queryModelImpl)
  })

  afterEach(() => {
    __setAgentGenerationQueryForTests(null)
  })

  test('parseGeneratedAgentResponse accepts raw JSON', () => {
    expect(
      __parseGeneratedAgentResponseForTests(JSON.stringify(generatedAgent)),
    ).toEqual(generatedAgent)
  })

  test('parseGeneratedAgentResponse accepts fenced JSON', () => {
    const parsed = __parseGeneratedAgentResponseForTests(
      `Here is the draft:\n\n\`\`\`json\n${JSON.stringify(generatedAgent, null, 2)}\n\`\`\``,
    )

    expect(parsed).toEqual(generatedAgent)
  })

  test('parseGeneratedAgentResponse extracts the first balanced JSON object', () => {
    const parsed = __parseGeneratedAgentResponseForTests(
      `Draft follows:\n${JSON.stringify({
        ...generatedAgent,
        systemPrompt:
          'You are a reviewer. Keep examples with literal braces like {path} intact.',
      })}\nDone.`,
    )

    expect(parsed.identifier).toBe('code-reviewer')
    expect(parsed.systemPrompt).toContain('{path}')
  })

  test('parseGeneratedAgentResponse skips prose braces before the JSON object', () => {
    const parsed = __parseGeneratedAgentResponseForTests(
      `Use placeholders like {path} in examples.\n${JSON.stringify(generatedAgent)}`,
    )

    expect(parsed).toEqual(generatedAgent)
  })

  test('parseGeneratedAgentResponse hides low-level JSON parse errors', () => {
    expect(() =>
      __parseGeneratedAgentResponseForTests(
        '{"identifier":"broken-agent","whenToUse":"Use this agent when reviewing code."',
      ),
    ).toThrow(
      'Failed to generate agent draft: model returned invalid JSON. Please try again with a more specific description.',
    )
  })

  test('generateAgentFileContent escapes and quotes description', () => {
    const description = `Line 1: "quoted" and backslash \\\nLine 2`
    const content = generateAgentFileContent(
      'demo-agent',
      description,
      '*',
      'System prompt body',
    )

    const escaped = description
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"')
      .replace(/\n/g, '\\\\n')

    expect(content).toContain('name: demo-agent')
    expect(content).toContain(`description: "${escaped}"`)
    expect(content).not.toContain('\ntools:')
  })

  test('generateAgentFileContent writes optional tools/model/color', () => {
    const content = generateAgentFileContent(
      'demo-agent',
      'Use this agent when...',
      ['Read', 'Bash'],
      'System prompt body',
      'sonnet',
      'magenta',
    )

    expect(content).toContain('\ntools: Read, Bash')
    expect(content).toContain('\nmodel: sonnet')
    expect(content).toContain('\ncolor: magenta')
  })

  test('validateAgentType matches expected regex + length', () => {
    expect(validateAgentType('a-b').isValid).toBe(true)
    expect(validateAgentType('a-').isValid).toBe(false)
    expect(validateAgentType('-a').isValid).toBe(false)
    expect(validateAgentType('ab').isValid).toBe(false)
  })

  test('validateAgentConfig matches expected warning/error thresholds', () => {
    const tooShortSystemPrompt = validateAgentConfig({
      agentType: 'a-b',
      whenToUse: 'Use this agent when you need help.',
      systemPrompt: 'too short',
      selectedTools: undefined,
    })
    expect(tooShortSystemPrompt.isValid).toBe(false)
    expect(tooShortSystemPrompt.errors).toContain(
      'System prompt is too short (minimum 20 characters)',
    )
    expect(tooShortSystemPrompt.warnings).toContain(
      'Agent has access to all tools',
    )

    const longDescription = validateAgentConfig({
      agentType: 'a-b',
      whenToUse: `Use this agent when...${'x'.repeat(6000)}`,
      systemPrompt: 'This system prompt is long enough to pass validation.',
      selectedTools: [],
    })
    expect(longDescription.isValid).toBe(true)
    expect(longDescription.warnings).toContain(
      'Description is very long (over 5000 characters)',
    )
    expect(longDescription.warnings).toContain(
      'No tools selected - agent will have very limited capabilities',
    )
  })

  test('surfaces model API errors without reporting invalid JSON', async () => {
    queryModelImpl = (async () =>
      ({
        isApiErrorMessage: true,
        message: {
          content: [
            {
              type: 'text',
              text: 'API Error: provider unavailable',
            },
          ],
        },
      }) as Awaited<ReturnType<AgentGenerationQuery>>) as AgentGenerationQuery
    __setAgentGenerationQueryForTests(queryModelImpl)

    await expect(
      generateAgentWithModel('review recent changes'),
    ).rejects.toThrow('API Error: provider unavailable')
  })

  test('does not time out a prompt model response', async () => {
    await expect(
      generateAgentWithModel('review recent changes', { timeoutMs: 5 }),
    ).resolves.toEqual(generatedAgent)
  })

  test('aborts and rejects a stalled model request at its deadline', async () => {
    let requestSignal: AbortSignal | undefined
    queryModelImpl = (async (_model, _messages, _systemPrompt, signal) => {
      requestSignal = signal
      return await new Promise<Awaited<ReturnType<AgentGenerationQuery>>>(
        () => {},
      )
    }) as AgentGenerationQuery
    __setAgentGenerationQueryForTests(queryModelImpl)

    await expect(
      generateAgentWithModel('review recent changes', { timeoutMs: 5 }),
    ).rejects.toThrow('Agent generation timed out after 1 second')
    expect(requestSignal?.aborted).toBe(true)
  })

  test('rejects promptly when the caller cancels a stalled request', async () => {
    const controller = new AbortController()
    queryModelImpl = (async () =>
      await new Promise<Awaited<ReturnType<AgentGenerationQuery>>>(
        () => {},
      )) as AgentGenerationQuery
    __setAgentGenerationQueryForTests(queryModelImpl)

    const generation = generateAgentWithModel('review recent changes', {
      signal: controller.signal,
      timeoutMs: 1_000,
    })
    controller.abort()

    await expect(generation).rejects.toThrow('Agent generation cancelled')
  })
})
