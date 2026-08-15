import { afterEach, describe, expect, test } from 'bun:test'
import { render } from 'ink'
import React from 'react'
import { PassThrough } from 'node:stream'
import stripAnsi from 'strip-ansi'
import { ASCII_LOGO, PRODUCT_NAME } from '#core/constants/product'
import { getCommandShortcutHints } from '#ui-ink/utils/commandShortcutHints'
import { Logo } from './Logo'

type TestHarness = {
  unmount: () => void
  rerender: (element: React.ReactElement) => void
  getOutput: () => string
  getRawOutput: () => string
  wait: (ms: number) => Promise<void>
}

const mounted: TestHarness[] = []
const firstLogoLine = ASCII_LOGO.trim().split(/\r?\n/)[0]!
const firstLogoPrefix = firstLogoLine.slice(0, 24)
const productNameFallback = `${PRODUCT_NAME.toUpperCase()} CLI`

afterEach(() => {
  while (mounted.length > 0) {
    mounted.pop()?.unmount()
  }
})

function createHarness(element: React.ReactElement): TestHarness {
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

  const instance = render(element, {
    stdout: stdout as unknown as NodeJS.WriteStream,
    exitOnCtrlC: false,
  })

  const harness: TestHarness = {
    unmount: () => instance.unmount(),
    rerender: element => instance.rerender(element),
    getOutput: () => stripAnsi(rawOutput),
    getRawOutput: () => rawOutput,
    wait: async ms => new Promise(resolve => setTimeout(resolve, ms)),
  }
  mounted.push(harness)
  return harness
}

describe('Logo', () => {
  test('uses compact surrounding layout while keeping the configured logo', async () => {
    const harness = createHarness(
      <Logo
        mcpClients={[{ type: 'connected', name: 'codegraph' }]}
        terminalColumns={40}
        terminalRows={12}
      />,
    )

    await harness.wait(20)
    const output = harness.getOutput().trimEnd()

    expect(output).toContain(firstLogoPrefix)
    expect(output).not.toContain(productNameFallback)
    expect(output).toContain('/config')
    expect(output).toContain('MCP Servers')
    expect(output).toContain('codegraph')
    expect(output).not.toMatch(/(?:\n\s*){4,}/)
    expect(
      Math.max(...output.split(/\r?\n/).map(line => line.length)),
    ).toBeLessThanOrEqual(40)
  })

  test('keeps the full logo on standard 80x24 terminals', async () => {
    const harness = createHarness(
      <Logo
        mcpClients={[{ type: 'connected', name: 'codegraph' }]}
        terminalColumns={80}
        terminalRows={24}
      />,
    )

    await harness.wait(20)
    const output = harness.getOutput().trimEnd()

    expect(output).toContain(firstLogoLine)
    expect(output).toContain('codegraph')
    expect(output).not.toContain(productNameFallback)
    expect(output).not.toMatch(/(?:\n\s*){4,}/)
  })

  test('keeps the full logo on normal-height wide terminals', async () => {
    const harness = createHarness(
      <Logo mcpClients={[]} terminalColumns={100} terminalRows={30} />,
    )

    await harness.wait(20)
    const output = harness.getOutput()

    expect(output).toContain(firstLogoLine)
    expect(output).not.toContain(productNameFallback)
    expect(output).not.toMatch(/(?:\n\s*){4,}/)
  })

  test('renders command effects and model/editor keys without dimming them', async () => {
    const harness = createHarness(
      <Logo mcpClients={[]} terminalColumns={120} terminalRows={24} />,
    )
    const { commands, shortcuts } = getCommandShortcutHints()

    await harness.wait(20)
    const output = harness.getOutput()
    const rawCommandLine = harness
      .getRawOutput()
      .split(/\r?\n/)
      .find(line => stripAnsi(line).includes('Commands'))

    for (const command of commands) {
      expect(output).toContain(`${command.trigger} ${command.effect}`)
    }
    for (const shortcut of shortcuts) {
      expect(output).toContain(`${shortcut.trigger} ${shortcut.effect}`)
    }
    expect(rawCommandLine).toBeDefined()
    expect(rawCommandLine).not.toContain('\u001B[2m')
  })

  test('keeps the full logo on tall spacious terminals', async () => {
    const harness = createHarness(
      <Logo mcpClients={[]} terminalColumns={100} terminalRows={40} />,
    )

    await harness.wait(20)
    const output = harness.getOutput()

    expect(output.trimEnd().startsWith(firstLogoLine)).toBe(true)
    expect(output).toContain(firstLogoLine)
    expect(output).not.toContain(productNameFallback)
  })

  test('keeps the configured logo when dimensions cross the compact threshold', async () => {
    const harness = createHarness(
      <Logo mcpClients={[]} terminalColumns={40} terminalRows={12} />,
    )

    await harness.wait(20)
    expect(harness.getOutput()).toContain(firstLogoPrefix)

    harness.rerender(
      <Logo mcpClients={[]} terminalColumns={100} terminalRows={30} />,
    )
    await harness.wait(20)

    const output = harness.getOutput()
    expect(output).toContain(firstLogoPrefix)
    expect(output).not.toContain(productNameFallback)
  })

  test('uses a short startup header on low-height terminals', async () => {
    const harness = createHarness(
      <Logo
        mcpClients={[{ type: 'connected', name: 'codegraph' }]}
        terminalColumns={80}
        terminalRows={8}
      />,
    )

    await harness.wait(20)
    const output = harness.getOutput().trimEnd()

    expect(output).toContain(productNameFallback)
    expect(output).not.toContain(firstLogoPrefix)
    expect(output).toContain('/config')
    expect(output).toContain('MCP Servers:')
    expect(output).toContain('codegraph')
    expect(output.split(/\r?\n/).filter(Boolean)).toHaveLength(3)
  })

  test('hides MCP server names on very low-height terminals', async () => {
    const harness = createHarness(
      <Logo
        mcpClients={[{ type: 'connected', name: 'codegraph' }]}
        terminalColumns={80}
        terminalRows={5}
      />,
    )

    await harness.wait(20)
    const output = harness.getOutput().trimEnd()

    expect(output).toContain(productNameFallback)
    expect(output).toContain('MCP: 1 connected')
    expect(output).not.toContain('codegraph')
    expect(output.split(/\r?\n/).filter(Boolean)).toHaveLength(3)
  })
})
