import { describe, expect, test } from 'bun:test'
import { z } from 'zod'

import { getToolDescription, resolveToolDescription, type Tool } from './Tool'

const inputSchema = z.object({ path: z.string() })

function makeTool(overrides: Partial<Tool> = {}): Tool {
  return {
    name: 'test-tool',
    inputSchema,
    isEnabled: async () => true,
    isReadOnly: () => false,
    isConcurrencySafe: () => true,
    needsPermissions: () => false,
    prompt: async () => '',
    renderResultForAssistant: () => '',
    renderToolUseMessage: () => null,
    call: async function* () {},
    ...overrides,
  }
}

describe('resolveToolDescription', () => {
  test('returns string description directly', async () => {
    const tool = makeTool({ description: 'A test tool' })
    expect(await resolveToolDescription(tool)).toBe('A test tool')
  })

  test('caches string description', async () => {
    const tool = makeTool({ description: 'Cached desc' })
    await resolveToolDescription(tool)
    expect(tool.cachedDescription).toBe('Cached desc')
  })

  test('resolves async function descriptions', async () => {
    const tool = makeTool({
      description: async () => 'Resolved from function',
    })
    expect(await resolveToolDescription(tool)).toBe('Resolved from function')
  })

  test('falls back to function result when empty', async () => {
    const tool = makeTool({ description: async () => '   ' })
    expect(await resolveToolDescription(tool)).toBe('Tool: test-tool')
  })

  test('falls back to Tool: name when description throws', async () => {
    const tool = makeTool({
      description: async () => {
        throw new Error('boom')
      },
    })
    expect(await resolveToolDescription(tool)).toBe('Tool: test-tool')
  })

  test('falls back to Tool: name when description is missing', async () => {
    const tool = makeTool()
    expect(await resolveToolDescription(tool)).toBe('Tool: test-tool')
  })

  test('skips cache lookup when input is provided', async () => {
    const tool = makeTool({ description: async () => 'fn' })
    await resolveToolDescription(tool, { path: 'a.ts' })
    expect(tool.cachedDescription).toBeUndefined()
  })
})

describe('getToolDescription', () => {
  test('returns cached description first', () => {
    const tool = makeTool({ description: 'original' })
    tool.cachedDescription = 'cached'
    expect(getToolDescription(tool)).toBe('cached')
  })

  test('returns string description', () => {
    expect(getToolDescription(makeTool({ description: 'str' }))).toBe('str')
  })

  test('returns fallback for function descriptions', () => {
    expect(
      getToolDescription(makeTool({ description: async () => 'fn' })),
    ).toBe('Tool: test-tool')
  })
})
