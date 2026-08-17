import { describe, expect, test } from 'bun:test'
import { mkdtempSync, realpathSync, rmSync } from 'fs'
import { homedir, tmpdir } from 'os'
import { join } from 'path'
import { TaskTool } from '#tools/tools/ai/TaskTool/TaskTool'
import { applyAgentPermissionMode } from '#tools/tools/ai/TaskTool/permissions'
import { getBackgroundAgentTask } from '#core/utils/backgroundTasks'
import { getBackgroundAgentTaskSnapshot } from '#core/utils/backgroundTasks'
import {
  createAssistantAPIErrorMessage,
  createAssistantMessage,
} from '#core/utils/messages'
import { createAnthropicUsage } from '#core/utils/anthropic'
import { createDefaultToolPermissionContext } from '#core/types/toolPermissionContext'
import { FileReadTool } from '#tools/tools/filesystem/FileReadTool/FileReadTool'
import { FileWriteTool } from '#tools/tools/filesystem/FileWriteTool/FileWriteTool'
import { BashTool } from '#tools/tools/system/BashTool/BashTool'
import {
  getCwd,
  getOriginalCwd,
  setCwd,
  setOriginalCwd,
} from '#core/utils/state'
import {
  getKodeAgentSessionId,
  setKodeAgentSessionId,
} from '#protocol/utils/kodeAgentSessionId'
import {
  getKodeAgentSessionForkInfo,
  setKodeAgentSessionForkInfo,
} from '#protocol/utils/kodeAgentSessionForkInfo'
import { appendSessionJsonlFromMessage } from '#protocol/utils/kodeAgentSessionLog'
import { createUserMessage } from '#core/utils/messages'
import { setFlagAgentsFromCliJson } from '@kode/agent'
import { parseToolSpec } from '#tools/tools/ai/TaskTool/toolSpec'
import { AgentSupervisor } from '#core/utils/agentSupervisor'
import {
  __clearAgentTranscriptsForTests,
  saveAgentTranscript,
} from '#core/utils/agentTranscripts'

describe('TaskTool', () => {
  test('subagent permission mode cannot auto-escalate beyond parent context', () => {
    const base = createDefaultToolPermissionContext({
      isBypassPermissionsModeAvailable: true,
    })
    base.mode = 'plan'

    const deniedEscalation = applyAgentPermissionMode(base, {
      agentPermissionMode: 'acceptEdits',
      safeMode: false,
    })
    expect(deniedEscalation?.mode).toBe('plan')

    const narrowed = applyAgentPermissionMode(base, {
      agentPermissionMode: 'plan',
      safeMode: false,
    })
    expect(narrowed?.mode).toBe('plan')
  })

  test('inputSchema ignores unknown keys (compatibility)', () => {
    const result = TaskTool.inputSchema.safeParse({
      description: 'Explore project structure',
      prompt: 'Explore the repo',
      subagent_type: 'general-purpose',
      thoroughness: 'very thorough',
    })

    expect(result.success).toBe(true)
    if (result.success) {
      expect('thoroughness' in result.data).toBe(false)
    }
  })

  test('inputSchema requires max_turns to be a positive integer', () => {
    const base = {
      description: 'Turn limit',
      prompt: 'Use the configured turn limit',
      subagent_type: 'general-purpose',
    }

    expect(
      TaskTool.inputSchema.safeParse({ ...base, max_turns: 2 }).success,
    ).toBe(true)
    expect(
      TaskTool.inputSchema.safeParse({ ...base, max_turns: 0 }).success,
    ).toBe(false)
    expect(
      TaskTool.inputSchema.safeParse({ ...base, max_turns: 1.5 }).success,
    ).toBe(false)
  })

  test('rejects malformed constrained tool specs explicitly', () => {
    expect(() => parseToolSpec('Bash(git:*')).toThrow(
      "Invalid agent tool spec 'Bash(git:*'",
    )
  })

  test('passes max_turns and constrained agent tool rules to the query', async () => {
    let capturedOptions: any = null
    setFlagAgentsFromCliJson(
      JSON.stringify({
        'task-tool-policy-test': {
          description: 'Task tool policy test agent',
          tools: ['Bash(git:*)', 'Read'],
          prompt: 'Return ok.',
        },
      }),
    )

    try {
      async function* stubQuery(
        _messages: any,
        _systemPrompt: any,
        _context: any,
        _canUseTool: any,
        toolUseContext: any,
      ) {
        capturedOptions = toolUseContext?.options ?? null
        yield createAssistantMessage('ok')
      }

      const gen = TaskTool.call(
        {
          description: 'Policy pass through',
          prompt: 'Capture query options',
          subagent_type: 'task-tool-policy-test',
          max_turns: 2,
        },
        {
          abortController: new AbortController(),
          readFileTimestamps: {},
          messageId: 'm',
          options: {
            safeMode: false,
            forkNumber: 0,
            messageLogName: 'task-tool-test',
            verbose: false,
            model: 'main',
            mcpClients: [],
            commandAllowedTools: ['Read(~/**)'],
          },
          __testQuery: stubQuery,
        },
      )

      for await (const _ of gen) {
        // exhaust
      }

      expect(capturedOptions?.maxTurns).toBe(2)
      expect(
        capturedOptions?.tools.map((tool: any) => tool.name).sort(),
      ).toEqual(['Bash', 'Read'])
      expect(capturedOptions?.commandAllowedTools).toEqual([
        'Read(~/**)',
        'Bash(git:*)',
      ])
    } finally {
      setFlagAgentsFromCliJson(undefined)
    }
  })

  test('validateInput: resume missing transcript rejects with reference wording', async () => {
    const result = await TaskTool.validateInput?.({
      description: 'resume task',
      prompt: 'do thing',
      subagent_type: 'general-purpose',
      resume: 'missing-agent-id',
    })

    expect(result).toEqual({
      result: false,
      message: 'No transcript found for agent ID: missing-agent-id',
      meta: { resume: 'missing-agent-id' },
    })
  })

  test('does not expose an in-memory resume transcript across sessions', async () => {
    const previousSessionId = getKodeAgentSessionId()
    const agentId = `scoped-resume-${crypto.randomUUID()}`
    const cwd = getCwd()
    try {
      setKodeAgentSessionId('11111111-1111-4111-8111-111111111111')
      saveAgentTranscript(
        { agentId, cwd, sessionId: getKodeAgentSessionId() },
        [createUserMessage('private session context')],
      )
      setKodeAgentSessionId('22222222-2222-4222-8222-222222222222')

      await expect(
        TaskTool.validateInput?.({
          description: 'resume isolated task',
          prompt: 'continue',
          subagent_type: 'general-purpose',
          resume: agentId,
        }),
      ).resolves.toMatchObject({
        result: false,
        message: `No transcript found for agent ID: ${agentId}`,
      })
    } finally {
      __clearAgentTranscriptsForTests()
      setKodeAgentSessionId(previousSessionId)
    }
  })

  test('does not reuse an old assistant result when a resumed run is empty', async () => {
    const agentId = `empty-resume-${crypto.randomUUID()}`
    saveAgentTranscript(
      { agentId, cwd: getCwd(), sessionId: getKodeAgentSessionId() },
      [
        createUserMessage('old request'),
        createAssistantMessage('old successful result'),
      ],
    )
    async function* emptyQuery() {
      if (false) yield createAssistantMessage('unreachable')
    }

    try {
      const run = (async () => {
        for await (const _chunk of TaskTool.call(
          {
            description: 'resume empty task',
            prompt: 'continue with current requirements',
            subagent_type: 'general-purpose',
            resume: agentId,
          },
          {
            abortController: new AbortController(),
            readFileTimestamps: {},
            messageId: 'empty-resume-message',
            options: {
              safeMode: false,
              forkNumber: 0,
              messageLogName: 'task-tool-empty-resume-test',
              verbose: false,
              model: 'main',
              mcpClients: [],
            },
            __testQuery: emptyQuery,
          },
        )) {
          // Exhaust the generator so terminal classification runs.
        }
      })()
      await expect(run).rejects.toThrow(
        'Subagent ended without an assistant response.',
      )
    } finally {
      __clearAgentTranscriptsForTests()
    }
  })

  test('resume accepts disk transcript when in-memory cache is missing', async () => {
    const runnerCwd = process.cwd()
    const previousConfigDir = process.env.KODE_CONFIG_DIR
    const previousSessionId = getKodeAgentSessionId()

    const configDir = mkdtempSync(join(tmpdir(), 'kode-task-resume-config-'))
    const projectDir = mkdtempSync(join(tmpdir(), 'kode-task-resume-proj-'))
    process.env.KODE_CONFIG_DIR = configDir
    setKodeAgentSessionId('11111111-1111-4111-8111-111111111111')

    try {
      await setCwd(projectDir)

      const agentId = 'agent-resume-test'
      appendSessionJsonlFromMessage({
        cwd: projectDir,
        message: createUserMessage('hello from disk'),
        toolUseContext: { agentId },
      })

      const validate = await TaskTool.validateInput?.({
        description: 'resume task',
        prompt: 'do thing',
        subagent_type: 'general-purpose',
        resume: agentId,
      })
      expect(validate).toEqual({ result: true })

      async function* stubQuery() {
        yield createAssistantMessage('ok')
      }

      const gen = TaskTool.call(
        {
          description: 'resume run',
          prompt: 'resume prompt',
          subagent_type: 'general-purpose',
          resume: agentId,
        },
        {
          abortController: new AbortController(),
          readFileTimestamps: {},
          messageId: 'm',
          options: {
            safeMode: false,
            forkNumber: 0,
            messageLogName: 'task-tool-test',
            verbose: false,
            model: 'main',
            mcpClients: [],
          },
          __testQuery: stubQuery,
        },
      )

      let sawResult = false
      for await (const chunk of gen) {
        if (chunk.type === 'result') {
          sawResult = true
          break
        }
      }
      expect(sawResult).toBe(true)
    } finally {
      await setCwd(runnerCwd)
      setKodeAgentSessionId(previousSessionId)
      if (previousConfigDir === undefined) {
        delete process.env.KODE_CONFIG_DIR
      } else {
        process.env.KODE_CONFIG_DIR = previousConfigDir
      }
      rmSync(configDir, { recursive: true, force: true })
      rmSync(projectDir, { recursive: true, force: true })
    }
  })

  test('run_in_background returns agentId', async () => {
    async function* stubQuery() {
      yield createAssistantMessage('ok')
    }

    const gen = TaskTool.call(
      {
        description: 'bg',
        prompt: 'bg prompt',
        subagent_type: 'general-purpose',
        run_in_background: true,
      },
      {
        abortController: new AbortController(),
        readFileTimestamps: {},
        messageId: 'm',
        options: {
          safeMode: false,
          forkNumber: 0,
          messageLogName: 'task-tool-test',
          verbose: false,
          model: 'main',
          mcpClients: [],
        },
        __testQuery: stubQuery,
      },
    )

    const first = await gen.next()
    expect(first.done).toBe(false)
    if (first.done || !first.value) {
      throw new Error('Expected TaskTool to yield a result')
    }
    expect(first.value.type).toBe('result')
    if (first.value.type !== 'result') {
      throw new Error('Expected TaskTool to yield a result')
    }
    expect(first.value.data.status).toBe('async_launched')
    expect(typeof first.value.data.agentId).toBe('string')
    expect(first.value.data.agentId.length).toBeGreaterThan(0)

    const task = getBackgroundAgentTask(first.value.data.agentId)
    expect(task?.type).toBe('async_agent')
    await task?.done

    const snapshot = getBackgroundAgentTaskSnapshot(first.value.data.agentId)
    if (!snapshot) throw new Error('Expected task snapshot')
    const runtimeMessageCount =
      getBackgroundAgentTask(first.value.data.agentId)?.messages.length ?? 0
    expect(runtimeMessageCount).toBeGreaterThan(0)
    snapshot.messages.length = 0
    expect(
      getBackgroundAgentTask(first.value.data.agentId)?.messages.length,
    ).toBe(runtimeMessageCount)
  })

  test('background deadline releases a provider iterator that ignores cancellation', async () => {
    setFlagAgentsFromCliJson(
      JSON.stringify({
        'non-cooperative-provider': {
          description: 'Simulate a provider transport that never yields',
          tools: [],
          prompt: 'Wait forever.',
          maxExecutionTimeMs: 1_000,
        },
      }),
    )

    try {
      async function* hungQuery() {
        await new Promise<void>(() => {})
        yield createAssistantMessage('unreachable')
      }

      const gen = TaskTool.call(
        {
          description: 'deadline isolation',
          prompt: 'exercise a non-cooperative provider',
          subagent_type: 'non-cooperative-provider',
          run_in_background: true,
        },
        {
          abortController: new AbortController(),
          readFileTimestamps: {},
          messageId: 'm',
          options: {
            safeMode: false,
            forkNumber: 0,
            messageLogName: 'task-tool-deadline-test',
            verbose: false,
            model: 'main',
            mcpClients: [],
          },
          __testQuery: hungQuery,
        },
      )

      const launched = await gen.next()
      if (launched.done || launched.value.type !== 'result') {
        throw new Error('Expected background launch result')
      }
      const task = getBackgroundAgentTask(launched.value.data.agentId)
      if (!task) throw new Error('Expected registered background task')

      let safetyTimer: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([
          task.done,
          new Promise<never>((_, reject) => {
            safetyTimer = setTimeout(
              () =>
                reject(new Error('Deadline did not release background task')),
              2_000,
            )
          }),
        ])
      } finally {
        if (safetyTimer) clearTimeout(safetyTimer)
      }

      expect(task.status).toBe('failed')
      expect(task.error).toContain('execution timeout')
      expect(AgentSupervisor.activeCount).toBe(0)
    } finally {
      setFlagAgentsFromCliJson(undefined)
    }
  })

  test('background agent keeps its launch workspace and session after globals change', async () => {
    const runnerCwd = getCwd()
    const runnerOriginalCwd = getOriginalCwd()
    const previousSessionId = getKodeAgentSessionId()
    const previousForkInfo = getKodeAgentSessionForkInfo()
    const projectA = mkdtempSync(join(tmpdir(), 'kode-agent-scope-a-'))
    const projectB = mkdtempSync(join(tmpdir(), 'kode-agent-scope-b-'))
    let releaseQuery!: () => void
    let markStarted!: () => void
    const queryCanFinish = new Promise<void>(resolve => {
      releaseQuery = resolve
    })
    const queryStarted = new Promise<void>(resolve => {
      markStarted = resolve
    })
    let observed: unknown = null

    try {
      await setCwd(projectA)
      setOriginalCwd(projectA)
      setKodeAgentSessionId('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')
      setKodeAgentSessionForkInfo({
        forkedFromSessionId: 'parent-a',
        forkRootSessionId: 'root-a',
      })

      async function* stubQuery() {
        markStarted()
        await queryCanFinish
        observed = {
          cwd: getCwd(),
          originalCwd: getOriginalCwd(),
          sessionId: getKodeAgentSessionId(),
          forkInfo: getKodeAgentSessionForkInfo(),
        }
        yield createAssistantMessage('ok')
      }

      const gen = TaskTool.call(
        {
          description: 'scope isolation',
          prompt: 'observe the scoped identity',
          subagent_type: 'general-purpose',
          run_in_background: true,
        },
        {
          abortController: new AbortController(),
          readFileTimestamps: {},
          messageId: 'm',
          options: {
            safeMode: false,
            forkNumber: 0,
            messageLogName: 'task-tool-scope-test',
            verbose: false,
            model: 'main',
            mcpClients: [],
          },
          __testQuery: stubQuery,
        },
      )

      const launched = await gen.next()
      if (launched.done || launched.value.type !== 'result') {
        throw new Error('Expected background launch result')
      }
      await queryStarted

      await setCwd(projectB)
      setOriginalCwd(projectB)
      setKodeAgentSessionId('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb')
      setKodeAgentSessionForkInfo({
        forkedFromSessionId: 'parent-b',
        forkRootSessionId: 'root-b',
      })
      releaseQuery()

      const task = getBackgroundAgentTask(launched.value.data.agentId)
      await task?.done
      expect(observed).toEqual({
        cwd: projectA,
        originalCwd: projectA,
        sessionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        forkInfo: {
          forkedFromSessionId: 'parent-a',
          forkRootSessionId: 'root-a',
        },
      })
      expect(getCwd()).toBe(projectB)
    } finally {
      releaseQuery()
      await setCwd(runnerCwd)
      setOriginalCwd(runnerOriginalCwd)
      setKodeAgentSessionId(previousSessionId)
      setKodeAgentSessionForkInfo(previousForkInfo)
      rmSync(projectA, { recursive: true, force: true })
      rmSync(projectB, { recursive: true, force: true })
    }
  })

  test('foreground agent keeps its launch workspace while another turn changes globals', async () => {
    const runnerCwd = getCwd()
    const runnerOriginalCwd = getOriginalCwd()
    const projectA = mkdtempSync(join(tmpdir(), 'kode-agent-fg-scope-a-'))
    const projectB = mkdtempSync(join(tmpdir(), 'kode-agent-fg-scope-b-'))
    let releaseQuery!: () => void
    let markStarted!: () => void
    const queryCanFinish = new Promise<void>(resolve => {
      releaseQuery = resolve
    })
    const queryStarted = new Promise<void>(resolve => {
      markStarted = resolve
    })
    let observedCwd = ''

    try {
      await setCwd(projectA)
      setOriginalCwd(projectA)

      async function* stubQuery() {
        markStarted()
        await queryCanFinish
        observedCwd = getCwd()
        yield createAssistantMessage('ok')
      }

      const gen = TaskTool.call(
        {
          description: 'foreground scope isolation',
          prompt: 'observe the launch workspace',
          subagent_type: 'general-purpose',
        },
        {
          abortController: new AbortController(),
          readFileTimestamps: {},
          messageId: 'm',
          options: {
            safeMode: false,
            forkNumber: 0,
            messageLogName: 'task-tool-fg-scope-test',
            verbose: false,
            model: 'main',
            mcpClients: [],
          },
          __testQuery: stubQuery,
        },
      )

      const draining = (async () => {
        for await (const _ of gen) {
          // exhaust
        }
      })()
      await queryStarted
      await setCwd(projectB)
      setOriginalCwd(projectB)
      releaseQuery()
      await draining

      expect(observedCwd).toBe(projectA)
      expect(getCwd()).toBe(projectB)
    } finally {
      releaseQuery()
      await setCwd(runnerCwd)
      setOriginalCwd(runnerOriginalCwd)
      rmSync(projectA, { recursive: true, force: true })
      rmSync(projectB, { recursive: true, force: true })
    }
  })

  test('background agent Bash resolves relative paths in its launch workspace', async () => {
    if (process.platform === 'win32') return

    const runnerCwd = getCwd()
    const runnerOriginalCwd = getOriginalCwd()
    const projectA = mkdtempSync(join(tmpdir(), 'kode-agent-bash-a-'))
    const projectB = mkdtempSync(join(tmpdir(), 'kode-agent-bash-b-'))
    let releaseQuery!: () => void
    let markStarted!: () => void
    const queryCanRunBash = new Promise<void>(resolve => {
      releaseQuery = resolve
    })
    const queryStarted = new Promise<void>(resolve => {
      markStarted = resolve
    })
    let stdout = ''

    try {
      await setCwd(projectA)
      setOriginalCwd(projectA)

      async function* stubQuery(
        _messages: any,
        _systemPrompt: any,
        _context: any,
        _canUseTool: any,
        toolUseContext: any,
      ) {
        markStarted()
        await queryCanRunBash
        for await (const chunk of BashTool.call(
          { command: 'pwd', description: 'Print launch workspace' },
          toolUseContext,
        )) {
          if (chunk.type === 'result') stdout = chunk.data.stdout.trim()
        }
        yield createAssistantMessage('ok')
      }

      const gen = TaskTool.call(
        {
          description: 'bash scope isolation',
          prompt: 'run pwd after the parent returns',
          subagent_type: 'general-purpose',
          run_in_background: true,
        },
        {
          abortController: new AbortController(),
          readFileTimestamps: {},
          messageId: 'm',
          options: {
            safeMode: false,
            forkNumber: 0,
            messageLogName: 'task-tool-bash-scope-test',
            verbose: false,
            model: 'main',
            mcpClients: [],
          },
          __testQuery: stubQuery,
        },
      )

      const launched = await gen.next()
      if (launched.done || launched.value.type !== 'result') {
        throw new Error('Expected background launch result')
      }
      await queryStarted
      await setCwd(projectB)
      setOriginalCwd(projectB)
      releaseQuery()

      const task = getBackgroundAgentTask(launched.value.data.agentId)
      await task?.done
      expect(realpathSync(stdout)).toBe(realpathSync(projectA))
      expect(getCwd()).toBe(projectB)
    } finally {
      releaseQuery()
      await setCwd(runnerCwd)
      setOriginalCwd(runnerOriginalCwd)
      rmSync(projectA, { recursive: true, force: true })
      rmSync(projectB, { recursive: true, force: true })
    }
  })

  test('completed output includes tool use count, duration, and tokens', async () => {
    async function* stubQuery() {
      const msg = createAssistantMessage('hello')
      msg.message.usage = createAnthropicUsage({
        input_tokens: 10,
        output_tokens: 20,
        cache_creation_input_tokens: 3,
        cache_read_input_tokens: 2,
      })
      msg.message.content = [
        { type: 'tool_use', id: 't1', name: 'Bash', input: {} },
        { type: 'tool_use', id: 't2', name: 'Read', input: {} },
        { type: 'text', text: 'hello', citations: [] },
      ]
      yield msg
    }

    const gen = TaskTool.call(
      {
        description: 'fg',
        prompt: 'fg prompt',
        subagent_type: 'general-purpose',
      },
      {
        abortController: new AbortController(),
        readFileTimestamps: {},
        messageId: 'm',
        options: {
          safeMode: false,
          forkNumber: 0,
          messageLogName: 'task-tool-test',
          verbose: false,
          model: 'main',
          mcpClients: [],
        },
        __testQuery: stubQuery,
      },
    )

    let result: any = null
    for await (const chunk of gen) {
      if (chunk.type === 'result') {
        result = chunk
      }
    }

    expect(result?.data?.status).toBe('completed')
    expect(result.data.prompt).toBe('fg prompt')
    expect(result.data.totalToolUseCount).toBe(2)
    expect(result.data.totalTokens).toBe(35)
    expect(result.data.totalDurationMs).toBeGreaterThanOrEqual(0)
    expect(result.data.usage).toMatchObject({
      input_tokens: 10,
      output_tokens: 20,
      cache_creation_input_tokens: 3,
      cache_read_input_tokens: 2,
    })
    expect(result.data.content).toEqual([
      { type: 'text', text: 'hello', citations: [] },
    ])
  })

  test('surfaces a child verification failure instead of reporting completion', async () => {
    async function* stubQuery() {
      yield createAssistantAPIErrorMessage(
        'Verification incomplete: child changes were not checked.',
      )
    }

    const gen = TaskTool.call(
      {
        description: 'failed child',
        prompt: 'make and verify a change',
        subagent_type: 'general-purpose',
      },
      {
        abortController: new AbortController(),
        readFileTimestamps: {},
        messageId: 'm',
        options: {
          safeMode: false,
          forkNumber: 0,
          messageLogName: 'task-tool-failed-child-test',
          verbose: false,
          model: 'main',
          mcpClients: [],
        },
        __testQuery: stubQuery,
      },
    )

    let result: any = null
    for await (const chunk of gen) {
      if (chunk.type === 'result') result = chunk
    }

    expect(result?.data).toMatchObject({
      status: 'failed',
      error: 'Verification incomplete: child changes were not checked.',
    })
    expect(JSON.stringify(result?.resultForAssistant)).toContain(
      'Subagent failed',
    )
  })

  test('subagent inherits toolPermissionContext + commandAllowedTools (no silent widening)', async () => {
    let capturedOptions: any = null
    let readPermission: any = null
    let writePermission: any = null

    async function* stubQuery(
      _messages: any,
      _systemPrompt: any,
      _context: any,
      canUseTool: any,
      toolUseContext: any,
    ) {
      capturedOptions = toolUseContext?.options ?? null

      const filePath = join(homedir(), 'some-file.txt')
      const assistantMsg = createAssistantMessage('')

      readPermission = await canUseTool(
        FileReadTool,
        { file_path: filePath },
        toolUseContext,
        assistantMsg,
      )
      writePermission = await canUseTool(
        FileWriteTool,
        { file_path: filePath, content: 'x' },
        toolUseContext,
        assistantMsg,
      )

      yield createAssistantMessage('ok')
    }

    const toolPermissionContext = createDefaultToolPermissionContext({
      isBypassPermissionsModeAvailable: true,
    })
    toolPermissionContext.mode = 'cautious'

    const gen = TaskTool.call(
      {
        description: 'inheritance',
        prompt: 'inheritance prompt',
        subagent_type: 'general-purpose',
      },
      {
        abortController: new AbortController(),
        readFileTimestamps: {},
        messageId: 'm',
        options: {
          safeMode: false,
          forkNumber: 0,
          messageLogName: 'task-tool-test',
          verbose: false,
          model: 'main',
          mcpClients: [],
          toolPermissionContext,
          commandAllowedTools: ['Read(~/**)'],
        },
        __testQuery: stubQuery,
      },
    )

    for await (const _ of gen) {
      // exhaust
    }

    expect(capturedOptions?.toolPermissionContext?.mode).toBe('cautious')
    expect(capturedOptions?.commandAllowedTools).toEqual(['Read(~/**)'])

    expect(readPermission?.result).toBe(true)
    expect(writePermission?.result).toBe(false)
    expect(writePermission?.shouldPromptUser).not.toBe(false)
  })
})
