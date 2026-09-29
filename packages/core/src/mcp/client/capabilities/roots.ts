import { basename } from 'node:path'
import { pathToFileURL } from 'node:url'

import {
  checkHasTrustDialogAccepted,
  getCurrentProjectConfig,
} from '#core/utils/config'
import { getCwd } from '#core/utils/state'

export type McpRoot = { uri: string; name?: string }

/**
 * Pure root computation, split out so the trust and path rules can be tested
 * without touching the global config on disk.
 */
export function buildMcpRoots(options: {
  trusted: boolean
  configured: string[]
  cwd: string
}): McpRoot[] {
  // Roots are information we hand to a server, so they fail closed: until the
  // workspace trust dialog is accepted we expose nothing.
  if (!options.trusted) return []

  const paths =
    options.configured.length > 0 ? options.configured : [options.cwd]

  const roots: McpRoot[] = []
  const seen = new Set<string>()

  for (const path of paths) {
    if (typeof path !== 'string' || !path.trim()) continue
    const resolved = path.trim()
    const uri = pathToFileURL(resolved).toString()
    if (seen.has(uri)) continue
    seen.add(uri)
    roots.push({ uri, name: basename(resolved) || resolved })
  }

  return roots
}

/**
 * Filesystem roots Kode advertises to MCP servers via `roots/list`.
 *
 * Configured `mcpRoots` takes precedence over the working directory.
 */
export function getDefaultMcpRoots(): McpRoot[] {
  return buildMcpRoots({
    trusted: checkHasTrustDialogAccepted(),
    configured: getCurrentProjectConfig().mcpRoots ?? [],
    cwd: getCwd(),
  })
}
