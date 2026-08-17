import { afterEach, describe, expect, test } from 'bun:test'

import { __setLlmLazyQueryLLMLoaderForTests } from '#core/ai/llmLazy'
import {
  __removeBackgroundAgentTaskForTests,
  getBackgroundAgentTask,
  getBackgroundAgentTaskSnapshot,
  guideBackgroundAgentTask,
  upsertBackgroundAgentTask,
  type BackgroundAgentTaskRuntime,
} from '#core/utils/backgroundTasks'
import {
  createAssistantAPIErrorMessage,
  createAssistantMessage,
  createUserMessage,
} from '#core/utils/messages'
import { TaskTool } from '#tools/tools/ai/TaskTool/TaskTool'

const installed: string[] = []

afterEach(() => {
  __setLlmLazyQueryLLMLoaderForTests(null)
  for (const id of installed.splice(0)) {
    __removeBackgroundAgentTaskForTests(id)
  }
})

function installRunningTask(agentId: string): void {
  const task: BackgroundAgentTaskRuntime = {
    type: 'async_agent',
    agentId,
    parentAgentId: 'main',
    description: 'Investigate cancellation',
    prompt: 'Investigate cancellation.',
    status: 'running',
    cwd: process.cwd(),
    startedAt: Date.now(),
    messages: [],
    guidance: [],
    abortController: new AbortController(),
    done: Promise.resolve(),
  }
  upsertBackgroundAgentTask(task)
  installed.push(agentId)
}

describe('runtime background-agent guidance delivery', () => {
  test('injects escaped guidance at an agent turn boundary and marks it applied', async () => {
    const agentId = `guided-agent-${crypto.randomUUID()}`
    installRunningTask(agentId)
    const queued = guideBackgroundAgentTask({
      agentId,
      body: 'Inspect <auth.ts> first; do not change files yet.',
    })
    let observedMessages: unknown[] = []
    __setLlmLazyQueryLLMLoaderForTests(
      async () =>
        (async (messages: unknown[]) => {
          observedMessages = messages
          return createAssistantMessage('Guidance considered.')
        }) as never,
    )

    const { messagePipeline } = await import('@kode/engine/message-pipeline')
    for await (const _message of messagePipeline(
      [createUserMessage('Continue.')],
      [],
      {},
      (async () => ({ result: true })) as never,
      {
        agentId,
        abortController: new AbortController(),
        readFileTimestamps: {},
        setToolJSX: () => {},
        options: {
          commands: [],
          forkNumber: 0,
          messageLogName: 'runtime-guidance-engine',
          tools: [],
          verbose: false,
          safeMode: false,
          maxThinkingTokens: 0,
          persistSession: false,
        },
      } as never,
    )) {
      // Consume the response.
    }

    const serialized = JSON.stringify(observedMessages)
    expect(serialized).toContain('<runtime-guidance>')
    expect(serialized).toContain('&lt;auth.ts&gt;')
    expect(serialized).toContain(queued.guidanceId)
    expect(
      getBackgroundAgentTaskSnapshot(agentId)?.guidance?.[0],
    ).toMatchObject({
      guidanceId: queued.guidanceId,
      status: 'applied',
      appliedAt: expect.any(Number),
    })
  })

  test('releases claimed guidance when the provider fails before application', async () => {
    const agentId = `guided-agent-failure-${crypto.randomUUID()}`
    installRunningTask(agentId)
    guideBackgroundAgentTask({ agentId, body: 'Keep this queued.' })
    __setLlmLazyQueryLLMLoaderForTests(
      async () =>
        (async () => {
          throw new Error('provider unavailable')
        }) as never,
    )

    const { messagePipeline } = await import('@kode/engine/message-pipeline')
    await expect(
      (async () => {
        for await (const _message of messagePipeline(
          [createUserMessage('Continue.')],
          [],
          {},
          (async () => ({ result: true })) as never,
          {
            agentId,
            abortController: new AbortController(),
            readFileTimestamps: {},
            setToolJSX: () => {},
            options: {
              commands: [],
              forkNumber: 0,
              messageLogName: 'runtime-guidance-failure',
              tools: [],
              verbose: false,
              safeMode: false,
              maxThinkingTokens: 0,
              persistSession: false,
            },
          } as never,
        )) {
          // Consume.
        }
      })(),
    ).rejects.toThrow('provider unavailable')
    expect(getBackgroundAgentTaskSnapshot(agentId)?.guidance?.[0]?.status).toBe(
      'queued',
    )
  })

  test('does not call guidance applied when the provider returns an API error', async () => {
    const agentId = `guided-agent-api-error-${crypto.randomUUID()}`
    installRunningTask(agentId)
    guideBackgroundAgentTask({ agentId, body: 'Retry this on a healthy turn.' })
    __setLlmLazyQueryLLMLoaderForTests(
      async () =>
        (async () =>
          createAssistantAPIErrorMessage('API_ERROR: unavailable')) as never,
    )

    const { messagePipeline } = await import('@kode/engine/message-pipeline')
    for await (const _message of messagePipeline(
      [createUserMessage('Continue.')],
      [],
      {},
      (async () => ({ result: true })) as never,
      {
        agentId,
        abortController: new AbortController(),
        readFileTimestamps: {},
        setToolJSX: () => {},
        options: {
          commands: [],
          forkNumber: 0,
          messageLogName: 'runtime-guidance-api-error',
          tools: [],
          verbose: false,
          safeMode: false,
          maxThinkingTokens: 0,
          persistSession: false,
        },
      } as never,
    )) {
      // Consume the bounded error response.
    }

    expect(getBackgroundAgentTaskSnapshot(agentId)?.guidance?.[0]?.status).toBe(
      'queued',
    )
  })

  test('re-enters a completing background Agent when guidance arrives during its active model request', async () => {
    let releaseFirst!: () => void
    let markFirstStarted!: () => void
    const firstCanFinish = new Promise<void>(resolve => {
      releaseFirst = resolve
    })
    const firstStarted = new Promise<void>(resolve => {
      markFirstStarted = resolve
    })
    const observed: string[] = []
    let calls = 0
    __setLlmLazyQueryLLMLoaderForTests(
      async () =>
        (async (messages: unknown[]) => {
          calls += 1
          observed.push(JSON.stringify(messages))
          if (calls === 1) {
            markFirstStarted()
            await firstCanFinish
            return createAssistantMessage('Initial response.')
          }
          return createAssistantMessage('Redirected response.')
        }) as never,
    )

    const launcher = TaskTool.call(
      {
        description: 'runtime redirect',
        prompt: 'Inspect the current implementation.',
        subagent_type: 'general-purpose',
        run_in_background: true,
      },
      {
        agentId: 'main',
        abortController: new AbortController(),
        readFileTimestamps: {},
        messageId: 'runtime-guide-launch',
        options: {
          safeMode: false,
          forkNumber: 0,
          messageLogName: 'runtime-guide-launch',
          verbose: false,
          model: 'main',
          mcpClients: [],
          persistSession: false,
        },
      },
    )
    const launched = await launcher.next()
    if (launched.done || launched.value.type !== 'result') {
      throw new Error('Expected background Agent launch')
    }
    const agentId = launched.value.data.agentId
    installed.push(agentId)
    await firstStarted
    const guidance = guideBackgroundAgentTask({
      agentId,
      body: 'Focus on the cancellation race and do not edit files.',
    })
    releaseFirst()
    await getBackgroundAgentTask(agentId)?.done

    expect(calls).toBe(2)
    expect(observed[1]).toContain('<runtime-guidance>')
    expect(observed[1]).toContain('Focus on the cancellation race')
    expect(getBackgroundAgentTaskSnapshot(agentId)?.guidance).toContainEqual(
      expect.objectContaining({
        guidanceId: guidance.guidanceId,
        status: 'applied',
      }),
    )
  })

  test('applies queued guidance after a foreground Agent is promoted with ctrl+b', async () => {
    let releaseFirst!: () => void
    let markFirstStarted!: () => void
    const firstCanFinish = new Promise<void>(resolve => {
      releaseFirst = resolve
    })
    const firstStarted = new Promise<void>(resolve => {
      markFirstStarted = resolve
    })
    const observed: string[] = []
    let calls = 0
    __setLlmLazyQueryLLMLoaderForTests(
      async () =>
        (async (messages: unknown[]) => {
          calls += 1
          observed.push(JSON.stringify(messages))
          if (calls === 1) {
            markFirstStarted()
            await firstCanFinish
            return createAssistantMessage('Initial response.')
          }
          return createAssistantMessage('Redirected response.')
        }) as never,
    )

    let backgroundTriggered = false
    const outputEvents: any[] = []
    const consume = (async () => {
      for await (const event of TaskTool.call(
        {
          description: 'promoted runtime redirect',
          prompt: 'Inspect the current implementation.',
          subagent_type: 'general-purpose',
        },
        {
          agentId: 'main',
          abortController: new AbortController(),
          readFileTimestamps: {},
          messageId: 'runtime-guide-promoted-launch',
          options: {
            safeMode: false,
            forkNumber: 0,
            messageLogName: 'runtime-guide-promoted-launch',
            verbose: false,
            model: 'main',
            mcpClients: [],
            persistSession: false,
          },
          setToolJSX(value: any) {
            if (backgroundTriggered || !value?.onKeypress) return
            backgroundTriggered = true
            value.onKeypress('b', {
              ctrl: true,
              meta: false,
              shift: false,
            })
          },
        } as never,
      )) {
        outputEvents.push(event)
      }
    })()

    await firstStarted
    await consume
    const launched = outputEvents.find(
      event =>
        event.type === 'result' && event.data.status === 'async_launched',
    )
    if (!launched) throw new Error('Expected promoted background launch')
    const agentId = launched.data.agentId as string
    installed.push(agentId)
    const guidance = guideBackgroundAgentTask({
      agentId,
      body: 'Focus on the cancellation race after promotion.',
    })
    releaseFirst()
    await getBackgroundAgentTask(agentId)?.done

    expect(backgroundTriggered).toBe(true)
    expect(calls).toBe(2)
    expect(observed[1]).toContain('<runtime-guidance>')
    expect(observed[1]).toContain('after promotion')
    expect(getBackgroundAgentTaskSnapshot(agentId)?.guidance).toContainEqual(
      expect.objectContaining({
        guidanceId: guidance.guidanceId,
        status: 'applied',
      }),
    )
  })
})
