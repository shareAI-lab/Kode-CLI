import { expect, test } from 'bun:test'
import { z } from 'zod'
import { toInputJsonSchema } from '@kode/tool-interface/jsonSchema'

test('toInputJsonSchema exports draft-07 tool input constraints', () => {
  const schema = z.strictObject({
    required: z.string(),
    optional: z.string().optional(),
    defaulted: z.string().default('kode'),
  })

  expect(toInputJsonSchema(schema)).toEqual({
    $schema: 'http://json-schema.org/draft-07/schema#',
    type: 'object',
    properties: {
      required: { type: 'string' },
      optional: { type: 'string' },
      defaulted: { default: 'kode', type: 'string' },
    },
    required: ['required'],
    additionalProperties: false,
  })
})

test('toInputJsonSchema rejects unrepresentable tool schemas', () => {
  expect(() => toInputJsonSchema(z.object({ expiresAt: z.date() }))).toThrow(
    'Date cannot be represented in JSON Schema',
  )
})
