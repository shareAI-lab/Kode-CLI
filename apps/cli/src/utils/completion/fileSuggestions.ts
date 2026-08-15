import { existsSync, readdirSync, statSync, type Dirent } from 'fs'
import { homedir } from 'os'
import { basename, dirname, join, resolve } from 'path'
import { matchAdvanced } from './advancedFuzzyMatcher'
import type { UnifiedSuggestion } from './types'

function lastPathSepIndex(userPath: string): number {
  return Math.max(userPath.lastIndexOf('/'), userPath.lastIndexOf('\\'))
}

function endsWithPathSep(userPath: string): boolean {
  return userPath.endsWith('/') || userPath.endsWith('\\')
}

function preferredSep(userPath: string): string {
  return userPath.includes('\\') && !userPath.includes('/') ? '\\' : '/'
}

function isAbsoluteUserPath(userPath: string): boolean {
  if (userPath.startsWith('/') || userPath.startsWith('\\')) return true
  return /^[A-Za-z]:[\\/]/.test(userPath)
}

function expandUserPath(userPath: string, cwd: string): string {
  if (userPath === '~') return homedir()
  if (userPath.startsWith('~/') || userPath.startsWith('~\\')) {
    return join(homedir(), userPath.slice(2))
  }
  if (isAbsoluteUserPath(userPath)) return userPath
  return resolve(cwd, userPath.replace(/\\/g, '/'))
}

// List children only for a trailing separator or a root token. An existing
// directory name without a slash is a completion candidate, not an implicit cd.
function shouldListDirectoryContents(
  prefix: string,
  userPath: string,
): boolean {
  if (prefix === '') return true
  if (userPath === '.' || userPath === '~') return true
  return endsWithPathSep(userPath)
}

function isDirectoryEntry(entry: Dirent, directory: string): boolean {
  if (entry.isDirectory()) return true
  if (!entry.isSymbolicLink()) return false

  try {
    return statSync(join(directory, entry.name)).isDirectory()
  } catch {
    // A broken or unreadable symbolic link should not hide the other entries.
    return false
  }
}

export function generateFileSuggestions(args: {
  prefix: string
  cwd: string
}): UnifiedSuggestion[] {
  const { prefix, cwd } = args

  try {
    const userPath = prefix || '.'
    if (
      userPath.startsWith('~') &&
      userPath !== '~' &&
      !userPath.startsWith('~/') &&
      !userPath.startsWith('~\\')
    ) {
      return []
    }

    const searchPath = expandUserPath(userPath, cwd)
    const listContents = shouldListDirectoryContents(prefix, userPath)

    let searchDir: string
    let nameFilter: string

    if (listContents) {
      searchDir = searchPath
      nameFilter = ''
    } else {
      searchDir = dirname(searchPath)
      nameFilter = basename(searchPath)
    }

    if (!existsSync(searchDir)) return []

    const showHidden =
      nameFilter.startsWith('.') ||
      userPath.includes('/.') ||
      userPath.includes('\\.')
    const lowerNameFilter = nameFilter.toLowerCase()
    const useFuzzy = lowerNameFilter.length >= 2
    // Single pass: compute the expensive fuzzy match once per entry instead of
    // running it twice (once to filter, once to score) for every fuzzy hit.
    const matches: Array<{
      entry: Dirent
      isDir: boolean
      prefixMatch: boolean
      fuzzyScore: number
    }> = []
    for (const entry of readdirSync(searchDir, { withFileTypes: true })) {
      if (!showHidden && entry.name.startsWith('.')) continue
      if (!nameFilter) {
        matches.push({
          entry,
          isDir: isDirectoryEntry(entry, searchDir),
          prefixMatch: false,
          fuzzyScore: 0,
        })
        continue
      }
      const lower = entry.name.toLowerCase()
      if (lower.startsWith(lowerNameFilter)) {
        matches.push({
          entry,
          isDir: isDirectoryEntry(entry, searchDir),
          prefixMatch: true,
          fuzzyScore: 0,
        })
        continue
      }
      // Fuzzy fallback (abbreviations/subsequences) so e.g. "pkg" matches
      // "package.json". Gated on 2+ chars to avoid noise.
      if (!useFuzzy) continue
      const fuzzy = matchAdvanced(entry.name, nameFilter)
      if (fuzzy.matched) {
        matches.push({
          entry,
          isDir: isDirectoryEntry(entry, searchDir),
          prefixMatch: false,
          fuzzyScore: fuzzy.score,
        })
      }
    }
    const entries = matches
      .sort((a, b) => {
        if (a.isDir && !b.isDir) return -1
        if (!a.isDir && b.isDir) return 1

        if (a.prefixMatch !== b.prefixMatch) {
          return a.prefixMatch ? -1 : 1
        }
        if (a.fuzzyScore !== b.fuzzyScore) {
          return b.fuzzyScore - a.fuzzyScore
        }
        return a.entry.name
          .toLowerCase()
          .localeCompare(b.entry.name.toLowerCase())
      })
      .slice(0, 25)
      .map(({ entry, isDir }) => {
        const entryName = entry.name
        const icon = isDir ? '📁' : '📄'

        const sep = preferredSep(userPath)
        const sepIndex = lastPathSepIndex(userPath)
        let value: string

        if (sepIndex !== -1) {
          if (endsWithPathSep(userPath)) {
            value = userPath + entryName + (isDir ? sep : '')
          } else if (listContents) {
            value = userPath + sep + entryName + (isDir ? sep : '')
          } else {
            const userDir = userPath.slice(0, sepIndex)
            value = userDir
              ? userDir + sep + entryName + (isDir ? sep : '')
              : entryName + (isDir ? sep : '')
          }
        } else if (listContents) {
          value = userPath + sep + entryName + (isDir ? sep : '')
        } else {
          value = entryName + (isDir ? sep : '')
        }

        return {
          value,
          displayValue: `${icon} ${entryName}${isDir ? '/' : ''}`,
          type: 'file' as const,
          score: isDir ? 80 : 70,
        }
      })

    return entries
  } catch {
    return []
  }
}
