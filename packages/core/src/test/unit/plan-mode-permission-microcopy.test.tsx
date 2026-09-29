import { describe, expect, test } from 'bun:test'
import { Box, render } from 'ink'
import React from 'react'
import { PassThrough } from 'stream'
import stripAnsi from 'strip-ansi'
import { KeypressProvider } from '#ui-ink/contexts/KeypressContext'
import { PermissionProvider } from '#ui-ink/contexts/PermissionContext'
import { ExitPlanModePermissionRequest } from '#ui-ink/components/permissions/PlanModePermissionRequest/ExitPlanModePermissionRequest'
import { getPlanFilePath } from '#core/utils/planMode'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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
  stdout.columns = 100
  stdout.rows = 30

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

describe('Exit plan mode permission UI microcopy (Esc is exit)', () => {
  test('ExitPlanModePermissionRequest uses "Enter to confirm · Esc to exit" and shows the auto-accept shortcut hint', async () => {
    const previousConfigDir = process.env.KODE_CONFIG_DIR
    const configDir = mkdtempSync(join(tmpdir(), 'kode-plan-perm-'))
    process.env.KODE_CONFIG_DIR = configDir

    try {
      // The auto-accept shortcut hint is only shown once a plan file exists
      // (otherwise the component renders the "no plan" Yes/No fallback), and it
      // is the strict-checking (safe) branch that exposes "auto-accept edits"
      // instead of the permissive "bypass permissions" default.
      writeFileSync(getPlanFilePath(undefined, 'plan:1'), 'Do the thing.')

      const out = await renderToText(
        <KeypressProvider>
          <PermissionProvider
            conversationKey="plan:1"
            isBypassPermissionsModeAvailable
          >
            <ExitPlanModePermissionRequest
              toolUseConfirm={
                {
                  input: { plan: 'Do the thing.' },
                  toolUseContext: {
                    abortController: new AbortController(),
                    messageId: 'm1',
                    readFileTimestamps: {},
                    options: {
                      messageLogName: 'plan',
                      forkNumber: 1,
                      safeMode: true,
                    },
                  },
                  onReject: () => {},
                  onAllow: () => {},
                } as any
              }
              onDone={() => {}}
              verbose={false}
            />
          </PermissionProvider>
        </KeypressProvider>,
      )

      expect(out).toContain('Enter to confirm · Esc to exit')
      expect(out).toMatch(/auto-accept edits \((shift\+tab|alt\+m)\)/)
    } finally {
      if (previousConfigDir === undefined) delete process.env.KODE_CONFIG_DIR
      else process.env.KODE_CONFIG_DIR = previousConfigDir
      rmSync(configDir, { recursive: true, force: true })
    }
  })
})
