import { describe, expect, test } from 'bun:test'
import React from 'react'
import { PassThrough } from 'node:stream'
import { render } from 'ink'
import stripAnsi from 'strip-ansi'
import { TokenWarning, computeTokenWarningState } from './TokenWarning'

// A 200k window with the default 0.1 reserve ratio (cap 20k) yields an
// effective limit of 180k; the auto-compact boundary is 180k - 13k = 167k.
const CONTEXT_LIMIT = 200_000
const EFFECTIVE_LIMIT = 180_000
const SAFE_THRESHOLD = 167_000
const WARNING_THRESHOLD = SAFE_THRESHOLD - 20_000 // 147_000
const ERROR_THRESHOLD = SAFE_THRESHOLD - 5_000 // 162_000

describe('computeTokenWarningState', () => {
  test('returns null below the warning band', () => {
    expect(
      computeTokenWarningState({
        tokenUsage: 100_000,
        contextLimit: CONTEXT_LIMIT,
      }),
    ).toBeNull()
    expect(
      computeTokenWarningState({
        tokenUsage: WARNING_THRESHOLD - 1,
        contextLimit: CONTEXT_LIMIT,
      }),
    ).toBeNull()
  })

  test('is a warning (not error) inside the warning band', () => {
    const state = computeTokenWarningState({
      tokenUsage: WARNING_THRESHOLD + 5_000, // 152_000
      contextLimit: CONTEXT_LIMIT,
    })
    expect(state).not.toBeNull()
    expect(state?.isError).toBe(false)
  })

  test('escalates to error inside the error band', () => {
    const state = computeTokenWarningState({
      tokenUsage: ERROR_THRESHOLD + 500, // 162_500
      contextLimit: CONTEXT_LIMIT,
    })
    expect(state?.isError).toBe(true)
  })

  test('percent and fraction share the effective context limit', () => {
    const state = computeTokenWarningState({
      tokenUsage: 160_000,
      contextLimit: CONTEXT_LIMIT,
    })
    const percent = Math.round((160_000 / EFFECTIVE_LIMIT) * 100)
    expect(state?.text).toContain(`${100 - percent}% remaining`)
    expect(state?.text).toContain('160k/180k')
  })
})

describe('TokenWarning render', () => {
  test('renders the warning text inside the warning band', async () => {
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

    const instance = render(
      <TokenWarning tokenUsage={152_000} contextLimit={CONTEXT_LIMIT} />,
      { stdout: stdout as unknown as NodeJS.WriteStream, exitOnCtrlC: false },
    )

    await new Promise(resolve => setTimeout(resolve, 30))
    instance.unmount()

    const output = stripAnsi(rawOutput)
    expect(output).toContain('Context low')
    expect(output).toContain('152k/180k')
  })

  test('renders nothing below the warning band', async () => {
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

    const instance = render(
      <TokenWarning tokenUsage={100_000} contextLimit={CONTEXT_LIMIT} />,
      { stdout: stdout as unknown as NodeJS.WriteStream, exitOnCtrlC: false },
    )

    await new Promise(resolve => setTimeout(resolve, 30))
    instance.unmount()

    expect(stripAnsi(rawOutput).trim()).toBe('')
  })
})
