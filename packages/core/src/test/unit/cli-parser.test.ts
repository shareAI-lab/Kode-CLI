import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { createCliProgram } from '#host-cli/entrypoints/cli/cliParser'
import { shouldRunHeadlessMode } from '#host-cli/entrypoints/cli/cliParser/headlessMode'

describe('cli parser (commander)', () => {
  test('help information contains the primary headless flags', () => {
    const program = createCliProgram('', undefined)
    const out = program.helpInformation()

    expect(out).toContain('Usage: kode')
    expect(out).toContain('--print')
    expect(out).toContain('--headless')
  })

  test('version matches the package version', () => {
    const program = createCliProgram('', undefined)
    const pkg = JSON.parse(
      readFileSync(join(process.cwd(), 'package.json'), 'utf8'),
    )
    expect(program.version()).toBe(String(pkg.version))
  })

  test('parseOptions picks up --cwd, --print, and --headless', () => {
    const program = createCliProgram('', undefined)
    program.parseOptions(['--cwd', '/tmp', '--print', '--headless', '--web'])

    const opts = program.opts() as unknown as {
      cwd: string
      print: boolean
      headless: boolean
      web: boolean
    }
    expect(opts.cwd).toBe('/tmp')
    expect(opts.print).toBe(true)
    expect(opts.headless).toBe(true)
    expect(opts.web).toBe(true)
  })

  test('headless mode detection is explicit or safely inferred', () => {
    expect(shouldRunHeadlessMode({ headless: true })).toBe(true)
    expect(shouldRunHeadlessMode({ print: true })).toBe(true)
    expect(shouldRunHeadlessMode({ outputFormat: 'json' })).toBe(true)
    expect(shouldRunHeadlessMode({ outputFormat: ' JSON ' })).toBe(true)
    expect(shouldRunHeadlessMode({ outputFormat: ' STREAM-JSON ' })).toBe(true)
    expect(shouldRunHeadlessMode({ inputFormat: 'stream-json' })).toBe(true)
    expect(shouldRunHeadlessMode({ inputFormat: ' STREAM-JSON ' })).toBe(true)
    expect(
      shouldRunHeadlessMode({
        stdoutIsTTY: false,
        stdinContent: 'hello',
      }),
    ).toBe(true)
    expect(
      shouldRunHeadlessMode({
        stdoutIsTTY: false,
        prompt: 'hello',
      }),
    ).toBe(true)
    expect(
      shouldRunHeadlessMode({
        stdoutIsTTY: true,
        stdinContent: 'hello',
      }),
    ).toBe(false)
    expect(shouldRunHeadlessMode({ stdoutIsTTY: false })).toBe(false)
    expect(
      shouldRunHeadlessMode({
        stdoutIsTTY: false,
        prompt: '   ',
        stdinContent: '\n\t',
      }),
    ).toBe(false)
  })
})
