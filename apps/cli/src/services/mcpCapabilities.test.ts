import { afterEach, describe, expect, mock, test } from 'bun:test'

import type { ElicitResult } from '@modelcontextprotocol/sdk/types.js'

import {
  assistantMessageToMessageParam,
  userMessageToMessageParam,
} from '#core/ai/llm/anthropic/messageParams'
import { convertAnthropicMessagesToOpenAIMessages } from '#core/ai/llm/openai/conversion'

import {
  getMcpCapabilityResponders,
  setMcpCapabilityResponders,
} from '#core/mcp/client'

import {
  buildSamplingMessages,
  elicitFromUser,
  getElicitationTimeoutMs,
  installCliMcpCapabilities,
  isSamplingAllowedForServer,
  matchSamplingModelHint,
  pickSamplingModelPointer,
  resolveSamplingMaxTokens,
  sampleFromHost,
  setMcpElicitationPresenter,
} from './mcpCapabilities'

const ORIGINAL_SAMPLING = process.env.MCP_ALLOW_SAMPLING
const ORIGINAL_ALLOWLIST = process.env.MCP_SAMPLING_SERVERS
const ORIGINAL_CEILING = process.env.MCP_SAMPLING_MAX_TOKENS
const ORIGINAL_ELICIT_TIMEOUT = process.env.MCP_ELICITATION_TIMEOUT_MS

function restoreEnv(key: string, original: string | undefined): void {
  if (original === undefined) delete process.env[key]
  else process.env[key] = original
}

afterEach(() => {
  setMcpElicitationPresenter(null)
  setMcpCapabilityResponders(null)
  mock.restore()

  restoreEnv('MCP_ALLOW_SAMPLING', ORIGINAL_SAMPLING)
  restoreEnv('MCP_SAMPLING_SERVERS', ORIGINAL_ALLOWLIST)
  restoreEnv('MCP_SAMPLING_MAX_TOKENS', ORIGINAL_CEILING)
  restoreEnv('MCP_ELICITATION_TIMEOUT_MS', ORIGINAL_ELICIT_TIMEOUT)
})

describe('CLI MCP capability installation', () => {
  test('interactive sessions advertise elicitation, print mode does not', () => {
    installCliMcpCapabilities({ interactive: true })
    expect(typeof getMcpCapabilityResponders().elicit).toBe('function')

    installCliMcpCapabilities({ interactive: false })
    expect(getMcpCapabilityResponders().elicit).toBeUndefined()
  })

  test('sampling stays off unless explicitly enabled', () => {
    delete process.env.MCP_ALLOW_SAMPLING
    installCliMcpCapabilities({ interactive: true })
    expect(getMcpCapabilityResponders().sample).toBeUndefined()

    process.env.MCP_ALLOW_SAMPLING = '1'
    installCliMcpCapabilities({ interactive: true })
    expect(typeof getMcpCapabilityResponders().sample).toBe('function')
  })
})

describe('MCP sampling gate', () => {
  test('is disabled by default', () => {
    delete process.env.MCP_ALLOW_SAMPLING
    expect(isSamplingAllowedForServer('anything')).toBe(false)
  })

  test('is enabled globally by MCP_ALLOW_SAMPLING', () => {
    process.env.MCP_ALLOW_SAMPLING = 'true'
    delete process.env.MCP_SAMPLING_SERVERS
    expect(isSamplingAllowedForServer('anything')).toBe(true)
  })

  test('is narrowed by MCP_SAMPLING_SERVERS', () => {
    process.env.MCP_ALLOW_SAMPLING = '1'
    process.env.MCP_SAMPLING_SERVERS = 'alpha, beta'
    expect(isSamplingAllowedForServer('alpha')).toBe(true)
    expect(isSamplingAllowedForServer('beta')).toBe(true)
    expect(isSamplingAllowedForServer('gamma')).toBe(false)
  })
})

describe('CLI elicitation bridge', () => {
  test('declines when no presenter is mounted', async () => {
    setMcpElicitationPresenter(null)
    const result = await elicitFromUser('srv', {
      method: 'elicitation/create',
      params: { message: 'Pick one' },
    } as never)
    expect(result).toEqual({ action: 'decline' })
  })

  test('routes the request to the presenter and resolves its result', async () => {
    setMcpElicitationPresenter(prompt => {
      expect(prompt.serverName).toBe('srv')
      prompt.resolve({ action: 'accept', content: { answer: 'yes' } })
    })

    const result = await elicitFromUser('srv', {
      method: 'elicitation/create',
      params: { message: 'Pick one' },
    } as never)

    expect(result).toEqual({ action: 'accept', content: { answer: 'yes' } })
  })

  test('serializes concurrent prompts instead of orphaning the first', async () => {
    const seen: string[] = []
    const resolvers: Array<(r: ElicitResult) => void> = []

    setMcpElicitationPresenter(prompt => {
      seen.push(prompt.serverName)
      resolvers.push(prompt.resolve)
    })

    const first = elicitFromUser('server-a', {
      method: 'elicitation/create',
      params: { message: 'first' },
    } as never)
    const second = elicitFromUser('server-b', {
      method: 'elicitation/create',
      params: { message: 'second' },
    } as never)

    // Only one form is presented at a time; the second waits its turn.
    await Promise.resolve()
    expect(seen).toEqual(['server-a'])

    resolvers[0]!({ action: 'accept', content: { answer: 'a' } })
    expect(await first).toEqual({
      action: 'accept',
      content: { answer: 'a' },
    })

    await Promise.resolve()
    expect(seen).toEqual(['server-a', 'server-b'])

    resolvers[1]!({ action: 'decline' })
    expect(await second).toEqual({ action: 'decline' })
  })

  test('queued prompts decline if the presenter goes away while waiting', async () => {
    const resolvers: Array<(r: ElicitResult) => void> = []
    setMcpElicitationPresenter(prompt => {
      resolvers.push(prompt.resolve)
    })

    const first = elicitFromUser('server-a', {
      method: 'elicitation/create',
      params: { message: 'first' },
    } as never)
    const second = elicitFromUser('server-b', {
      method: 'elicitation/create',
      params: { message: 'second' },
    } as never)

    await Promise.resolve()
    setMcpElicitationPresenter(null)
    resolvers[0]!({ action: 'decline' })

    expect(await first).toEqual({ action: 'decline' })
    expect(await second).toEqual({ action: 'decline' })
  })

  test('auto-cancels and dismisses the form once the timeout elapses', async () => {
    process.env.MCP_ELICITATION_TIMEOUT_MS = '30'
    let dismissed = false
    setMcpElicitationPresenter(() => () => {
      dismissed = true
    })

    const result = await elicitFromUser('srv', {
      method: 'elicitation/create',
      params: { message: 'Pick one' },
    } as never)

    expect(result).toEqual({ action: 'cancel' })
    expect(dismissed).toBe(true)
  })

  test('cancels and dismisses when the server aborts the request', async () => {
    const controller = new AbortController()
    let dismissed = false
    setMcpElicitationPresenter(() => () => {
      dismissed = true
    })

    const pending = elicitFromUser(
      'srv',
      {
        method: 'elicitation/create',
        params: { message: 'Pick one' },
      } as never,
      { signal: controller.signal },
    )

    await Promise.resolve()
    controller.abort()

    expect(await pending).toEqual({ action: 'cancel' })
    expect(dismissed).toBe(true)
  })

  test('timeout is configurable and 0 disables it', () => {
    delete process.env.MCP_ELICITATION_TIMEOUT_MS
    expect(getElicitationTimeoutMs()).toBe(300_000)

    process.env.MCP_ELICITATION_TIMEOUT_MS = '1500'
    expect(getElicitationTimeoutMs()).toBe(1500)

    process.env.MCP_ELICITATION_TIMEOUT_MS = '0'
    expect(getElicitationTimeoutMs()).toBe(0)
  })
})

describe('MCP sampling fidelity', () => {
  test('honours the requested budget but clamps it to the ceiling', () => {
    delete process.env.MCP_SAMPLING_MAX_TOKENS
    expect(resolveSamplingMaxTokens(100)).toBe(100)
    expect(resolveSamplingMaxTokens(10_000)).toBe(4096)
    expect(resolveSamplingMaxTokens(undefined)).toBe(4096)
    expect(resolveSamplingMaxTokens(0)).toBe(4096)

    process.env.MCP_SAMPLING_MAX_TOKENS = '512'
    expect(resolveSamplingMaxTokens(10_000)).toBe(512)
    expect(resolveSamplingMaxTokens(64)).toBe(64)
  })

  test('preserves assistant turns instead of flattening the conversation', () => {
    const messages = buildSamplingMessages({
      messages: [
        { role: 'user', content: { type: 'text', text: 'hi' } },
        { role: 'assistant', content: { type: 'text', text: 'hello' } },
        { role: 'user', content: { type: 'text', text: 'bye' } },
      ],
      maxTokens: 10,
    } as never)

    expect(messages.map(message => message.type)).toEqual([
      'user',
      'assistant',
      'user',
    ])
  })

  test('calls the model without Kode’s coding-agent system prompt', async () => {
    const calls: unknown[][] = []
    mock.module('#core/ai/llmLazy', () => ({
      queryLLM: async (...args: unknown[]) => {
        calls.push(args)
        return {
          message: {
            content: [{ type: 'text', text: 'ok' }],
            model: 'test-model',
            stop_reason: 'max_tokens',
          },
        }
      },
      queryQuick: async () => {
        throw new Error('queryQuick must not be used for sampling')
      },
    }))

    process.env.MCP_ALLOW_SAMPLING = '1'
    delete process.env.MCP_SAMPLING_MAX_TOKENS

    const result = await sampleFromHost('srv', {
      method: 'sampling/createMessage',
      params: {
        messages: [{ role: 'user', content: { type: 'text', text: 'hi' } }],
        systemPrompt: 'be terse',
        maxTokens: 20,
        stopSequences: ['###'],
      },
    } as never)

    const options = calls[0]?.[5] as Record<string, unknown>
    expect(options.prependCLISysprompt).toBe(false)
    expect(options.maxTokens).toBe(20)
    expect(options.stopSequences).toEqual(['###'])
    expect(calls[0]?.[1]).toEqual(['be terse'])
    expect(result).toMatchObject({
      model: 'test-model',
      role: 'assistant',
      stopReason: 'maxTokens',
    })
  })
})

describe('MCP sampling model preferences', () => {
  test('honours a hint that matches a configured model (case-insensitive)', () => {
    const available = ['claude-sonnet-4-5', 'gpt-5-mini']
    expect(
      matchSamplingModelHint({ hints: [{ name: 'GPT-5-Mini' }] }, available),
    ).toBe('gpt-5-mini')
    expect(
      matchSamplingModelHint(
        { hints: [{ name: 'unknown' }, { name: 'claude-sonnet-4-5' }] },
        available,
      ),
    ).toBe('claude-sonnet-4-5')
  })

  test('ignores unusable hints instead of failing the request', () => {
    expect(
      matchSamplingModelHint({ hints: [{ name: 'nope' }] }, ['a']),
    ).toBeNull()
    expect(matchSamplingModelHint({ hints: [] }, ['a'])).toBeNull()
    expect(matchSamplingModelHint({}, ['a'])).toBeNull()
    expect(matchSamplingModelHint(null, ['a'])).toBeNull()
    expect(
      matchSamplingModelHint({ hints: [{ name: '  ' }] }, ['a']),
    ).toBeNull()
    expect(matchSamplingModelHint({ hints: 'not-an-array' }, ['a'])).toBeNull()
  })

  test('priorities choose between the fast and main pointers', () => {
    expect(pickSamplingModelPointer(undefined)).toBe('quick')
    expect(
      pickSamplingModelPointer({
        costPriority: 1,
        speedPriority: 1,
        intelligencePriority: 0,
      }),
    ).toBe('quick')

    expect(pickSamplingModelPointer({ intelligencePriority: 1 })).toBe('main')
    expect(
      pickSamplingModelPointer({
        intelligencePriority: 0.8,
        speedPriority: 0.2,
        costPriority: 0.1,
      }),
    ).toBe('main')

    // Capability is not weighted above the competing pressures.
    expect(
      pickSamplingModelPointer({
        intelligencePriority: 0.8,
        costPriority: 0.9,
      }),
    ).toBe('quick')
  })
})

/**
 * The sampling path fabricates assistant turns from the server's conversation.
 * Those objects are cast into Kode's message model, so they must survive the
 * REAL provider converters — a hand-written assertions-only test would not
 * catch a mismatch with the conversion contract.
 */
describe('sampling messages survive the real provider converters', () => {
  function conversation() {
    return buildSamplingMessages({
      messages: [
        { role: 'user', content: { type: 'text', text: 'hi' } },
        { role: 'assistant', content: { type: 'text', text: 'hello' } },
        { role: 'user', content: { type: 'text', text: 'bye' } },
      ],
      maxTokens: 10,
    } as never)
  }

  test('anthropic conversion preserves roles and text', () => {
    const converted = conversation().map(message =>
      message.type === 'user'
        ? userMessageToMessageParam(message, false)
        : assistantMessageToMessageParam(message, false),
    )

    expect(converted).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'hello' }] },
      { role: 'user', content: [{ type: 'text', text: 'bye' }] },
    ])
  })

  test('openai conversion preserves roles and text', () => {
    const converted = convertAnthropicMessagesToOpenAIMessages(conversation())

    expect(converted.map(message => message.role)).toEqual([
      'user',
      'assistant',
      'user',
    ])
    expect(JSON.stringify(converted)).toContain('hello')
    expect(JSON.stringify(converted)).toContain('bye')
  })

  test('non-text content is still carried as text rather than dropped', () => {
    const messages = buildSamplingMessages({
      messages: [
        {
          role: 'user',
          content: { type: 'image', data: 'AAAA', mimeType: 'image/png' },
        },
      ],
      maxTokens: 10,
    } as never)

    const converted = userMessageToMessageParam(messages[0] as never, false)
    expect(JSON.stringify(converted)).toContain('image/png')
  })
})
