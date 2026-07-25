import { existsSync } from 'fs'
import { dirname, join, resolve } from 'path'
import { memoize } from 'lodash-es'
import { createRequire } from 'module'

import { getCwd } from '#core/utils/state'
import { getSessionPlugins } from '#core/utils/sessionPlugins'
import { getKodeBaseDir } from '#core/utils/env'
import { debug as debugLogger } from '#core/utils/debugLogger'
import { logError } from '#core/utils/log'

import type { CustomCommandWithScope } from './types'
import {
  applySkillFilePreference,
  createPromptCommandFromFile,
  loadCommandMarkdownFilesFromBaseDir,
  loadSkillDirectoryCommandsFromBaseDir,
} from './discovery'
import {
  loadPluginCommandsFromDir,
  loadPluginSkillDirectoryCommandsFromBaseDir,
} from './pluginLoader'

function getUserKodeBaseDir(): string {
  return getKodeBaseDir()
}

function tryResolveBundledSkillsDir(): string | null {
  const require = createRequire(import.meta.url)

  const candidates: string[] = []
  try {
    candidates.push(require.resolve('@shareai-lab/kode/package.json'))
  } catch {
    // ignore
  }
  try {
    candidates.push(require.resolve('../../../../../package.json'))
  } catch {
    // ignore
  }

  for (const pkgJsonPath of candidates) {
    const base = dirname(pkgJsonPath)

    const skillsDirCandidates = [
      join(base, 'packages', 'builtin-skills', 'skills'),
      join(base, 'resources', 'skills'),
    ]

    for (const skillsDir of skillsDirCandidates) {
      if (existsSync(skillsDir)) return skillsDir
    }
  }

  return null
}

function listAncestorDirs(startDir: string, maxDepth = 50): string[] {
  const out: string[] = []
  let current = resolve(startDir)
  for (let depth = 0; depth < maxDepth; depth += 1) {
    out.push(current)
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  return out
}

function discoverNestedProjectDirs(
  startDir: string,
  relativeDir: string,
): string[] {
  const discovered: string[] = []
  for (const base of listAncestorDirs(startDir)) {
    const candidate = join(base, relativeDir)
    if (existsSync(candidate)) discovered.push(candidate)
  }
  return discovered
}

export const loadCustomCommands = memoize(
  async (): Promise<CustomCommandWithScope[]> => {
    const cwd = getCwd()
    const userKodeBaseDir = getUserKodeBaseDir()
    const sessionPlugins = getSessionPlugins()

    const projectKodeCommandsDirs = discoverNestedProjectDirs(
      cwd,
      join('.kode', 'commands'),
    )
    const userKodeCommandsDir = join(userKodeBaseDir, 'commands')

    const projectKodeSkillsDirs = discoverNestedProjectDirs(
      cwd,
      join('.kode', 'skills'),
    )
    const userKodeSkillsDir = join(userKodeBaseDir, 'skills')
    const bundledSkillsDir = tryResolveBundledSkillsDir()

    const abortController = new AbortController()
    const timeout = setTimeout(() => abortController.abort(), 3000)

    try {
      const commandFiles = applySkillFilePreference([
        ...(projectKodeCommandsDirs.length > 0
          ? projectKodeCommandsDirs.flatMap(dir =>
              loadCommandMarkdownFilesFromBaseDir(
                dir,
                'localSettings',
                'project',
                abortController.signal,
              ),
            )
          : loadCommandMarkdownFilesFromBaseDir(
              join(cwd, '.kode', 'commands'),
              'localSettings',
              'project',
              abortController.signal,
            )),
        ...loadCommandMarkdownFilesFromBaseDir(
          userKodeCommandsDir,
          'userSettings',
          'user',
          abortController.signal,
        ),
      ])

      const fileCommands = commandFiles
        .map(createPromptCommandFromFile)
        .filter((cmd): cmd is CustomCommandWithScope => cmd !== null)

      const skillDirCommands: CustomCommandWithScope[] = [
        ...projectKodeSkillsDirs.flatMap(dir =>
          loadSkillDirectoryCommandsFromBaseDir(
            dir,
            'localSettings',
            'project',
          ),
        ),
        ...loadSkillDirectoryCommandsFromBaseDir(
          userKodeSkillsDir,
          'userSettings',
          'user',
        ),
        ...(bundledSkillsDir
          ? loadSkillDirectoryCommandsFromBaseDir(
              bundledSkillsDir,
              'userSettings',
              'user',
            )
          : []),
      ]

      const pluginCommands: CustomCommandWithScope[] = []
      if (sessionPlugins.length > 0) {
        for (const plugin of sessionPlugins) {
          for (const commandsDir of plugin.commandsDirs) {
            pluginCommands.push(
              ...loadPluginCommandsFromDir({
                pluginName: plugin.name,
                commandsDir,
                signal: abortController.signal,
              }),
            )
          }
          for (const skillsDir of plugin.skillsDirs) {
            pluginCommands.push(
              ...loadPluginSkillDirectoryCommandsFromBaseDir({
                pluginName: plugin.name,
                skillsDir,
              }),
            )
          }
        }
      }

      const ordered = [
        ...fileCommands,
        ...skillDirCommands,
        ...pluginCommands,
      ].filter(cmd => cmd.isEnabled)

      const seen = new Set<string>()
      const unique: CustomCommandWithScope[] = []
      for (const cmd of ordered) {
        const key = cmd.userFacingName()
        if (seen.has(key)) continue
        seen.add(key)
        unique.push(cmd)
      }

      return unique
    } catch (error) {
      logError(error)
      debugLogger.warn('CUSTOM_COMMANDS_LOAD_FAILED', {
        error: error instanceof Error ? error.message : String(error),
      })
      return []
    } finally {
      clearTimeout(timeout)
    }
  },
  () => {
    const cwd = getCwd()
    const userKodeBaseDir = getUserKodeBaseDir()
    const ancestorDirs = listAncestorDirs(cwd)
    const dirs = [
      join(userKodeBaseDir, 'commands'),
      ...ancestorDirs.map(d => join(d, '.kode', 'commands')),
      join(userKodeBaseDir, 'skills'),
      ...ancestorDirs.map(d => join(d, '.kode', 'skills')),
    ]
    const exists = dirs.map(d => (existsSync(d) ? '1' : '0')).join('')
    return `${cwd}:${exists}:${Math.floor(Date.now() / 60000)}`
  },
)

export const reloadCustomCommands = (): void => {
  loadCustomCommands.cache.clear()
}

export function getCustomCommandDirectories(): {
  userKodeCommands: string
  projectKodeCommands: string
  userKodeSkills: string
  projectKodeSkills: string
} {
  const userKodeBaseDir = getUserKodeBaseDir()
  return {
    userKodeCommands: join(userKodeBaseDir, 'commands'),
    projectKodeCommands: join(getCwd(), '.kode', 'commands'),
    userKodeSkills: join(userKodeBaseDir, 'skills'),
    projectKodeSkills: join(getCwd(), '.kode', 'skills'),
  }
}

export function hasCustomCommands(): boolean {
  const dirs = getCustomCommandDirectories()
  return (
    existsSync(dirs.userKodeCommands) ||
    existsSync(dirs.projectKodeCommands) ||
    existsSync(dirs.userKodeSkills) ||
    existsSync(dirs.projectKodeSkills)
  )
}
