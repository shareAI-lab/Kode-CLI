import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createCliProgram } from '#host-cli/entrypoints/cli/cliParser'

describe('CLI integration: models list', () => {
  test('`kode models list --json` prints JSON without requiring network', async () => {
    const configDir = mkdtempSync(join(tmpdir(), 'kode-config-models-list-'))

    const previousConfigDir = process.env.KODE_CONFIG_DIR
    const previousExitCode = process.exitCode
    process.env.KODE_CONFIG_DIR = configDir

    const stdout: string[] = []
    const stderr: string[] = []

    const originalLog = console.log
    const originalError = console.error
    try {
      console.log = (...args: any[]) => {
        stdout.push(args.join(' '))
      }
      console.error = (...args: any[]) => {
        stderr.push(args.join(' '))
      }

      const program = createCliProgram('', undefined)
      await program.parseAsync(['models', 'list', '--json'], { from: 'user' })

      expect(process.exitCode ?? 0).toBe(0)

      const text = stdout.join('\n').trim()
      const parsed = JSON.parse(text)
      expect(parsed).toHaveProperty('pointers')
      expect(Array.isArray(parsed.pointers)).toBe(true)
      expect(parsed).toHaveProperty('profiles')
      expect(Array.isArray(parsed.profiles)).toBe(true)
    } finally {
      console.log = originalLog
      console.error = originalError

      if (previousConfigDir === undefined) delete process.env.KODE_CONFIG_DIR
      else process.env.KODE_CONFIG_DIR = previousConfigDir

      process.exitCode = previousExitCode

      try {
        rmSync(configDir, { recursive: true, force: true })
      } catch {
        /* no-op */
      }
    }
  })
})
