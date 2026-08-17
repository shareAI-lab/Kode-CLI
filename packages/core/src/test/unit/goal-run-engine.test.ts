import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'

import {
  __setLlmLazyQueryLLMLoaderForTests,
  __setLlmLazyQueryQuickLoaderForTests,
} from '#core/ai/llmLazy'
import {
  evaluateActiveGoalAfterTurn,
  GoalService,
  startGoal,
} from '#core/goals'
import { createAssistantMessage, createUserMessage } from '#core/utils/messages'
import { setSessionId } from '#core/utils/sessionId'
import { getCwd, setCwd } from '#core/utils/state'
import type { Tool } from '@kode/tool-interface/Tool'

describe('GoalRun engine loop', () => {
  const originalConfigDir = process.env.KODE_CONFIG_DIR
  const originalSessionId = process.env.KODE_SESSION_ID
  const originalCwd = process.cwd()
  let configDir: string
  let projectDir: string

  beforeEach(async () => {
    configDir = mkdtempSync(join(tmpdir(), 'kode-goal-engine-config-'))
    projectDir = mkdtempSync(join(tmpdir(), 'kode-goal-engine-project-'))
    process.env.KODE_CONFIG_DIR = configDir
    await setCwd(projectDir)
    setSessionId('7e9b6c51-f441-4bb7-8ccc-92adfe45c3fd')
  })

  afterEach(async () => {
    __setLlmLazyQueryLLMLoaderForTests(null)
    __setLlmLazyQueryQuickLoaderForTests(null)
    await setCwd(originalCwd)
    if (originalConfigDir === undefined) delete process.env.KODE_CONFIG_DIR
    else process.env.KODE_CONFIG_DIR = originalConfigDir
    if (originalSessionId === undefined) delete process.env.KODE_SESSION_ID
    else process.env.KODE_SESSION_ID = originalSessionId
    rmSync(configDir, { recursive: true, force: true })
    rmSync(projectDir, { recursive: true, force: true })
  })

  test('continues a goal after a rejected final answer, then records completion', async () => {
    const sessionId = '7e9b6c51-f441-4bb7-8ccc-92adfe45c3fd'
    startGoal({
      cwd: projectDir,
      sessionId,
      objective: 'Create the goal-loop proof',
      acceptanceCriteria: ['Return a final response with concrete evidence'],
      maxIterations: 3,
    })

    let modelCalls = 0
    let evaluatorCalls = 0
    __setLlmLazyQueryLLMLoaderForTests(
      async () =>
        (async () => {
          modelCalls += 1
          return createAssistantMessage(
            modelCalls === 1
              ? 'I am done.'
              : 'Implemented the proof and verified it.',
          )
        }) as never,
    )
    __setLlmLazyQueryQuickLoaderForTests(
      async () =>
        (async () => {
          evaluatorCalls += 1
          return createAssistantMessage(
            evaluatorCalls === 1
              ? JSON.stringify({
                  action: 'continue',
                  reason: 'The first answer provides no evidence.',
                  continuationPrompt: 'Implement the proof and verify it.',
                })
              : JSON.stringify({
                  action: 'complete',
                  reason: 'The final response contains the required evidence.',
                }),
          )
        }) as never,
    )

    const { messagePipeline } = await import('@kode/engine/message-pipeline')
    const messages: Array<{ type: string; message?: unknown }> = []
    for await (const message of messagePipeline(
      [createUserMessage('Work on the proof.')],
      [],
      {},
      (async () => ({ result: true })) as never,
      {
        agentId: 'main',
        abortController: new AbortController(),
        messageId: undefined,
        readFileTimestamps: {},
        setToolJSX: () => {},
        turnCount: 0,
        options: {
          commands: [],
          forkNumber: 0,
          messageLogName: 'goal-test',
          tools: [],
          verbose: false,
          safeMode: false,
          maxThinkingTokens: 0,
          maxTurns: 10,
          persistSession: false,
        },
      } as never,
    )) {
      messages.push(message)
    }

    expect(modelCalls).toBe(2)
    expect(evaluatorCalls).toBe(2)
    expect(
      messages
        .filter(message => message.type === 'assistant')
        .map(message => {
          const content = (message as any).message?.content
          return Array.isArray(content) ? content[0]?.text : ''
        }),
    ).toEqual(['I am done.', 'Implemented the proof and verified it.'])

    const goals = new GoalService().listGoals()
    expect(goals).toHaveLength(1)
    expect(goals[0]?.status).toBe('completed')
    expect(getCwd()).toBe(projectDir)
  })

  test('does not complete a test-required goal without fresh passed evidence', async () => {
    const sessionId = '7e9b6c51-f441-4bb7-8ccc-92adfe45c3fd'
    startGoal({
      cwd: projectDir,
      sessionId,
      objective: 'Ship a safe change',
      acceptanceCriteria: ['Run the focused tests after the source change'],
      maxIterations: 2,
    })
    __setLlmLazyQueryQuickLoaderForTests(
      async () =>
        (async () =>
          createAssistantMessage(
            JSON.stringify({ action: 'complete', reason: 'Looks done.' }),
          )) as never,
    )

    const result = await evaluateActiveGoalAfterTurn({
      cwd: projectDir,
      sessionId,
      assistantText: 'The test suite passed.',
    })

    expect(result.action).toBe('continue')
    expect(result.reason).toContain('test')
    expect(result.continuationPrompt).toContain('test')
    expect(new GoalService().listGoals()[0]?.status).toBe('running')
  })

  test('does not reuse pre-goal evidence when the objective itself requires tests', async () => {
    const sessionId = '7e9b6c51-f441-4bb7-8ccc-92adfe45c3fd'
    startGoal({
      cwd: projectDir,
      sessionId,
      objective: 'Implement the change and run the focused tests',
      maxIterations: 2,
    })
    __setLlmLazyQueryQuickLoaderForTests(
      async () =>
        (async () =>
          createAssistantMessage(
            JSON.stringify({ action: 'complete', reason: 'Looks done.' }),
          )) as never,
    )

    const result = await evaluateActiveGoalAfterTurn({
      cwd: projectDir,
      sessionId,
      assistantText: 'An older test run passed.',
      verificationEvidence: [
        {
          version: 1,
          kind: 'test',
          status: 'passed',
          toolUseId: 'old-test',
          commandDigest: 'a'.repeat(16),
          outputDigest: 'b'.repeat(16),
          recordedAt: '2000-01-01T00:00:00.000Z',
        },
      ],
    })

    expect(result.action).toBe('continue')
    expect(result.reason).toContain('test')
    expect(new GoalService().listGoals()[0]?.status).toBe('running')
  })

  test('passes fresh engine verification evidence to the independent goal evaluator', async () => {
    const sessionId = '7e9b6c51-f441-4bb7-8ccc-92adfe45c3fd'
    startGoal({
      cwd: projectDir,
      sessionId,
      objective: 'Prove the focused tests pass',
      acceptanceCriteria: ['Run the focused test suite after the change'],
      maxIterations: 2,
    })

    const bashTool = {
      name: 'Bash',
      isTrustedExecutionTool: true,
      cachedDescription: 'Run shell command',
      inputSchema: z.object({ command: z.string() }),
      async description() {
        return 'Run shell command'
      },
      async prompt() {
        return 'Run shell command'
      },
      async isEnabled() {
        return true
      },
      isReadOnly() {
        return true
      },
      isConcurrencySafe() {
        return true
      },
      needsPermissions() {
        return false
      },
      renderToolUseMessage() {
        return null
      },
      renderResultForAssistant() {
        return 'focused tests passed'
      },
      async *call() {
        yield {
          type: 'result' as const,
          data: {
            stdout: 'focused tests passed',
            stderr: '',
            interrupted: false,
          },
          resultForAssistant: 'focused tests passed',
        }
      },
    } satisfies Tool

    let modelCalls = 0
    let evaluatorPayload: Record<string, unknown> | undefined
    __setLlmLazyQueryLLMLoaderForTests(
      async () =>
        (async () => {
          modelCalls += 1
          if (modelCalls === 1) {
            const toolCall = createAssistantMessage('')
            toolCall.message.content = [
              {
                type: 'tool_use',
                id: 'verify-1',
                name: 'Bash',
                input: {
                  command:
                    'bun test ./packages/engine/src/verification/evidence.test.ts',
                },
              },
            ]
            return toolCall
          }
          return createAssistantMessage('The focused test suite passed.')
        }) as never,
    )
    __setLlmLazyQueryQuickLoaderForTests(
      async () =>
        (async (input: { userPrompt: string }) => {
          evaluatorPayload = JSON.parse(input.userPrompt) as Record<
            string,
            unknown
          >
          return createAssistantMessage(
            JSON.stringify({
              action: 'complete',
              reason: 'Evidence is present.',
            }),
          )
        }) as never,
    )

    const { messagePipeline } = await import('@kode/engine/message-pipeline')
    for await (const _message of messagePipeline(
      [createUserMessage('Run the focused verification.')],
      [],
      {},
      (async () => ({ result: true })) as never,
      {
        agentId: 'main',
        abortController: new AbortController(),
        messageId: undefined,
        readFileTimestamps: {},
        setToolJSX: () => {},
        turnCount: 0,
        options: {
          commands: [],
          forkNumber: 0,
          messageLogName: 'goal-evidence-test',
          tools: [bashTool],
          verbose: false,
          safeMode: false,
          maxThinkingTokens: 0,
          maxTurns: 10,
          persistSession: false,
        },
      } as never,
    )) {
      // The evaluator payload is the assertion target; emitted messages are
      // exercised by the existing loop tests above.
    }

    expect(modelCalls).toBe(2)
    expect(evaluatorPayload?.verificationEvidence).toEqual([
      {
        version: 1,
        kind: 'test',
        status: 'passed',
        toolUseId: 'verify-1',
        commandDigest: expect.stringMatching(/^[a-f0-9]{16}$/),
        outputDigest: expect.stringMatching(/^[a-f0-9]{16}$/),
        recordedAt: expect.any(String),
      },
    ])
    expect(JSON.stringify(evaluatorPayload)).not.toContain(
      'focused tests passed',
    )
    expect(new GoalService().listGoals()[0]?.status).toBe('completed')
  })
})
