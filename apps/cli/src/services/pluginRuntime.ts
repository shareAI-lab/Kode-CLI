import { existsSync, readFileSync, statSync } from 'fs'
import { homedir } from 'os'
import { join, resolve } from 'path'
import { glob } from 'glob'
import { z } from 'zod'
import { getCwd } from '#core/utils/state'
import {
  LEGACY_PLUGIN_DIRNAME,
  legacyPluginPathInProject,
} from '#core/compat/legacyPaths'
import {
  setSessionPlugins,
  type SessionPlugin,
} from '#core/utils/sessionPlugins'

const PluginManifestSchema = z
  .object({
    name: z.string().min(1),
    commands: z.union([z.string(), z.array(z.string())]).optional(),
    agents: z.union([z.string(), z.array(z.string())]).optional(),
    skills: z.union([z.string(), z.array(z.string())]).optional(),
    outputStyles: z.union([z.string(), z.array(z.string())]).optional(),
    hooks: z
      .union([
        z.string(),
        z.array(z.string()),
        z.record(z.string(), z.unknown()),
      ])
      .optional(),
    mcpServers: z
      .union([
        z.string(),
        z.array(z.string()),
        z.record(z.string(), z.unknown()),
      ])
      .optional(),
  })
  .passthrough()

function expandHome(input: string): string {
  const trimmed = input.trim()
  if (trimmed === '~') return homedir()
  if (trimmed.startsWith('~/') || trimmed.startsWith('~\\')) {
    return join(homedir(), trimmed.slice(2))
  }
  return trimmed
}

function isLikelyGlob(value: string): boolean {
  return /[*?[\]]/.test(value)
}

async function expandPluginDirInputs(
  pluginDirs: string[],
  baseDir: string,
): Promise<string[]> {
  const out: string[] = []
  for (const raw of pluginDirs) {
    const trimmed = String(raw ?? '').trim()
    if (!trimmed) continue
    const expanded = expandHome(trimmed)
    const abs = resolve(baseDir, expanded)

    if (isLikelyGlob(trimmed) || isLikelyGlob(expanded)) {
      const patternsToTry =
        expanded !== trimmed ? [expanded, trimmed] : [trimmed]
      let matched = false
      for (const pattern of patternsToTry) {
        try {
          const matches = await glob(pattern, {
            cwd: baseDir,
            absolute: true,
            nodir: false,
            nocase: process.platform === 'win32',
          })
          const dirs = matches.filter(match => {
            try {
              return existsSync(match) && statSync(match).isDirectory()
            } catch {
              return false
            }
          })
          if (dirs.length > 0) {
            out.push(...dirs)
            matched = true
            break
          }
        } catch {
          /* no-op */
        }
      }
      if (matched) continue
    }

    out.push(abs)
  }

  const seen = new Set<string>()
  const unique: string[] = []
  for (const item of out) {
    const key = item
    if (seen.has(key)) continue
    seen.add(key)
    unique.push(item)
  }
  return unique
}

function listIfDir(path: string): string[] {
  try {
    if (!existsSync(path)) return []
    if (!statSync(path).isDirectory()) return []
    return [path]
  } catch {
    return []
  }
}

function fileIfExists(path: string): string[] {
  try {
    if (!existsSync(path)) return []
    if (!statSync(path).isFile()) return []
    return [path]
  } catch {
    return []
  }
}

function resolveManifestPaths(
  rootDir: string,
  value: unknown,
): { dirs: string[]; files: string[] } {
  const dirs: string[] = []
  const files: string[] = []
  const list = Array.isArray(value) ? value : value ? [value] : []
  for (const item of list) {
    if (typeof item !== 'string') continue
    const abs = resolve(rootDir, item)
    dirs.push(...listIfDir(abs))
    files.push(...fileIfExists(abs))
  }
  return { dirs, files }
}

function loadPluginFromDir(rootDir: string): SessionPlugin {
  const primaryManifestPath = join(rootDir, '.kode-plugin', 'plugin.json')
  const legacyManifestPath = legacyPluginPathInProject(rootDir, 'plugin.json')
  const manifestPath = existsSync(primaryManifestPath)
    ? primaryManifestPath
    : legacyManifestPath
  if (!existsSync(manifestPath)) {
    throw new Error(
      `Plugin manifest not found (expected .kode-plugin/plugin.json or ${LEGACY_PLUGIN_DIRNAME}/plugin.json)`,
    )
  }

  let manifestRaw: string
  try {
    manifestRaw = readFileSync(manifestPath, 'utf8')
  } catch (err) {
    throw new Error(`Failed to read ${manifestPath}: ${String(err)}`)
  }

  let manifestJson: unknown
  try {
    manifestJson = JSON.parse(manifestRaw)
  } catch (err) {
    throw new Error(`Invalid JSON in ${manifestPath}: ${String(err)}`)
  }

  const parsed = PluginManifestSchema.safeParse(manifestJson)
  if (!parsed.success) {
    throw new Error(
      `Invalid plugin manifest schema in ${manifestPath}: ${parsed.error.message}`,
    )
  }

  const name = parsed.data.name
  const manifestCommands = resolveManifestPaths(rootDir, parsed.data.commands)
  const manifestAgents = resolveManifestPaths(rootDir, parsed.data.agents)
  const commandsDirs = [
    ...listIfDir(join(rootDir, 'commands')),
    ...manifestCommands.dirs,
    ...manifestCommands.files,
  ]
  const skillsDirs = [
    ...listIfDir(join(rootDir, 'skills')),
    ...resolveManifestPaths(rootDir, parsed.data.skills).dirs,
  ]
  const agentsDirs = [
    ...listIfDir(join(rootDir, 'agents')),
    ...manifestAgents.dirs,
    ...manifestAgents.files,
  ]
  const manifestOutputStyles = resolveManifestPaths(
    rootDir,
    parsed.data.outputStyles,
  )
  const outputStylesDirs = [
    ...listIfDir(join(rootDir, 'output-styles')),
    ...manifestOutputStyles.dirs,
    ...manifestOutputStyles.files,
  ]

  const standardHook = fileIfExists(join(rootDir, 'hooks', 'hooks.json'))
  const hookFromManifest = resolveManifestPaths(
    rootDir,
    parsed.data.hooks,
  ).files
  const hooksFiles = [...standardHook, ...hookFromManifest]

  const mcpConfigFiles = [
    ...fileIfExists(join(rootDir, '.mcp.json')),
    ...fileIfExists(join(rootDir, '.mcp.jsonc')),
    ...resolveManifestPaths(rootDir, parsed.data.mcpServers).files,
  ]

  return {
    name,
    rootDir,
    manifestPath,
    manifest: parsed.data,
    commandsDirs,
    skillsDirs,
    agentsDirs,
    hooksFiles,
    outputStylesDirs,
    mcpConfigFiles,
  }
}

export async function configureSessionPlugins(args: {
  pluginDirs: string[]
  baseDir?: string
}): Promise<{ plugins: SessionPlugin[]; errors: string[] }> {
  const baseDir = args.baseDir ?? getCwd()
  const dirs = await expandPluginDirInputs(args.pluginDirs ?? [], baseDir)

  const plugins: SessionPlugin[] = []
  const errors: string[] = []

  for (const dir of dirs) {
    try {
      plugins.push(loadPluginFromDir(dir))
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err))
    }
  }

  setSessionPlugins(plugins)

  // Ensure agents pick up plugin changes.
  const { clearAgentCache } = await import('@kode/agent')
  clearAgentCache()

  // Ensure commands pick up plugin changes without requiring /refresh-commands.
  const { reloadCustomCommandsForSession } =
    await import('#cli-services/customCommands')
  await reloadCustomCommandsForSession()

  // Ensure MCP discovery caches pick up plugin changes.
  const {
    getClients,
    getMCPCommands,
    getMCPResources,
    getMCPResourceTemplates,
    getMCPTools,
  } = await import('#core/mcp/client')
  const clearMemoizeCache = (value: unknown) => {
    const record = value as { cache?: { clear?: () => void } }
    record.cache?.clear?.()
  }
  clearMemoizeCache(getClients)
  clearMemoizeCache(getMCPTools)
  clearMemoizeCache(getMCPCommands)
  clearMemoizeCache(getMCPResources)
  clearMemoizeCache(getMCPResourceTemplates)

  // Ensure output styles pick up plugin changes.
  const { clearOutputStyleCache } = await import('#cli-services/outputStyles')
  clearOutputStyleCache()

  return { plugins, errors }
}
