import { describe, expect, test } from 'bun:test'
import {
  EXTERNAL_RUNTIME_TOOL_BRIDGE_UNAVAILABLE_MESSAGE,
  queryLLM,
} from '#core/ai/llm'
import { createAssistantMessage, createUserMessage } from '#core/utils/messages'

describe('queryLLM model pointer fallback (compatibility)', () => {
  test('falls back when resolveModelWithInfo fails (no throw)', async () => {
    const fallbackModelName = 'fallback-model'

    const fakeModelManager = {
      resolveModelWithInfo() {
        return {
          success: false,
          profile: null as any,
          error:
            "Model pointer 'quick' points to invalid model 'bad-model'. Use /model to reconfigure.",
        }
      },
      resolveModel() {
        return {
          modelName: fallbackModelName,
          provider: 'openai',
          name: 'Fallback',
          apiKey: 'test',
          maxTokens: 1,
          contextLength: 1,
          createdAt: 0,
          isActive: true,
        }
      },
    }

    let resolvedModelParam: string | undefined

    async function stubQueryLLMWithPromptCaching(
      _messages: any,
      _systemPrompt: any,
      _maxThinkingTokens: any,
      _tools: any,
      _signal: any,
      options: any,
    ) {
      resolvedModelParam = options.model
      const base = createAssistantMessage('ok')
      return {
        ...base,
        message: { ...base.message, model: String(options.model ?? '') },
      }
    }

    const message = await queryLLM(
      [createUserMessage('hi')],
      ['system'],
      0,
      [],
      new AbortController().signal,
      {
        safeMode: false,
        model: 'quick',
        prependCLISysprompt: false,
        __testModelManager: fakeModelManager,
        __testQueryLLMWithPromptCaching: stubQueryLLMWithPromptCaching,
      },
    )

    expect(resolvedModelParam).toBe(fallbackModelName)
    expect(message.message.model).toBe(fallbackModelName)
  })

  test('does not send explicit tool-required work to an OAuth runtime without a Kode tool bridge', async () => {
    let providerCalls = 0
    const fakeModelManager = {
      resolveModelWithInfo() {
        return {
          success: true,
          profile: {
            modelName: 'github-copilot:gpt-runtime-default',
            provider: 'github-copilot',
            name: 'GitHub Copilot OAuth',
            apiKey: '',
            maxTokens: 1,
            contextLength: 1,
            createdAt: 0,
            isActive: true,
          },
        }
      },
      resolveModel() {
        return null
      },
    }

    const message = await queryLLM(
      [createUserMessage('审查未提交改动')],
      ['<tool_use_requirement>'],
      0,
      [{ name: 'Read' } as any],
      new AbortController().signal,
      {
        safeMode: false,
        model: 'main',
        prependCLISysprompt: false,
        __testModelManager: fakeModelManager,
        __testQueryLLMWithPromptCaching: async () => {
          providerCalls += 1
          return createAssistantMessage('must not be returned')
        },
      },
    )

    expect(providerCalls).toBe(0)
    expect(message.isApiErrorMessage).toBe(true)
    expect(message.message.content).toEqual([
      {
        type: 'text',
        text: EXTERNAL_RUNTIME_TOOL_BRIDGE_UNAVAILABLE_MESSAGE,
        citations: [],
      },
    ])
  })
})
