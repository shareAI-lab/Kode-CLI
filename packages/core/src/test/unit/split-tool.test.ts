import { expect, test } from 'bun:test'
import { z } from 'zod'

import { splitLegacyTool } from '#core/tooling/splitTool'
import type { Tool, ToolUseContext } from '#core/tooling/Tool'

test('splitLegacyTool preserves legacy tool behavior via adapter', async () => {
  const inputSchema = z.object({ x: z.string() })

  const tool = {
    name: 'MockTool',
    description: 'mock',
    inputSchema,
    inputJSONSchema: { type: 'object' },
    readModeAccess: 'always' as const,
    readModeInputSchema: z.strictObject({ x: z.string() }),
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
  } satisfies Tool<typeof inputSchema, { ok: boolean }>

  const split = splitLegacyTool(tool)

  expect(split.spec.name).toBe('MockTool')
  expect(split.spec.inputSchema).toBe(inputSchema)
  expect(split.spec.readModeAccess).toBe('always')
  expect(split.spec.readModeInputSchema).toBe(tool.readModeInputSchema)
  expect(await split.spec.isEnabled()).toBe(true)
  expect(
    split.presenter.renderToolUseMessage({ x: 'y' }, { verbose: false }),
  ).toBe('use')

  const out: any[] = []
  const ctx: ToolUseContext = {
    messageId: undefined,
    abortController: new AbortController(),
    readFileTimestamps: {},
  }
  for await (const e of split.runner.call({ x: 'y' }, ctx)) {
    out.push(e)
  }
  expect(out).toEqual([{ type: 'result', data: { ok: true } }])
})

test('splitLegacyTool does not leak async description functions', () => {
  const inputSchema = z.object({})

  const tool = {
    name: 'AsyncDescTool',
    description: async () => 'async description',
    cachedDescription: 'cached description',
    inputSchema,
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
  } satisfies Tool<typeof inputSchema, { ok: boolean }>

  const split = splitLegacyTool(tool)
  expect(split.spec.description).toBe('cached description')
  expect(typeof split.spec.description).not.toBe('function')
})
