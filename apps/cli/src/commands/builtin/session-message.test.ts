import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { runSessionMessageCommand } from './session-message'
import { getCwd, setCwd } from '#core/utils/state'
import { setSessionId } from '#core/utils/sessionId'
import {
  getKodeAgentSessionId,
  setKodeAgentSessionId,
} from '#protocol/utils/kodeAgentSessionId'
import { getSessionLogFilePath } from '#protocol/utils/kodeAgentSessionLog'

const SENDER = '66666666-6666-4666-8666-666666666666'
const TARGET = '77777777-7777-4777-8777-777777777777'

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
      slug: title.toLowerCase().replaceAll(' ', '-'),
      timestamp: new Date().toISOString(),
      message: { role: 'user', content: title },
    })}\n`,
    { encoding: 'utf8', mode: 0o600 },
  )
}

describe('/session-message command', () => {
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
    configDir = mkdtempSync(join(tmpdir(), 'kode-session-command-config-'))
    workspace = mkdtempSync(join(tmpdir(), 'kode-session-command-workspace-'))
    process.env.KODE_CONFIG_DIR = configDir
    await setCwd(workspace)
    setSessionId(SENDER)
    writeSession(workspace, SENDER, 'Sender')
    writeSession(workspace, TARGET, 'Target')
  })

  afterEach(async () => {
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

  test('lists sessions, sends by short ID, exposes inbox, and reports queued status', async () => {
    const list = await runSessionMessageCommand('list')
    expect(list).toContain(SENDER)
    expect(list).toContain(TARGET)
    expect(list).toContain('/sm send')

    const sent = await runSessionMessageCommand(
      `send ${TARGET.slice(0, 8)} Coordinate on the failing test.`,
    )
    expect(sent).toContain('Queued message')
    expect(sent).toContain(TARGET)
    const messageId = sent.match(/Queued message ([0-9a-f-]+)/i)?.[1]
    expect(messageId).toBeDefined()

    const status = await runSessionMessageCommand(`status ${messageId}`)
    expect(status).toContain('is queued')

    setSessionId(TARGET)
    const inbox = await runSessionMessageCommand('inbox')
    expect(inbox).toContain('Coordinate on the failing test.')
    expect(inbox).toContain(SENDER)
  })

  test('supports threaded replies, searchable history, read state, and cancellation', async () => {
    const sent = await runSessionMessageCommand(
      `send ${TARGET.slice(0, 8)} Please inspect the parser edge case.`,
    )
    const messageId = sent.match(/Queued message ([0-9a-f-]+)/i)?.[1]
    expect(messageId).toBeDefined()

    setSessionId(TARGET)
    const reply = await runSessionMessageCommand(
      `reply ${messageId!.slice(0, 8)} Confirmed with a regression test.`,
    )
    expect(reply).toContain('Queued reply')
    expect(reply).toContain(`Reply to: ${messageId}`)

    const history = await runSessionMessageCommand('history parser')
    expect(history).toContain('Please inspect the parser edge case.')
    expect(history).toContain('[unread]')

    const read = await runSessionMessageCommand(
      `read ${messageId!.slice(0, 8)}`,
    )
    expect(read).toContain('Marked 1 pending message as read.')

    setSessionId(SENDER)
    const cancelled = await runSessionMessageCommand(
      `cancel ${messageId!.slice(0, 8)}`,
    )
    expect(cancelled).toContain('Cancelled queued message')
    expect(
      await runSessionMessageCommand(`status ${messageId!.slice(0, 8)}`),
    ).toContain('Cancelled')
  })
})
