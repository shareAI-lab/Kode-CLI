import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'

const ROOT_DIR = process.cwd()

const ENGINE_MESSAGE_MIRROR_FILES = [
  'api.ts',
  'constants.ts',
  'create.ts',
  'tags.ts',
  'toolUse.ts',
]

function readRepoFile(path: string): string {
  return readFileSync(join(ROOT_DIR, path), 'utf8')
}

function normalizeMessageMirrorImports(source: string): string {
  return source
    .replaceAll("from '#core/query'", "from '../pipeline/types'")
    .replaceAll("from './types'", "from '../pipeline/types'")
    .replaceAll('\n  FullToolUseResult,\n', '\n')
    .replace(
      "export type { FullToolUseResult } from '../pipeline/types'",
      `export type FullToolUseResult = {
  data: unknown
  resultForAssistant: ToolResultBlockParam['content']
  metadata?: ToolResultMetadata
  newMessages?: Message[]
  contextModifier?: { modifyContext: (ctx: any) => any }
}`,
    )
    .replace(
      /import type \{([^}]*)\} from '\.\.\/pipeline\/types'\r?\n/g,
      (_match, imports: string) => {
        const sortedImports = imports
          .split(',')
          .map(part => part.trim())
          .filter(Boolean)
          .sort()
          .join(', ')
        return `import type { ${sortedImports} } from '../pipeline/types'\n`
      },
    )
}

describe('engine message mirror boundary', () => {
  test('keeps engine message helpers equivalent to message-utils helpers', () => {
    for (const file of ENGINE_MESSAGE_MIRROR_FILES) {
      const messageUtilsFile = normalizeMessageMirrorImports(
        readRepoFile(`packages/message-utils/src/${file}`),
      )
      const engineFile = normalizeMessageMirrorImports(
        readRepoFile(`packages/engine/src/messages/${file}`),
      )

      expect(messageUtilsFile, file).toBe(engineFile)
    }
  })

  test('keeps engine normalization delegated to message-utils', () => {
    const engineNormalize = readRepoFile(
      'packages/engine/src/messages/normalize.ts',
    )

    expect(engineNormalize).toContain("from '@kode/message-utils/normalize'")
    expect(engineNormalize).toContain('normalizeMessagesIncremental')
    expect(engineNormalize).not.toContain('createHash')
  })
})
