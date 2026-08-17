import { describe, expect, test } from 'bun:test'

describe('terminalSetup module resolution', () => {
  test('terminalSetup module can be imported without errors', async () => {
    let importError: Error | null = null
    try {
      await import('#cli-commands/builtin/terminal-setup')
    } catch (e) {
      importError = e instanceof Error ? e : new Error(String(e))
    }
    expect(importError).toBeNull()
  })

  test('terminalSetup exports a default command', async () => {
    const mod = await import('#cli-commands/builtin/terminal-setup')
    expect(mod.default).toBeDefined()
    expect(mod.default.name).toBe('terminal-setup')
    expect(mod.default.type).toBe('local-jsx')
  })

  test('hash command helper remains importable', async () => {
    const mod = await import('#core/utils/hashCommand')
    expect(typeof mod.handleHashCommand).toBe('function')
  })

  test('terminalSetup command has correct metadata', async () => {
    const mod = await import('#cli-commands/builtin/terminal-setup')
    const cmd = mod.default
    expect(cmd.description).toContain('Shift+Enter')
    expect(cmd.isHidden).toBe(true)
    expect(typeof cmd.call).toBe('function')
  })
})
