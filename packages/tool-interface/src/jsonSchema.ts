import { z } from 'zod'

export type InputJsonSchema = Record<string, unknown>

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Converts a tool's Zod input schema into the draft-07 JSON Schema accepted by
 * the providers and MCP surfaces that Kode supports.
 *
 * Tool calls are validated against their input shape, so transformations and
 * defaults must be represented from their input side rather than their output
 * side. Unsupported JSON-only representations fail closed instead of quietly
 * widening the tool contract.
 */
export function toInputJsonSchema(schema: z.ZodType): InputJsonSchema {
  const jsonSchema = z.toJSONSchema(schema, {
    target: 'draft-07',
    io: 'input',
    unrepresentable: 'throw',
  })

  if (!isRecord(jsonSchema)) {
    throw new TypeError('Tool input schema must convert to a JSON object')
  }

  return jsonSchema
}
