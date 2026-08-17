import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import {
  clearNotifications,
  getNotifications,
} from '#core/services/notificationCenter'
import { sendSessionMessage } from '@kode/protocol/sessionMessaging'
import { getSessionLogFilePath } from '@kode/protocol/utils/kodeAgentSessionLog'
import { startSessionMessageNotifications } from './sessionMessages'

const SENDER = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const TARGET = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'

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
    })}\n${JSON.stringify({
      type: 'custom-title',
      sessionId,
      customTitle: title,
    })}\n`,
    { encoding: 'utf8', mode: 0o600 },
  )
}

describe('session message idle notifications', () => {
  const originalConfigDir = process.env.KODE_CONFIG_DIR
  let configDir: string
  let workspace: string

  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), 'kode-session-watch-config-'))
    workspace = mkdtempSync(join(tmpdir(), 'kode-session-watch-workspace-'))
    process.env.KODE_CONFIG_DIR = configDir
    writeSession(workspace, SENDER, 'Implementation')
    writeSession(workspace, TARGET, 'Reviewer')
    clearNotifications()
  })

  afterEach(() => {
    clearNotifications()
    if (originalConfigDir === undefined) delete process.env.KODE_CONFIG_DIR
    else process.env.KODE_CONFIG_DIR = originalConfigDir
    rmSync(configDir, { recursive: true, force: true })
    rmSync(workspace, { recursive: true, force: true })
  })

  test('notifies once while idle and stops cleanly without triggering a model turn', async () => {
    const arrivals: string[][] = []
    const stop = startSessionMessageNotifications({
      cwd: workspace,
      sessionId: TARGET,
      pollIntervalMs: 100,
      onArrival: messages =>
        arrivals.push(messages.map(message => message.messageId)),
    })
    await new Promise(resolve => setTimeout(resolve, 40))

    const first = await sendSessionMessage({
      cwd: workspace,
      senderSessionId: SENDER,
      targetSessionId: TARGET,
      body: 'Review the recovery proof.',
    })
    await new Promise(resolve => setTimeout(resolve, 140))

    expect(arrivals).toEqual([[first.messageId]])
    expect(
      getNotifications().filter(
        notification =>
          notification.id === `session-message-${first.messageId}`,
      ),
    ).toHaveLength(1)
    expect(getNotifications()[0]?.message).toContain('Implementation')

    stop()
    await sendSessionMessage({
      cwd: workspace,
      senderSessionId: SENDER,
      targetSessionId: TARGET,
      body: 'This should remain queued without a watcher callback.',
    })
    await new Promise(resolve => setTimeout(resolve, 130))
    expect(arrivals).toHaveLength(1)
  })
})
