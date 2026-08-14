export type McpName = string

export function sanitizeMcpIdentifierPart(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, '_')
}

export function getMcpServerConnectionBatchSize(): number {
  const raw = process.env.MCP_SERVER_CONNECTION_BATCH_SIZE
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN
  if (Number.isFinite(parsed) && parsed > 0 && parsed <= 50) return parsed
  return 3
}

export function getMcpToolTimeoutMs(): number | null {
  const raw = process.env.MCP_TOOL_TIMEOUT
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN
  if (!Number.isFinite(parsed) || parsed <= 0) return null
  return parsed
}

export const IDE_MCP_TOOL_ALLOWLIST = new Set([
  'mcp__ide__executeCode',
  'mcp__ide__getDiagnostics',
])
