import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'

const ROOT_DIR = process.cwd()

const OPENAI_PROVIDER_FILES = [
  'completion.ts',
  'customModels.ts',
  'endpointFallback.ts',
  'gpt5.ts',
  'index.ts',
  'modelErrors.ts',
  'modelFeatures.ts',
  'responsesApi.ts',
  'retry.ts',
  'stream.ts',
]

const OPENAI_LLM_FILES = [
  'conversion.ts',
  'index.ts',
  'params.ts',
  'queryOpenAI.ts',
  'stream.ts',
  'unifiedResponse.ts',
  'usage.ts',
]

function readRepoFile(path: string): string {
  return readFileSync(join(ROOT_DIR, path), 'utf8')
}

function normalizeCoreProviderImports(source: string): string {
  return source
    .replaceAll("from '#core/ai/openai'", "from '@kode/ai/openai'")
    .replaceAll(
      "from '#core/ai/openai/stream'",
      "from '@kode/ai/openai/stream'",
    )
    .replaceAll(
      "await import('#core/ai/openai')",
      "await import('@kode/ai/openai')",
    )
}

/**
 * @kode/ai owns a host-agnostic debug/providers surface. Core mirrors keep the
 * historical #core imports; normalize those when comparing file bodies.
 */
function normalizeAiOwnedImports(source: string): string {
  return source
    .replaceAll(
      "from '#core/utils/debugLogger'",
      "from '../internal/debug'",
    )
    .replaceAll(
      "from '#core/constants/models/providers'",
      "from '../internal/providers'",
    )
    .replaceAll(
      "from '#core/ai/llm/restrictedClientCompat'",
      "from '../internal/restrictedClientCompat'",
    )
    .replaceAll(
      "from '#core/utils/config'",
      "from '../internal/runtimeConfig'",
    )
    .replaceAll('getGlobalConfig().proxy', 'getAiProxy()')
    .replaceAll(
      "import { getGlobalConfig } from '../internal/runtimeConfig'",
      "import { getAiProxy } from '../internal/runtimeConfig'",
    )
    .replaceAll(
      "import('#core/ai/llm/restrictedClientCompat')",
      "import('../internal/restrictedClientCompat')",
    )
    .replaceAll(
      "from '../../internal/debug'",
      "from '../internal/debug'",
    )
}

function normalizeLlmOwnedImports(source: string): string {
  return normalizeCoreProviderImports(source)
    .replaceAll(
      "from '#core/utils/debugLogger'",
      "from '../../internal/debug'",
    )
    .replaceAll(
      "from '#core/ai/llm/constants'",
      "from '../../internal/constants'",
    )
    .replaceAll(
      "from '#core/ai/llm/restrictedClientCompat'",
      "from '../../internal/restrictedClientCompat'",
    )
    .replaceAll(
      "from '#core/utils/requestStatus'",
      "from '../../internal/requestStatus'",
    )
}

describe('OpenAI provider mirror boundary', () => {
  test('keeps core and @kode/ai OpenAI provider files equivalent except ai-owned imports', () => {
    for (const file of OPENAI_PROVIDER_FILES) {
      const coreFile = normalizeAiOwnedImports(
        readRepoFile(`packages/core/src/ai/openai/${file}`),
      )
      const aiFile = normalizeAiOwnedImports(
        readRepoFile(`packages/ai/src/openai/${file}`),
      )

      expect(coreFile, file).toBe(aiFile)
    }
  })

  test('keeps OpenAI LLM files equivalent except package-local and ai-owned imports', () => {
    for (const file of OPENAI_LLM_FILES) {
      // Orchestration/conversion own their #core drain path; core mirrors keep
      // historical imports until llm.ts switches callers over.
      if (file === 'queryOpenAI.ts') {
        const coreFile = readRepoFile(
          `packages/core/src/ai/llm/openai/${file}`,
        )
        const aiFile = readRepoFile(`packages/ai/src/llm/openai/${file}`)
        expect(coreFile).toContain('export async function queryOpenAI')
        expect(aiFile).toContain('export async function queryOpenAI')
        expect(aiFile).toContain("from '../../internal/retry'")
        expect(aiFile).toContain('resolveReasoningEffort')
        expect(aiFile).toContain('getAiStream')
        expect(aiFile).toContain('logAiError')
        expect(aiFile).toContain('addAiTotalCost')
        expect(aiFile).not.toContain("from '#core/utils/config'")
        expect(aiFile).not.toContain("from '#core/utils/model'")
        expect(aiFile).not.toContain("from '#core/utils/log'")
        expect(aiFile).not.toContain("from '#core/cost-tracker'")
        expect(aiFile).not.toContain("from '#core/query'")
        expect(aiFile).not.toContain("from '#core/types/modelCapabilities'")
        expect(aiFile).not.toContain("from '#core/ai/modelAdapterFactory'")
        expect(aiFile).toContain('getAiAdapterFactory')
        continue
      }

      if (file === 'conversion.ts' || file === 'unifiedResponse.ts') {
        const coreFile = readRepoFile(
          `packages/core/src/ai/llm/openai/${file}`,
        )
        const aiFile = readRepoFile(`packages/ai/src/llm/openai/${file}`)
        expect(coreFile).toContain(
          file === 'conversion.ts'
            ? 'convertOpenAIResponseToAnthropic'
            : 'buildAssistantMessageFromUnifiedResponse',
        )
        expect(aiFile).toContain(
          file === 'conversion.ts'
            ? 'convertOpenAIResponseToAnthropic'
            : 'buildAssistantMessageFromUnifiedResponse',
        )
        expect(aiFile).toContain("from '../../internal/messageTypes'")
        expect(aiFile).not.toContain("from '#core/query'")
        if (file === 'conversion.ts') {
          expect(aiFile).toContain(
            "from '../../internal/openaiMessageConversion'",
          )
          expect(aiFile).not.toContain(
            "from '#core/utils/openaiMessageConversion'",
          )
        }
        continue
      }

      const coreFile = normalizeLlmOwnedImports(
        readRepoFile(`packages/core/src/ai/llm/openai/${file}`),
      )
      const aiFile = normalizeLlmOwnedImports(
        readRepoFile(`packages/ai/src/llm/openai/${file}`),
      )

      expect(coreFile, file).toBe(aiFile)
    }
  })
})
