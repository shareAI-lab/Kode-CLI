import { describe, expect, test } from 'bun:test'
import React from 'react'
import { PassThrough } from 'node:stream'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { render, Text } from 'ink'
import stripAnsi from 'strip-ansi'
import {
  normalizeStatusLineOutput,
  nextStatusLineIntervalMs,
  STATUS_LINE_BASE_INTERVAL_MS,
  STATUS_LINE_MAX_INTERVAL_MS,
  useStatusLine,
} from './useStatusLine'

function makeDelayedStatusLineCommand(label: string, delayMs: number): string {
  if (process.platform === 'win32') {
    const pingCount = Math.max(2, Math.ceil(delayMs / 1000) + 1)
    return `ping -n ${pingCount} 127.0.0.1 > nul && echo ${label}`
  }

  const delaySeconds = Math.max(0.1, delayMs / 1000)
  return `sleep ${delaySeconds}; printf '${label}\\n'`
}

async function waitForStatusLineOutput(
  getOutput: () => string,
  expected: string,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (stripAnsi(getOutput()).includes(expected)) return
    await Bun.sleep(50)
  }
  throw new Error(`Timed out waiting for status line output: ${expected}`)
}

describe('nextStatusLineIntervalMs', () => {
  test('keeps the base interval while output or input changes', () => {
    expect(
      nextStatusLineIntervalMs({
        inputChanged: true,
        outputChanged: false,
        unchangedStreak: 5,
        currentMs: STATUS_LINE_MAX_INTERVAL_MS,
      }),
    ).toBe(STATUS_LINE_BASE_INTERVAL_MS)
    expect(
      nextStatusLineIntervalMs({
        inputChanged: false,
        outputChanged: true,
        unchangedStreak: 5,
        currentMs: STATUS_LINE_MAX_INTERVAL_MS,
      }),
    ).toBe(STATUS_LINE_BASE_INTERVAL_MS)
  })

  test('holds the current interval before the grow streak is reached', () => {
    expect(
      nextStatusLineIntervalMs({
        inputChanged: false,
        outputChanged: false,
        unchangedStreak: 1,
        currentMs: STATUS_LINE_BASE_INTERVAL_MS,
      }),
    ).toBe(STATUS_LINE_BASE_INTERVAL_MS)
  })

  test('grows by 3x after two unchanged ticks and caps at 10s', () => {
    expect(
      nextStatusLineIntervalMs({
        inputChanged: false,
        outputChanged: false,
        unchangedStreak: 2,
        currentMs: STATUS_LINE_BASE_INTERVAL_MS,
      }),
    ).toBe(3_000)
    expect(
      nextStatusLineIntervalMs({
        inputChanged: false,
        outputChanged: false,
        unchangedStreak: 4,
        currentMs: 9_000,
      }),
    ).toBe(STATUS_LINE_MAX_INTERVAL_MS)
    expect(
      nextStatusLineIntervalMs({
        inputChanged: false,
        outputChanged: false,
        unchangedStreak: 9,
        currentMs: STATUS_LINE_MAX_INTERVAL_MS,
      }),
    ).toBe(STATUS_LINE_MAX_INTERVAL_MS)
  })
})

describe('normalizeStatusLineOutput', () => {
  test('keeps status line output to the first non-empty line', () => {
    expect(
      normalizeStatusLineOutput('\n  first status  \nsecond status\n'),
    ).toBe('first status')
  })

  test('returns null for empty output', () => {
    expect(normalizeStatusLineOutput('\n  \r\n')).toBeNull()
  })

  test('reports configured before command output is available', async () => {
    const originalHome = process.env.HOME
    const originalUserProfile = process.env.USERPROFILE
    const originalEnabled = process.env.KODE_STATUSLINE_ENABLED
    const originalConfigDir = process.env.KODE_CONFIG_DIR

    const homeDir = mkdtempSync(join(tmpdir(), 'kode-statusline-hook-'))
    process.env.HOME = homeDir
    process.env.USERPROFILE = homeDir
    process.env.KODE_STATUSLINE_ENABLED = '1'
    process.env.KODE_CONFIG_DIR = join(homeDir, '.kode')
    mkdirSync(join(homeDir, '.kode'), { recursive: true })

    writeFileSync(
      join(homeDir, '.kode', 'settings.json'),
      JSON.stringify(
        {
          statusLine: makeDelayedStatusLineCommand('late-statusline', 800),
        },
        null,
        2,
      ) + '\n',
      'utf8',
    )

    const stdout = new PassThrough() as PassThrough & {
      isTTY?: boolean
      columns?: number
      rows?: number
    }
    stdout.isTTY = true
    stdout.columns = 100
    stdout.rows = 24

    let rawOutput = ''
    stdout.on('data', chunk => {
      rawOutput += chunk.toString('utf8')
    })

    function StatusLineProbe(): React.ReactNode {
      const statusLine = useStatusLine({})
      return React.createElement(
        Text,
        null,
        `CONFIGURED:${String(statusLine.isConfigured)} TEXT:${statusLine.text ?? 'null'}`,
      )
    }

    const instance = render(React.createElement(StatusLineProbe), {
      stdout: stdout as unknown as NodeJS.WriteStream,
      exitOnCtrlC: false,
    })

    try {
      await new Promise(resolve => setTimeout(resolve, 50))
      const output = stripAnsi(rawOutput)

      expect(output).toContain('CONFIGURED:true')
      expect(output).toContain('TEXT:null')
    } finally {
      instance.unmount()

      if (originalHome === undefined) delete process.env.HOME
      else process.env.HOME = originalHome

      if (originalUserProfile === undefined) delete process.env.USERPROFILE
      else process.env.USERPROFILE = originalUserProfile

      if (originalEnabled === undefined)
        delete process.env.KODE_STATUSLINE_ENABLED
      else process.env.KODE_STATUSLINE_ENABLED = originalEnabled

      if (originalConfigDir === undefined) delete process.env.KODE_CONFIG_DIR
      else process.env.KODE_CONFIG_DIR = originalConfigDir

      rmSync(homeDir, { recursive: true, force: true })
    }
  })

  test(
    'lets slow statusline commands finish across interval ticks',
    async () => {
      const originalHome = process.env.HOME
      const originalUserProfile = process.env.USERPROFILE
      const originalEnabled = process.env.KODE_STATUSLINE_ENABLED
      const originalConfigDir = process.env.KODE_CONFIG_DIR

      const homeDir = mkdtempSync(join(tmpdir(), 'kode-statusline-slow-'))
      process.env.HOME = homeDir
      process.env.USERPROFILE = homeDir
      process.env.KODE_STATUSLINE_ENABLED = '1'
      process.env.KODE_CONFIG_DIR = join(homeDir, '.kode')
      mkdirSync(join(homeDir, '.kode'), { recursive: true })

      writeFileSync(
        join(homeDir, '.kode', 'settings.json'),
        JSON.stringify(
          {
            statusLine: makeDelayedStatusLineCommand('slow-statusline', 1300),
          },
          null,
          2,
        ) + '\n',
        'utf8',
      )

      const stdout = new PassThrough() as PassThrough & {
        isTTY?: boolean
        columns?: number
        rows?: number
      }
      stdout.isTTY = true
      stdout.columns = 100
      stdout.rows = 24

      let rawOutput = ''
      stdout.on('data', chunk => {
        rawOutput += chunk.toString('utf8')
      })

      function StatusLineProbe(): React.ReactNode {
        const statusLine = useStatusLine({})
        return React.createElement(
          Text,
          null,
          `CONFIGURED:${String(statusLine.isConfigured)} TEXT:${statusLine.text ?? 'null'}`,
        )
      }

      const instance = render(React.createElement(StatusLineProbe), {
        stdout: stdout as unknown as NodeJS.WriteStream,
        exitOnCtrlC: false,
      })

      try {
        await waitForStatusLineOutput(
          () => rawOutput,
          'TEXT:slow-statusline',
          process.platform === 'win32' ? 8_000 : 5_000,
        )
        const output = stripAnsi(rawOutput)

        expect(output).toContain('CONFIGURED:true')
        expect(output).toContain('TEXT:slow-statusline')
      } finally {
        instance.unmount()

        if (originalHome === undefined) delete process.env.HOME
        else process.env.HOME = originalHome

        if (originalUserProfile === undefined) delete process.env.USERPROFILE
        else process.env.USERPROFILE = originalUserProfile

        if (originalEnabled === undefined)
          delete process.env.KODE_STATUSLINE_ENABLED
        else process.env.KODE_STATUSLINE_ENABLED = originalEnabled

        if (originalConfigDir === undefined) delete process.env.KODE_CONFIG_DIR
        else process.env.KODE_CONFIG_DIR = originalConfigDir

        rmSync(homeDir, { recursive: true, force: true })
      }
    },
    { timeout: 10_000 },
  )
})
