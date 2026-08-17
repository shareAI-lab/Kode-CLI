import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import React from 'react'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { KeypressProvider } from '#ui-ink/contexts/KeypressContext'
import { SessionMessageScreen } from '#ui-ink/screens/overlays/SessionMessageScreen'
import { peekSessionMessages } from '#protocol/sessionMessaging'
import { getSessionLogFilePath } from '#protocol/utils/kodeAgentSessionLog'
import { createInkHarnessManager, createInkTestHarness } from './inkTestHarness'

const SENDER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const TARGET = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const harnessManager = createInkHarnessManager()

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
    })}\n${JSON.stringify({
      type: 'custom-title',
      sessionId,
      customTitle: title,
    })}\n`,
    { encoding: 'utf8', mode: 0o600 },
  )
}

describe('TUI E2E: SessionMessageScreen', () => {
  const originalConfigDir = process.env.KODE_CONFIG_DIR
  let configDir: string
  let workspace: string

  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), 'kode-session-screen-config-'))
    workspace = mkdtempSync(join(tmpdir(), 'kode-session-screen-workspace-'))
    process.env.KODE_CONFIG_DIR = configDir
    writeSession(workspace, SENDER, 'Current implementation')
    writeSession(workspace, TARGET, 'Security reviewer')
  })

  afterEach(async () => {
    await harnessManager.cleanup()
    if (originalConfigDir === undefined) delete process.env.KODE_CONFIG_DIR
    else process.env.KODE_CONFIG_DIR = originalConfigDir
    rmSync(configDir, { recursive: true, force: true })
    rmSync(workspace, { recursive: true, force: true })
  })

  test('selects a session, composes, sends, and shows threaded history', async () => {
    const h = createInkTestHarness(
      <KeypressProvider>
        <SessionMessageScreen
          cwd={workspace}
          sessionId={SENDER}
          onDone={() => {}}
        />
      </KeypressProvider>,
    )
    harnessManager.track(h)

    await h.wait(80)
    expect(h.getOutput()).toContain('Session Messages')
    expect(h.getOutput()).toContain('Press n to start')

    h.stdin.write('n')
    await h.wait(40)
    expect(h.getOutput()).toContain('Select a session')
    expect(h.getOutput()).toContain('Security reviewer')

    h.stdin.write('\r')
    await h.wait(40)
    expect(h.getOutput()).toContain('New message to Security reviewer')

    h.stdin.write('Please verify the cancellation race.')
    await h.wait(100)
    h.stdin.write('\r')
    await h.wait(120)

    expect(h.getOutput()).toContain('Queued')
    expect(h.getOutput()).toContain('Please verify the cancellation race.')
    expect(
      (await peekSessionMessages({ cwd: workspace, sessionId: TARGET }))[0]
        ?.body,
    ).toBe('Please verify the cancellation race.')
  })
})
