import {
  getShellTokenOp,
  isGlobToken,
  parseShellTokens,
  splitBashCommandIntoSubcommands,
} from './shellTokens'
import { xi } from './xi'

const SIMPLE_READ_ONLY_COMMANDS = new Set([
  'basename',
  'bat',
  'cat',
  'cut',
  'date',
  'df',
  'dirname',
  'du',
  'echo',
  'fd',
  'file',
  'grep',
  'head',
  'jq',
  'ls',
  'nl',
  'pwd',
  'readlink',
  'realpath',
  'rg',
  'stat',
  'tail',
  'tree',
  'tr',
  'uname',
  'uniq',
  'wc',
  'which',
  'whoami',
])

const SAFE_GIT_SUBCOMMANDS = new Set([
  'blame',
  'cat-file',
  'describe',
  'diff',
  'diff-tree',
  'for-each-ref',
  'grep',
  'log',
  'ls-files',
  'merge-base',
  'name-rev',
  'rev-parse',
  'show',
  'status',
])

const SAFE_COMPOUND_SEPARATORS = new Set(['&&', '||', ';', '|', '|&'])
const NULL_REDIRECTION_RE = /(^|\s)(?:(?:[012])?>>?)\s*\/dev\/null(?=\s|$)/g
const FD_REDIRECTION_RE = /(^|\s)[012]?>&[012](?=\s|$)/g

function stripHarmlessRedirections(command: string): string {
  return command
    .replace(NULL_REDIRECTION_RE, '$1')
    .replace(FD_REDIRECTION_RE, '$1')
}

function tokenizeWords(command: string): string[] {
  return (command.match(/(?:[^\s"']+|"(?:\\.|[^"])*"|'[^']*')+/g) ?? []).map(
    word => {
      if (
        (word.startsWith('"') && word.endsWith('"')) ||
        (word.startsWith("'") && word.endsWith("'"))
      ) {
        return word.slice(1, -1)
      }
      return word
    },
  )
}

function commandWords(command: string): string[] {
  const words = tokenizeWords(command)
  let index = words[0] === 'env' ? 1 : 0
  while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[index] ?? '')) index += 1
  return words.slice(index)
}

function isSafeGitCommand(words: string[]): boolean {
  let index = 1
  while (words[index] === '-C' && words[index + 1]) index += 2
  const subcommand = words[index]
  const args = words.slice(index + 1)
  if (!subcommand) return false
  if (
    args.some(
      arg =>
        arg === '--ext-diff' ||
        arg === '--textconv' ||
        arg === '--filters' ||
        arg.startsWith('--output=') ||
        arg === '--output' ||
        arg.startsWith('--open-files-in-pager') ||
        arg.startsWith('--exec-path'),
    )
  ) {
    return false
  }
  if (SAFE_GIT_SUBCOMMANDS.has(subcommand)) return true
  if (subcommand === 'remote') return args.length === 0 || args[0] === '-v'
  if (subcommand === 'worktree') return args[0] === 'list'
  if (subcommand === 'tag') {
    return args.length === 0 || args[0] === '--list' || args[0] === '-l'
  }
  return false
}

function isReadOnlySubcommand(command: string): boolean {
  const trimmed = command.trim()
  if (!trimmed || xi(trimmed).behavior !== 'passthrough') return false

  const words = commandWords(trimmed)
  const executable = words[0]?.split('/').at(-1)
  if (!executable) return false

  if (executable === 'git') return isSafeGitCommand(words)
  if (executable === 'command') return words[1] === '-v' && words.length >= 3
  if (executable === 'sed') {
    return !words
      .slice(1)
      .some(arg => arg.startsWith('--in-place') || /^-i/.test(arg))
  }
  if (executable === 'find') {
    return !words
      .slice(1)
      .some(arg =>
        /^-(?:delete|exec|execdir|ok|okdir|fls|fprint0?|fprintf)$/.test(arg),
      )
  }
  if (executable === 'rg') {
    return !words
      .slice(1)
      .some(arg => arg === '--pre' || arg.startsWith('--pre='))
  }
  if (executable === 'fd') {
    return !words
      .slice(1)
      .some(arg => /^(?:-x|-X|--exec|--exec-batch)(?:=|$)/.test(arg))
  }
  if (executable === 'sort') {
    return !words
      .slice(1)
      .some(arg => arg === '-o' || arg.startsWith('--output'))
  }
  if (executable === 'yq') {
    return !words.slice(1).some(arg => arg === '-i' || arg === '--inplace')
  }
  if (executable === 'tree') {
    return !words.slice(1).some(arg => arg === '-o' || arg.startsWith('-o='))
  }
  if (executable === 'pnpm' || executable === 'npm' || executable === 'yarn') {
    return words[1] === 'list' || words[1] === 'ls' || words[1] === 'why'
  }
  if (executable === 'bun') {
    return words[1] === 'pm' && (words[2] === 'ls' || words[2] === 'why')
  }
  return SIMPLE_READ_ONLY_COMMANDS.has(executable)
}

function hasOnlySafeShellOperators(command: string): boolean {
  const parsed = parseShellTokens(command, { preserveNewlines: true })
  if (!parsed.success) return false

  for (const token of parsed.tokens) {
    if (typeof token === 'string') continue
    if (isGlobToken(token)) continue
    const op = getShellTokenOp(token)
    if (op && SAFE_COMPOUND_SEPARATORS.has(op)) continue
    // Newlines are encoded as string markers. Every other object token is a
    // redirect, background launch, command/process substitution, or comment.
    return false
  }
  return true
}

export function isBashCommandReadOnly(command: string): boolean {
  const trimmed = stripHarmlessRedirections(command.trim())
  if (!trimmed || /`|\$\(|[<>]\(/.test(trimmed)) return false
  if (!hasOnlySafeShellOperators(trimmed)) return false

  let subcommands: string[] = []
  try {
    subcommands = splitBashCommandIntoSubcommands(trimmed)
  } catch {
    return false
  }
  if (subcommands.length === 0) return false

  return subcommands.every(isReadOnlySubcommand)
}
