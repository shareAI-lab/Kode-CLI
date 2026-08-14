/**
 * Experimental features must be explicitly enabled at process startup so they
 * never appear in normal command discovery by accident.
 */
export const EXPERIMENTAL_VOICE_ENV = 'KODE_EXPERIMENTAL_VOICE'
export const EXPERIMENTAL_MCP_SAMPLING_ENV = 'KODE_EXPERIMENTAL_MCP_SAMPLING'

const ENABLED_VALUES = new Set(['1', 'true', 'yes', 'on', 'enable', 'enabled'])

/**
 * Voice is a stable feature and is enabled by default. The env var remains as
 * an explicit opt-out (`KODE_EXPERIMENTAL_VOICE=0` / `false` disables it).
 */
export function isExperimentalVoiceEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  const raw = env[EXPERIMENTAL_VOICE_ENV]
  if (raw === undefined || raw.trim() === '') return true
  return isExperimentalFeatureEnabled(EXPERIMENTAL_VOICE_ENV, env)
}

/**
 * MCP sampling lets an MCP server initiate a model request. It is disabled by
 * default so a newly configured third-party server cannot incur model cost.
 */
export function isExperimentalMcpSamplingEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return isExperimentalFeatureEnabled(EXPERIMENTAL_MCP_SAMPLING_ENV, env)
}

function isExperimentalFeatureEnabled(
  name: string,
  env: Record<string, string | undefined>,
): boolean {
  const value = env[name]
  return Boolean(value && ENABLED_VALUES.has(value.trim().toLowerCase()))
}
