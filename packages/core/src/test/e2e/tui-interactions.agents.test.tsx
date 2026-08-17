import { afterEach, describe, expect, test } from 'bun:test'
import React from 'react'
import { KeypressProvider } from '#ui-ink/contexts/KeypressContext'
import { AgentMenu } from '#host-cli/commands/agent/agents/ui/AgentMenu'
import { AgentsListView } from '#host-cli/commands/agent/agents/ui/AgentsListView'
import { ColorPicker } from '#host-cli/commands/agent/agents/ui/ColorPicker'
import type { AgentWithOverride } from '#host-cli/commands/agent/agents/ui/types'
import { createInkHarnessManager, createInkTestHarness } from './inkTestHarness'

const harnessManager = createInkHarnessManager()

async function waitFor(
  harness: ReturnType<typeof createInkTestHarness>,
  condition: () => boolean,
  description: string,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (condition()) return
    await harness.wait(25)
  }

  throw new Error(
    `Timed out waiting for ${description}: ${harness.getOutput().slice(-4_000)}`,
  )
}

afterEach(async () => {
  await harnessManager.cleanup()
})

function makeAgent(
  agentType: string,
  overrides: Partial<AgentWithOverride> = {},
): AgentWithOverride {
  return {
    agentType,
    whenToUse: 'Use for tests',
    tools: '*',
    systemPrompt: 'Test agent',
    source: 'userSettings',
    location: 'user',
    model: 'sonnet',
    ...overrides,
  }
}

describe('TUI E2E regression (Ink render): Agents', () => {
  test('AgentsListView: Down moves focus through agents after create', async () => {
    const reviewer = makeAgent('reviewer')
    const planner = {
      ...makeAgent('planner'),
      source: 'projectSettings' as const,
      location: 'project' as const,
    }
    let created = 0
    let selected = ''
    const h = createInkTestHarness(
      <KeypressProvider>
        <AgentsListView
          source="all"
          agents={[reviewer, planner]}
          changes={[]}
          onCreateNew={() => {
            created += 1
          }}
          onSelect={value => {
            selected = value.agentType
          }}
          onBack={() => {}}
        />
      </KeypressProvider>,
    )
    harnessManager.track(h)

    await waitFor(h, () => h.getOutput().includes('Create new agent'), 'list')
    h.clearOutput()
    h.stdin.write('\x1b[B')
    await waitFor(h, () => h.getOutput().includes('reviewer'), 'reviewer focus')
    h.clearOutput()
    h.stdin.write('\x1b[B')
    await waitFor(h, () => h.getOutput().includes('planner'), 'planner focus')
    h.stdin.write('\r')
    await waitFor(h, () => selected === 'planner', 'planner selection')

    expect(selected).toBe('planner')
    expect(created).toBe(0)
  })

  test('AgentsListView: shows a configured agent color as a scan marker', async () => {
    const h = createInkTestHarness(
      <KeypressProvider>
        <AgentsListView
          source="all"
          agents={[makeAgent('purple-reviewer', { color: 'purple' })]}
          changes={[]}
          onCreateNew={() => {}}
          onSelect={() => {}}
          onBack={() => {}}
        />
      </KeypressProvider>,
    )
    harnessManager.track(h)

    await waitFor(
      h,
      () => h.getOutput().includes('● purple-reviewer'),
      'agent color marker',
    )

    expect(h.getOutput()).toContain('● purple-reviewer')
  })

  test('ColorPicker: Down advances to the visibly labeled color', async () => {
    let selected = ''
    const h = createInkTestHarness(
      <KeypressProvider>
        <ColorPicker
          agentName="reviewer"
          currentColor="automatic"
          onConfirm={color => {
            selected = color
          }}
        />
      </KeypressProvider>,
    )
    harnessManager.track(h)

    await waitFor(h, () => h.getOutput().includes('Automatic color'), 'picker')
    h.clearOutput()
    h.stdin.write('\x1b[B')
    await waitFor(h, () => h.getOutput().includes('Red'), 'red color focus')

    expect(h.getOutput()).toContain('Red')
    expect(h.getOutput()).toContain('selected')

    h.stdin.write('\r')
    await waitFor(h, () => selected === 'red', 'red color selection')

    expect(selected).toBe('red')
  })

  test('AgentsListView: Down reaches every visible read-only source', async () => {
    const plugin = makeAgent('plugin-reviewer', {
      source: 'plugin',
      location: 'plugin',
    })
    const flag = makeAgent('flag-reviewer', {
      source: 'flagSettings',
      location: 'built-in',
    })
    const builtIn = makeAgent('builtin-reviewer', {
      source: 'built-in',
      location: 'built-in',
    })
    let selected = ''
    const h = createInkTestHarness(
      <KeypressProvider>
        <AgentsListView
          source="all"
          agents={[plugin, flag, builtIn]}
          changes={[]}
          onCreateNew={() => {}}
          onSelect={value => {
            selected = value.agentType
          }}
          onBack={() => {}}
        />
      </KeypressProvider>,
    )
    harnessManager.track(h)

    await waitFor(h, () => h.getOutput().includes('plugin-reviewer'), 'list')
    h.clearOutput()
    h.stdin.write('\x1b[B')
    await waitFor(
      h,
      () => h.getOutput().includes('plugin-reviewer'),
      'plugin focus',
    )
    h.clearOutput()
    h.stdin.write('\x1b[B')
    await waitFor(
      h,
      () => h.getOutput().includes('flag-reviewer'),
      'flag focus',
    )
    h.clearOutput()
    h.stdin.write('\x1b[B')
    await waitFor(
      h,
      () => h.getOutput().includes('builtin-reviewer'),
      'built-in focus',
    )
    h.stdin.write('\r')
    await waitFor(
      h,
      () => selected === 'builtin-reviewer',
      'built-in selection',
    )

    expect(selected).toBe('builtin-reviewer')
  })

  test('AgentMenu: read-only agents expose view-only actions', async () => {
    const h = createInkTestHarness(
      <KeypressProvider>
        <AgentMenu
          agent={makeAgent('plugin-reviewer', {
            source: 'plugin',
            location: 'plugin',
          })}
          onChoose={() => {}}
          onCancel={() => {}}
        />
      </KeypressProvider>,
    )
    harnessManager.track(h)

    await waitFor(h, () => h.getOutput().includes('Read-only agent'), 'menu')
    const output = h.getOutput()

    expect(output).toContain('Read-only agent')
    expect(output).toContain('View agent')
    expect(output).toContain('Back')
    expect(output).not.toContain('Edit agent')
    expect(output).not.toContain('Delete agent')
  })
})
