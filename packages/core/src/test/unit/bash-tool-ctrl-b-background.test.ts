import { describe, expect, test } from 'bun:test'
import { join } from 'path'
import { BashTool } from '#tools/tools/system/BashTool/BashTool'
import { BunShell } from '#runtime/shell'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'

function makeContext(overrides?: Partial<any>): any {
  return {
    abortController: new AbortController(),
    messageId: 'test',
    safeMode: false,
    options: {
      safeMode: false,
      verbose: false,
      tools: [],
      commands: [],
      forkNumber: 0,
      messageLogName: 'bash-tool-ctrl-b-test',
      maxThinkingTokens: 0,
      bashLlmGateQuery: async () => {
        return 'ALLOW'
      },
    },
    readFileTimestamps: {},
    ...overrides,
  }
}

/**
 * Poll until `predicate` holds. Fixed sleeps made this test flaky on loaded CI
 * runners: the background shell needs an unpredictable amount of time to write
 * its first output and to exit.
 */
async function waitFor(
  predicate: () => boolean,
  what: string,
  timeoutMs = 20_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for ${what}`)
}

describe('BashTool ctrl+b backgrounding parity (Reference CLI K41 + gH5)', () => {
  test('shows ctrl+b hint after the initial delay', async () => {
    if (process.platform === 'win32') return
    const configDir = mkdtempSync(join(tmpdir(), 'kode-config-'))
    process.env.KODE_CONFIG_DIR = configDir

    try {
      BunShell.restart()

      const toolJSXCalls: Array<{ at: number; value: any }> = []
      const startedAt = Date.now()
      const ctx = makeContext({
        setToolJSX: (value: any) => {
          toolJSXCalls.push({ at: Date.now(), value })
        },
      })

      const gen = BashTool.call(
        { command: 'sleep 3', description: 'Wait briefly', timeout: 10_000 },
        ctx,
      )
      for await (const _ev of gen) {
        // drain
      }

      const firstNonNull = toolJSXCalls.find(c => c.value !== null)
      expect(firstNonNull).toBeTruthy()
      expect(firstNonNull!.value.shouldHidePromptInput).toBe(false)
      expect(firstNonNull!.at - startedAt).toBeGreaterThanOrEqual(1800)
    } finally {
      rmSync(configDir, { recursive: true, force: true })
    }
  })

  test('can request background and returns a background id', async () => {
    if (process.platform === 'win32') return
    const configDir = mkdtempSync(join(tmpdir(), 'kode-config-'))
    process.env.KODE_CONFIG_DIR = configDir

    try {
      BunShell.restart()

      let triggered = false
      const ctx = makeContext({
        setToolJSX: (value: any) => {
          if (triggered) return
          if (!value || !value.jsx) return
          const jsx: any = value.jsx
          const onBackground = jsx?.props?.onBackground
          if (typeof onBackground !== 'function') return
          triggered = true
          setTimeout(() => onBackground(), 0)
        },
      })

      const gen = BashTool.call(
        {
          command:
            'i=0; while [ $i -lt 30 ]; do i=$((i+1)); echo "tick-$i"; sleep 0.1; done',
          description: 'Emit progress ticks',
          timeout: 30_000,
        },
        ctx,
      )

      const events: any[] = []
      for await (const ev of gen) events.push(ev)

      const result = events.find(e => e.type === 'result')
      expect(result).toBeTruthy()
      expect(result.data.bashId).toBeTruthy()
      expect(result.data.backgroundTaskId).toBe(result.data.bashId)

      const bashId = result.data.bashId as string

      // `readBackgroundOutput` is consuming: it returns the output produced
      // since the previous call. Capture each chunk from inside the predicate so
      // polling does not consume the value the assertion needs.
      let first: ReturnType<
        ReturnType<typeof BunShell.getInstance>['readBackgroundOutput']
      > = null
      await waitFor(() => {
        first = BunShell.getInstance().readBackgroundOutput(bashId)
        return (first?.stdout ?? '') !== ''
      }, 'the first background output chunk')
      expect(first?.stdout).not.toBe('')

      let second: typeof first = null
      await waitFor(() => {
        second = BunShell.getInstance().readBackgroundOutput(bashId)
        return (second?.stdout ?? '') !== ''
      }, 'a subsequent background output chunk')
      expect(second?.stdout).not.toBe('')

      // The command runs ~3s; poll for completion instead of guessing.
      await waitFor(
        () => BunShell.getInstance().getBackgroundOutput(bashId)?.code === 0,
        'the background command to exit with code 0',
      )
      const final = BunShell.getInstance().getBackgroundOutput(bashId)
      expect(final?.code).toBe(0)
    } finally {
      rmSync(configDir, { recursive: true, force: true })
    }
  })

  test('foreground execution still works when not backgrounded', async () => {
    const configDir = mkdtempSync(join(tmpdir(), 'kode-config-'))
    process.env.KODE_CONFIG_DIR = configDir

    try {
      BunShell.restart()
      const ctx = makeContext()

      const events: any[] = []
      for await (const ev of BashTool.call(
        {
          command: 'echo hello',
          description: 'Print greeting',
          timeout: 10_000,
        },
        ctx,
      )) {
        events.push(ev)
      }

      const result = events.find(e => e.type === 'result')
      expect(result).toBeTruthy()
      expect(result.data.bashId).toBeUndefined()
      expect(result.data.backgroundTaskId).toBeUndefined()
    } finally {
      rmSync(configDir, { recursive: true, force: true })
    }
  })
})
