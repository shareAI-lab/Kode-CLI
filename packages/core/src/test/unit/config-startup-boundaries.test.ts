import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConfigParseError as CoreConfigParseError } from '#core/utils/errors'
import {
  getCwd as getConfigCwd,
  resetCwdProviderForTesting,
  setCwdProvider,
} from '#config/cwd'
import { clearConfigCacheForTesting, getGlobalConfig } from '#config/loader'
import { ConfigParseError as ConfigPackageParseError } from '#config/errors'

describe('config startup boundaries', () => {
  afterEach(() => {
    resetCwdProviderForTesting()
    clearConfigCacheForTesting()
  })

  test('uses one ConfigParseError constructor across core and config', () => {
    const error = new ConfigPackageParseError('invalid json', 'config.json', {})

    expect(CoreConfigParseError).toBe(ConfigPackageParseError)
    expect(error).toBeInstanceOf(CoreConfigParseError)
  })

  test('allows config cwd to be supplied by the host runtime', () => {
    setCwdProvider(() => '/tmp/kode-config-cwd')

    expect(getConfigCwd()).toBe('/tmp/kode-config-cwd')
  })

  test('debug config metadata never emits config file contents', () => {
    const configDir = mkdtempSync(join(tmpdir(), 'kode-config-debug-'))
    const previousConfigDir = process.env.KODE_CONFIG_DIR
    const previousDebug = process.env.KODE_DEBUG_CONFIG
    const previousNodeEnv = process.env.NODE_ENV
    const originalConsoleError = console.error
    const output: string[] = []
    const fixtureSecret = 'CONFIG_TEST_SECRET_MUST_NOT_BE_LOGGED'

    process.env.KODE_CONFIG_DIR = configDir
    process.env.KODE_DEBUG_CONFIG = '1'
    // getGlobalConfig intentionally uses an in-memory object under NODE_ENV=test.
    // Use an isolated temporary directory to exercise the actual file-read path.
    process.env.NODE_ENV = 'development'
    writeFileSync(
      join(configDir, 'config.json'),
      JSON.stringify({ modelProfiles: [{ apiKey: fixtureSecret }] }),
      'utf8',
    )
    console.error = (...args: unknown[]) => output.push(args.join(' '))

    try {
      clearConfigCacheForTesting()
      getGlobalConfig()

      expect(output.join('\n')).toContain('CONFIG_FILE_READ')
      expect(output.join('\n')).not.toContain(fixtureSecret)
      expect(output.join('\n')).not.toContain('contentPreview')
    } finally {
      console.error = originalConsoleError
      if (previousConfigDir === undefined) delete process.env.KODE_CONFIG_DIR
      else process.env.KODE_CONFIG_DIR = previousConfigDir
      if (previousDebug === undefined) delete process.env.KODE_DEBUG_CONFIG
      else process.env.KODE_DEBUG_CONFIG = previousDebug
      if (previousNodeEnv === undefined) delete process.env.NODE_ENV
      else process.env.NODE_ENV = previousNodeEnv
      clearConfigCacheForTesting()
      rmSync(configDir, { recursive: true, force: true })
    }
  })
})
