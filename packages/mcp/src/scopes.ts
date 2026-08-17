export const VALID_SCOPES = ['project', 'global', 'mcprc', 'mcpjson'] as const
export type ConfigScope = (typeof VALID_SCOPES)[number]
export const EXTERNAL_SCOPES = [
  'project',
  'global',
  'mcprc',
  'mcpjson',
] as const satisfies readonly ConfigScope[]

export function ensureConfigScope(scope?: string): ConfigScope {
  if (!scope) return 'project'

  const scopesToCheck =
    process.env.USER_TYPE === 'external' ? EXTERNAL_SCOPES : VALID_SCOPES

  if (!scopesToCheck.includes(scope as ConfigScope)) {
    throw new Error(
      `Invalid scope: ${scope}. Must be one of: ${scopesToCheck.join(', ')}`,
    )
  }

  return scope as ConfigScope
}
