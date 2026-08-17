import { afterEach, describe, expect, test } from 'bun:test'
import React from 'react'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { getGlobalConfig, saveGlobalConfig } from '#core/utils/config'
import { getCwd, setCwd } from '#core/utils/state'
import { getEffectiveSessionId, setSessionId } from '#core/utils/sessionId'
import {
  __removeBackgroundAgentTaskForTests,
  getBackgroundAgentTaskSnapshot,
  upsertBackgroundAgentTask,
  type BackgroundAgentTaskRuntime,
} from '#core/utils/backgroundTasks'
import { peekSessionMessages } from '@kode/protocol/sessionMessaging'
import { getSessionLogFilePath } from '#protocol/utils/kodeAgentSessionLog'
import { getKodeAgentSessionId } from '#protocol/utils/kodeAgentSessionId'

import voice, {
  formatVoiceTaskStatus,
  resolveVoiceAgentTarget,
  updateVoiceConfiguration,
} from './voice'

const initialConfig = structuredClone(getGlobalConfig())

function installAgent(agentId: string): void {
  const task: BackgroundAgentTaskRuntime = {
    type: 'async_agent',
    agentId,
    parentAgentId: 'main',
    description: 'Inspect runtime guidance',
    prompt: 'Inspect runtime guidance.',
    status: 'running',
    cwd: getCwd(),
    sessionId: getKodeAgentSessionId(),
    startedAt: Date.now(),
    messages: [],
    guidance: [],
    abortController: new AbortController(),
    done: Promise.resolve(),
  }
  upsertBackgroundAgentTask(task)
}

function writeSession(cwd: string, sessionId: string, title: string): void {
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
      message: { role: 'user', content: title },
    })}\n${JSON.stringify({ type: 'custom-title', sessionId, customTitle: title })}\n`,
    { encoding: 'utf8', mode: 0o600 },
  )
}

afterEach(() => {
  saveGlobalConfig(initialConfig)
})

describe('/voice configuration commands', () => {
  test('accepts settings without ever accepting a raw API key', () => {
    expect(
      updateVoiceConfiguration('config set api-key-env KODE_MIMO_KEY'),
    ).toContain('Voice configuration updated.')
    expect(getGlobalConfig().voice?.apiKeyEnv).toBe('KODE_MIMO_KEY')
    expect(updateVoiceConfiguration('config set api-key wrong')).toContain(
      'never accepted as credentials',
    )
  })

  test('keeps invalid values out of persisted configuration', () => {
    const before = getGlobalConfig().voice
    expect(
      updateVoiceConfiguration('config set max-recording-seconds 999'),
    ).toContain('Voice configuration was not saved')
    expect(getGlobalConfig().voice).toEqual(before)
  })

  test('routes a reviewed voice transcript into running-Agent guidance', async () => {
    const agentId = `voice-guide-${crypto.randomUUID()}`
    installAgent(agentId)
    try {
      expect(resolveVoiceAgentTarget()).toMatchObject({ taskId: agentId })
      expect(formatVoiceTaskStatus(agentId)).toContain('guidance: 0 pending')

      const node = await voice.call(() => {}, {} as never, `guide ${agentId}`)
      expect(React.isValidElement(node)).toBe(true)
      if (!React.isValidElement(node)) throw new Error('Expected VoiceScreen')
      const submission = (
        node.props as {
          submission?: { submit(text: string): Promise<string> }
        }
      ).submission
      if (!submission) throw new Error('Expected voice guidance submission')
      const result = await submission.submit(
        'Prioritize correctness before interface polish.',
      )

      expect(result).toContain('next model-turn boundary')
      expect(
        getBackgroundAgentTaskSnapshot(agentId)?.guidance?.[0],
      ).toMatchObject({
        body: 'Prioritize correctness before interface polish.',
        status: 'queued',
      })
    } finally {
      __removeBackgroundAgentTaskForTests(agentId)
    }
  })

  test('routes a reviewed voice transcript through durable session messaging', async () => {
    const previousCwd = getCwd()
    const previousSession = getEffectiveSessionId()
    const previousConfigDir = process.env.KODE_CONFIG_DIR
    const configDir = mkdtempSync(join(tmpdir(), 'kode-voice-message-config-'))
    const workspace = mkdtempSync(
      join(tmpdir(), 'kode-voice-message-workspace-'),
    )
    const sender = '12121212-1212-4212-8212-121212121212'
    const target = '34343434-3434-4434-8434-343434343434'
    try {
      process.env.KODE_CONFIG_DIR = configDir
      await setCwd(workspace)
      setSessionId(sender)
      writeSession(workspace, sender, 'Voice sender')
      writeSession(workspace, target, 'Runtime reviewer')

      const node = await voice.call(
        () => {},
        {} as never,
        `message ${target.slice(0, 8)}`,
      )
      expect(React.isValidElement(node)).toBe(true)
      if (!React.isValidElement(node)) throw new Error('Expected VoiceScreen')
      const submission = (
        node.props as {
          submission?: { submit(text: string): Promise<string> }
        }
      ).submission
      if (!submission) throw new Error('Expected voice message submission')
      const result = await submission.submit('Please inspect the active task.')

      expect(result).toContain('queued for Runtime reviewer')
      expect(
        (await peekSessionMessages({ cwd: workspace, sessionId: target }))[0]
          ?.body,
      ).toBe('Please inspect the active task.')
    } finally {
      await setCwd(previousCwd)
      setSessionId(previousSession)
      if (previousConfigDir === undefined) delete process.env.KODE_CONFIG_DIR
      else process.env.KODE_CONFIG_DIR = previousConfigDir
      rmSync(configDir, { recursive: true, force: true })
      rmSync(workspace, { recursive: true, force: true })
    }
  })
})
