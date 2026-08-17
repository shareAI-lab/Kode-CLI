import { describe, expect, test } from 'bun:test'
import { z } from 'zod'
import { ResponsesAPIAdapter } from '#core/ai/adapters/responsesAPI'

function makeAdapter(): ResponsesAPIAdapter {
  return new ResponsesAPIAdapter({} as any, { modelName: 'gpt-5' } as any)
}

describe('ResponsesAPIAdapter tool schemas', () => {
  test('converts Zod 4 schemas instead of forwarding their internals', () => {
    const [tool] = makeAdapter().buildTools([
      {
        name: 'Read',
        description: 'Read a file',
        inputSchema: z.object({ path: z.string() }),
      } as any,
    ])

    expect(tool.parameters).toMatchObject({
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
    })
    expect(tool.parameters).not.toHaveProperty('def')
  })

  test('rejects Zod schemas that cannot be represented as JSON Schema', () => {
    expect(() =>
      makeAdapter().buildTools([
        {
          name: 'DateTool',
          inputSchema: z.object({ expiresAt: z.date() }),
        } as any,
      ]),
    ).toThrow()
  })

  test('keeps legacy JSON Schema inputs unchanged', () => {
    const inputSchema = {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
    }
    const [tool] = makeAdapter().buildTools([
      { name: 'Read', inputSchema } as any,
    ])

    expect(tool.parameters).toBe(inputSchema)
  })
})
