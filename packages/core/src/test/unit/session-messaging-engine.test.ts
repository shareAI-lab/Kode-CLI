import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { __setLlmLazyQueryLLMLoaderForTests } from '#core/ai/llmLazy'
import {
  clearNotifications,
  getNotifications,
} from '#core/services/notificationCenter'
import {
  createAssistantAPIErrorMessage,
  createAssistantMessage,
  createUserMessage,
} from '#core/utils/messages'
import { getCwd, setCwd } from '#core/utils/state'
import { getEffectiveSessionId, setSessionId } from '#core/utils/sessionId'
import {
  getKodeAgentSessionId,
  setKodeAgentSessionId,
} from '#protocol/utils/kodeAgentSessionId'
import { getSessionLogFilePath } from '#protocol/utils/kodeAgentSessionLog'
import {
  getSessionMessageStatus,
  sendSessionMessage,
} from '#protocol/sessionMessaging'

const SENDER = '44444444-4444-4444-8444-444444444444'
const TARGET = '55555555-5555-4555-8555-555555555555'

function writeSession(cwd: string, sessionId: string, prompt: string): void {
  const path = getSessionLogFilePath({ cwd, sessionId })
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(
    path,
    `${JSON.stringify({
      type: 'user',
      uuid: crypto.randomUUID(),
      sessionId,
      cwd,
      timestamp: new Date().toISOString(),
      message: { role: 'user', content: prompt },
    })}\n`,
    { encoding: 'utf8', mode: 0o600 },
  )
}

describe('cross-session message engine delivery', () => {
  const originalConfigDir = process.env.KODE_CONFIG_DIR
  const originalSessionId = process.env.KODE_SESSION_ID
  const originalLegacySessionId = process.env.CLAUDE_CODE_SESSION_ID
  let previousCwd: string
  let previousKodeSessionId: string
  let configDir: string
  let workspace: string

  beforeEach(async () => {
    previousCwd = getCwd()
    previousKodeSessionId = getKodeAgentSessionId()
    configDir = mkdtempSync(join(tmpdir(), 'kode-session-engine-config-'))
    workspace = mkdtempSync(join(tmpdir(), 'kode-session-engine-workspace-'))
    process.env.KODE_CONFIG_DIR = configDir
    await setCwd(workspace)
    setSessionId(TARGET)
    writeSession(workspace, SENDER, 'sender')
    writeSession(workspace, TARGET, 'target')
    clearNotifications()
  })

  afterEach(async () => {
    __setLlmLazyQueryLLMLoaderForTests(null)
    clearNotifications()
    await setCwd(previousCwd)
    if (originalConfigDir === undefined) delete process.env.KODE_CONFIG_DIR
    else process.env.KODE_CONFIG_DIR = originalConfigDir
    if (originalSessionId === undefined) delete process.env.KODE_SESSION_ID
    else process.env.KODE_SESSION_ID = originalSessionId
    if (originalLegacySessionId === undefined) {
      delete process.env.CLAUDE_CODE_SESSION_ID
    } else {
      process.env.CLAUDE_CODE_SESSION_ID = originalLegacySessionId
    }
    setKodeAgentSessionId(previousKodeSessionId)
    rmSync(configDir, { recursive: true, force: true })
    rmSync(workspace, { recursive: true, force: true })
  })

  test('injects a pending peer message into only the target main turn and writes a receipt', async () => {
    const sent = await sendSessionMessage({
      cwd: workspace,
      senderSessionId: SENDER,
      targetSessionId: TARGET,
      body: 'Review <src/auth.ts> and verify the claim.',
    })

    let observedMessages: unknown[] = []
    __setLlmLazyQueryLLMLoaderForTests(
      async () =>
        (async (messages: unknown[]) => {
          observedMessages = messages
          return createAssistantMessage('Peer context received.')
        }) as never,
    )

    const { messagePipeline } = await import('@kode/engine/message-pipeline')
    for await (const _message of messagePipeline(
      [createUserMessage('Continue my current task.')],
      [],
      {},
      (async () => ({ result: true })) as never,
      {
        agentId: 'main',
        abortController: new AbortController(),
        messageId: undefined,
        readFileTimestamps: {},
        setToolJSX: () => {},
        options: {
          commands: [],
          forkNumber: 0,
          messageLogName: 'session-message-engine',
          tools: [],
          verbose: false,
          safeMode: false,
          maxThinkingTokens: 0,
          persistSession: false,
        },
      } as never,
    )) {
      // Consume the normal assistant response.
    }

    const serialized = JSON.stringify(observedMessages)
    expect(getEffectiveSessionId()).toBe(TARGET)
    expect(serialized).toContain('<cross-session-message>')
    expect(serialized).toContain(SENDER)
    expect(serialized).toContain('&lt;src/auth.ts&gt;')
    expect(serialized).toContain('Continue my current task.')
    expect(
      getSessionMessageStatus({
        cwd: workspace,
        senderSessionId: SENDER,
        messageId: sent.messageId,
      }).status,
    ).toBe('delivered')
    expect(
      getNotifications().some(
        notification =>
          notification.channel === 'session-message' &&
          notification.message.includes(SENDER),
      ),
    ).toBe(true)
  })

  test('releases a claimed peer message when the provider returns an API error', async () => {
    const sent = await sendSessionMessage({
      cwd: workspace,
      senderSessionId: SENDER,
      targetSessionId: TARGET,
      body: 'Retry this after provider recovery.',
    })

    __setLlmLazyQueryLLMLoaderForTests(
      async () =>
        (async () =>
          createAssistantAPIErrorMessage(
            'API_ERROR: provider unavailable',
          )) as never,
    )

    const { messagePipeline } = await import('@kode/engine/message-pipeline')
    for await (const _message of messagePipeline(
      [createUserMessage('Continue my current task.')],
      [],
      {},
      (async () => ({ result: true })) as never,
      {
        agentId: 'main',
        abortController: new AbortController(),
        messageId: undefined,
        readFileTimestamps: {},
        setToolJSX: () => {},
        options: {
          commands: [],
          forkNumber: 0,
          messageLogName: 'session-message-engine-error',
          tools: [],
          verbose: false,
          safeMode: false,
          maxThinkingTokens: 0,
          persistSession: false,
        },
      } as never,
    )) {
      // Consume the classified provider error.
    }

    expect(
      getSessionMessageStatus({
        cwd: workspace,
        senderSessionId: SENDER,
        messageId: sent.messageId,
      }).status,
    ).toBe('queued')
  })
})
