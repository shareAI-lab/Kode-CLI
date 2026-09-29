import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { createCliProgram } from '#host-cli/entrypoints/cli/cliParser'
import { exitOverrideRecursive } from '../helpers/cliExitOverride'

describe('cli parser (commander)', () => {
  test('--help prints help and exits (no UI started)', () => {
    const program = createCliProgram('', undefined)
    let out = ''
    program.configureOutput({
      writeOut: str => {
        out += str
      },
      writeErr: str => {
        out += str
      },
    })

    exitOverrideRecursive(program)
    try {
      program.parse(['node', 'kode', '--help'], { from: 'user' })
      throw new Error('expected commander to exit')
    } catch (err: any) {
      expect(err.code).toBe('commander.helpDisplayed')
      expect(err.exitCode).toBe(0)
    }

    expect(out).toContain('Usage: kode')
    expect(out).toContain('--print')
    // `--web` / `--web-host` / `--web-port` are registered with
    // `Option.hideHelp()`, so they must NOT be advertised here. They still
    // parse (asserted below) — this previously asserted the opposite and had
    // been failing invisibly, because this file killed the test process.
    expect(out).not.toContain('--web')
  })

  test('--version prints package version and exits (no UI started)', () => {
    const program = createCliProgram('', undefined)
    let out = ''
    program.configureOutput({
      writeOut: str => {
        out += str
      },
      writeErr: str => {
        out += str
      },
    })

    const pkg = JSON.parse(
      readFileSync(join(process.cwd(), 'package.json'), 'utf8'),
    )

    exitOverrideRecursive(program)
    try {
      program.parse(['node', 'kode', '--version'], { from: 'user' })
      throw new Error('expected commander to exit')
    } catch (err: any) {
      expect(err.code).toBe('commander.version')
      expect(err.exitCode).toBe(0)
    }

    expect(out.trim()).toBe(String(pkg.version))
  })

  test('parseOptions picks up --cwd and --print', () => {
    const program = createCliProgram('', undefined)
    program.parseOptions(['--cwd', '/tmp', '--print', '--web'])

    const opts = program.opts() as unknown as {
      cwd: string
      print: boolean
      web: boolean
    }
    expect(opts.cwd).toBe('/tmp')
    expect(opts.print).toBe(true)
    expect(opts.web).toBe(true)
  })
})
