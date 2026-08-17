import { expect, test } from 'bun:test'
import { z } from 'zod'

import {
  getToolDescription,
  resolveToolDescription,
  type Tool,
} from '#core/tooling/Tool'

function makeBaseTool<TInput extends z.ZodType<any, any>>(
  partial: Pick<Tool<TInput>, 'name' | 'description' | 'inputSchema'>,
): Tool<TInput, { ok: boolean }> {
  return {
    ...partial,
    prompt: async () => 'prompt',
    isEnabled: async () => true,
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    needsPermissions: () => false,
    renderResultForAssistant: () => 'ok',
    renderToolUseMessage: () => 'use',
    call: async function* () {
      yield { type: 'result' as const, data: { ok: true } }
    },
  }
}

test('resolveToolDescription returns and caches string descriptions', async () => {
  const inputSchema = z.object({})
  const tool = makeBaseTool({
    name: 'SyncTool',
    description: 'sync description',
    inputSchema,
  })

  expect(getToolDescription(tool as any)).toBe('sync description')
  expect(await resolveToolDescription(tool)).toBe('sync description')
  expect(tool.cachedDescription).toBe('sync description')
  expect(getToolDescription(tool as any)).toBe('sync description')
})

test('resolveToolDescription awaits async descriptions and caches for adapters', async () => {
  const inputSchema = z.object({})
  let calls = 0

  const tool = makeBaseTool({
    name: 'AsyncTool',
    description: async () => {
      calls += 1
      return 'async description'
    },
    inputSchema,
  })

  expect(getToolDescription(tool as any)).toBe('Tool: AsyncTool')

  expect(await resolveToolDescription(tool)).toBe('async description')
  expect(calls).toBe(1)
  expect(tool.cachedDescription).toBe('async description')
  expect(getToolDescription(tool as any)).toBe('async description')

  expect(await resolveToolDescription(tool)).toBe('async description')
  expect(calls).toBe(1)
})

test('resolveToolDescription fails closed when description throws', async () => {
  const inputSchema = z.object({
    command: z.string(),
  })
  let calls = 0

  const tool = makeBaseTool({
    name: 'NeedsInputTool',
    description: async (input?: { command: string }) => {
      calls += 1
      return `command: ${input!.command}`
    },
    inputSchema,
  })

  expect(await resolveToolDescription(tool)).toBe('Tool: NeedsInputTool')
  expect(calls).toBe(1)

  // Input-specific descriptions should still resolve correctly.
  expect(
    await resolveToolDescription(tool, { command: '/hello' } as never),
  ).toBe('command: /hello')
})
