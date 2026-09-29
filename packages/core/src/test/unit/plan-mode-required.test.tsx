import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Box, Text, render } from 'ink'
import React from 'react'
import { PassThrough } from 'stream'
import stripAnsi from 'strip-ansi'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  applyToolPermissionContextUpdateForConversationKey,
  __resetToolPermissionContextStateForTests,
} from '#core/utils/toolPermissionContextState'
import {
  PermissionProvider,
  usePermissionContext,
  __applyPermissionModeSideEffectsForTests,
} from '#ui-ink/contexts/PermissionContext'
import { isPlanModeEnabled } from '#core/utils/planMode'

async function renderToText(element: React.ReactElement): Promise<string> {
  const stdin = new PassThrough() as PassThrough & {
    isTTY?: boolean
    isRaw?: boolean
    setRawMode?: (enabled: boolean) => void
  }
  stdin.isTTY = true
  stdin.isRaw = true
  stdin.setRawMode = () => {}
  stdin.setEncoding('utf8')
  stdin.resume()

  const stdout = new PassThrough() as PassThrough & {
    isTTY?: boolean
    columns?: number
    rows?: number
  }
  stdout.isTTY = true
  stdout.columns = 80
  stdout.rows = 24

  let rawOutput = ''
  stdout.on('data', chunk => {
    rawOutput += chunk.toString('utf8')
  })

  const instance = render(<Box>{element}</Box>, {
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream,
    exitOnCtrlC: false,
  })

  await new Promise(resolve => setTimeout(resolve, 0))
  instance.unmount()

  return stripAnsi(rawOutput)
}

function ModeProbe() {
  const { currentMode } = usePermissionContext()
  return <Text>{currentMode}</Text>
}

describe('plan mode required (startup parity)', () => {
  let tmpConfigDir: string
  let previousConfigDir: string | undefined
  let previousPlanModeRequired: string | undefined
  let previousLegacyPlanModeRequired: string | undefined

  beforeEach(() => {
    __resetToolPermissionContextStateForTests()

    tmpConfigDir = mkdtempSync(join(tmpdir(), 'kode-plan-mode-required-'))
    previousConfigDir = process.env.KODE_CONFIG_DIR
    previousPlanModeRequired = process.env.KODE_PLAN_MODE_REQUIRED
    previousLegacyPlanModeRequired = process.env.CLAUDE_CODE_PLAN_MODE_REQUIRED

    process.env.KODE_CONFIG_DIR = tmpConfigDir
    process.env.KODE_PLAN_MODE_REQUIRED = 'true'
    delete process.env.CLAUDE_CODE_PLAN_MODE_REQUIRED
  })

  afterEach(() => {
    if (previousConfigDir === undefined) delete process.env.KODE_CONFIG_DIR
    else process.env.KODE_CONFIG_DIR = previousConfigDir

    if (previousPlanModeRequired === undefined)
      delete process.env.KODE_PLAN_MODE_REQUIRED
    else process.env.KODE_PLAN_MODE_REQUIRED = previousPlanModeRequired

    if (previousLegacyPlanModeRequired === undefined)
      delete process.env.CLAUDE_CODE_PLAN_MODE_REQUIRED
    else
      process.env.CLAUDE_CODE_PLAN_MODE_REQUIRED =
        previousLegacyPlanModeRequired

    rmSync(tmpConfigDir, { recursive: true, force: true })
  })

  test('forces initial permission mode to plan once', async () => {
    const conversationKey = `test-plan-required-${Date.now()}:0`
    const messageLogName = conversationKey.split(':')[0] ?? conversationKey

    const out = await renderToText(
      <PermissionProvider
        conversationKey={conversationKey}
        isBypassPermissionsModeAvailable={true}
      >
        <ModeProbe />
      </PermissionProvider>,
    )

    expect(out).toContain('plan')
    expect(
      isPlanModeEnabled({
        options: { messageLogName, forkNumber: 0 },
      } as any),
    ).toBe(true)

    applyToolPermissionContextUpdateForConversationKey({
      conversationKey,
      isBypassPermissionsModeAvailable: true,
      update: { type: 'setMode', mode: 'acceptEdits', destination: 'session' },
    })
    __applyPermissionModeSideEffectsForTests({
      conversationKey,
      previousMode: 'plan',
      nextMode: 'acceptEdits',
      recordPlanModeUse: false,
    })

    const out2 = await renderToText(
      <PermissionProvider
        conversationKey={conversationKey}
        isBypassPermissionsModeAvailable={true}
      >
        <ModeProbe />
      </PermissionProvider>,
    )

    expect(out2).toContain('acceptEdits')
    expect(
      isPlanModeEnabled({
        options: { messageLogName, forkNumber: 0 },
      } as any),
    ).toBe(false)
  })
})
