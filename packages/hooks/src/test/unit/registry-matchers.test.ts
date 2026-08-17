import { describe, expect, test } from 'bun:test'

import { buildHookExecEnv } from '../../hookEnv'
import { matcherMatchesTool } from '../../registry'

describe('matcherMatchesTool', () => {
  test('wildcard matches everything', () => {
    expect(matcherMatchesTool('*', 'BashTool')).toBe(true)
    expect(matcherMatchesTool('all', 'ReadTool')).toBe(true)
  })

  test('exact name match', () => {
    expect(matcherMatchesTool('BashTool', 'BashTool')).toBe(true)
    expect(matcherMatchesTool('BashTool', 'ReadTool')).toBe(false)
  })

  test('minimatch glob patterns', () => {
    expect(matcherMatchesTool('*Tool', 'BashTool')).toBe(true)
    expect(matcherMatchesTool('Read*', 'ReadTool')).toBe(true)
    expect(matcherMatchesTool('Read*', 'BashTool')).toBe(false)
  })

  test('regex patterns', () => {
    expect(matcherMatchesTool('^Bash', 'BashTool')).toBe(true)
    expect(matcherMatchesTool('^Bash$', 'BashTool')).toBe(false)
  })

  test('invalid matchers never throw and return false', () => {
    expect(matcherMatchesTool('', 'BashTool')).toBe(false)
    expect(matcherMatchesTool('[invalid', 'BashTool')).toBe(false)
  })
})

describe('buildHookExecEnv', () => {
  test('always sets project dir (modern and legacy)', () => {
    const env = buildHookExecEnv({ projectDir: '/tmp/proj' })
    expect(env.KODE_PROJECT_DIR).toBe('/tmp/proj')
    expect(env.CLAUDE_PROJECT_DIR).toBe('/tmp/proj')
  })

  test('includes plugin root when provided', () => {
    const env = buildHookExecEnv({
      projectDir: '/tmp/proj',
      pluginRoot: '/tmp/plugin',
    })
    expect(env.KODE_PLUGIN_ROOT).toBe('/tmp/plugin')
  })

  test('includes env file when provided', () => {
    const env = buildHookExecEnv({
      projectDir: '/tmp/proj',
      envFilePath: '/tmp/.env',
    })
    expect(env.KODE_ENV_FILE).toBe('/tmp/.env')
  })

  test('omits optional keys when absent', () => {
    const env = buildHookExecEnv({ projectDir: '/tmp/proj' })
    expect(env.KODE_PLUGIN_ROOT).toBeUndefined()
    expect(env.KODE_ENV_FILE).toBeUndefined()
  })
})
