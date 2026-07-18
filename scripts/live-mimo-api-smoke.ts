/**
 * Live MiMo API smoke tests (chat + tools + stream + queryOpenAI).
 *
 * Loads credentials from OpenCode config (never hardcodes keys):
 *   ~/.config/opencode/opencode.json  → provider.mimo
 *
 * Run:
 *   bun scripts/live-mimo-api-smoke.ts
 *
 * Env overrides:
 *   MIMO_BASE_URL, MIMO_API_KEY, MIMO_MODEL
 */

import { readFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import OpenAI from 'openai'

import { getCompletionWithProfile } from '../packages/ai/src/openai/completion.ts'
import {
  buildOpenAIChatCompletionCreateParams,
  queryOpenAI,
} from '../packages/ai/src/llm/openai/queryOpenAI.ts'
import {
  convertAnthropicMessagesToOpenAIMessages,
  convertOpenAIResponseToAnthropic,
} from '../packages/ai/src/llm/openai/conversion.ts'
import { bindAiRuntime } from '../packages/ai/src/internal/runtimeConfig.ts'

type Profile = {
  provider: string
  modelName: string
  baseURL: string
  apiKey: string
  maxTokens: number
  name: string
}

function loadMimoProfile(): Profile {
  if (process.env.MIMO_API_KEY && process.env.MIMO_BASE_URL) {
    return {
      provider: 'custom-openai',
      modelName: process.env.MIMO_MODEL || 'mimo-v2.5-pro',
      baseURL: process.env.MIMO_BASE_URL,
      apiKey: process.env.MIMO_API_KEY,
      maxTokens: 1024,
      name: 'env-mimo',
    }
  }

  const candidates = [
    join(homedir(), '.config/opencode/opencode.json'),
    '/mnt/c/Users/Administrator/.config/opencode/opencode.json',
  ]
  const path = candidates.find(p => existsSync(p))
  if (!path) {
    throw new Error(
      'No MIMO_* env and no opencode.json found. Set MIMO_API_KEY/MIMO_BASE_URL.',
    )
  }

  const raw = JSON.parse(readFileSync(path, 'utf8')) as {
    provider?: Record<
      string,
      {
        options?: { apiKey?: string; baseURL?: string }
        models?: Record<string, unknown>
      }
    >
  }
  const mimo = raw.provider?.mimo
  if (!mimo?.options?.apiKey || !mimo?.options?.baseURL) {
    throw new Error(`opencode.json has no provider.mimo options at ${path}`)
  }

  const models = Object.keys(mimo.models ?? {})
  const preferred =
    process.env.MIMO_MODEL ||
    (models.includes('mimo-v2.5-pro') ? 'mimo-v2.5-pro' : models[0]) ||
    'mimo-v2.5-pro'

  return {
    provider: 'custom-openai',
    modelName: preferred,
    baseURL: mimo.options.baseURL,
    apiKey: mimo.options.apiKey,
    maxTokens: 1024,
    name: `opencode-mimo-${preferred}`,
  }
}

function redact(s: string): string {
  if (s.length <= 10) return '[set]'
  return `${s.slice(0, 4)}…${s.slice(-4)}`
}

function ok(name: string, detail?: unknown) {
  console.log(`  ✅ ${name}`, detail ? JSON.stringify(detail) : '')
}

function fail(name: string, err: unknown): never {
  const msg = err instanceof Error ? err.message : String(err)
  console.error(`  ❌ ${name}: ${msg}`)
  throw err
}

function minimalTool(name: string, description: string, schema: z.ZodTypeAny) {
  return {
    name,
    inputSchema: schema,
    description,
    prompt: async () => description,
    isEnabled: async () => true,
    isReadOnly: false,
    needsPermissions: () => false,
    userFacingName: () => name,
    renderToolUseMessage: () => null,
    renderToolResultMessage: () => null,
    renderToolUseRejectedMessage: () => null,
    renderToolUseErrorMessage: () => null,
    call: async () => ({ type: 'result' as const, data: {} }),
  } as any
}

async function main() {
  const profile = loadMimoProfile()
  console.log('MiMo live smoke')
  console.log('  model   :', profile.modelName)
  console.log('  baseURL :', profile.baseURL)
  console.log('  apiKey  :', redact(profile.apiKey))
  console.log('')

  bindAiRuntime({
    getStream: () => false,
    getMainModelProfile: () => profile,
  })

  const results: Array<{
    name: string
    pass: boolean
    ms: number
    note?: string
  }> = []

  async function run(
    name: string,
    fn: () => Promise<string | void>,
  ): Promise<void> {
    const start = Date.now()
    process.stdout.write(`→ ${name} ... `)
    try {
      const note = (await fn()) || undefined
      const ms = Date.now() - start
      results.push({ name, pass: true, ms, note })
      console.log(`OK (${ms}ms)${note ? ` — ${note}` : ''}`)
    } catch (err) {
      const ms = Date.now() - start
      results.push({
        name,
        pass: false,
        ms,
        note: err instanceof Error ? err.message : String(err),
      })
      console.log(`FAIL (${ms}ms)`)
      console.error('   ', err instanceof Error ? err.message : err)
    }
  }

  // 1) Direct OpenAI SDK chat (MiMo: disable thinking so budget is not eaten)
  await run('raw OpenAI SDK chat', async () => {
    const client = new OpenAI({
      apiKey: profile.apiKey,
      baseURL: profile.baseURL,
    })
    const res = await client.chat.completions.create({
      model: profile.modelName,
      max_completion_tokens: 64,
      messages: [
        { role: 'system', content: 'Reply with exactly one word: pong' },
        { role: 'user', content: 'ping' },
      ],
      temperature: 0,
      // MiMo extension: same flag our params builder sets by default
      thinking: { type: 'disabled' },
    } as any)
    const text = res.choices?.[0]?.message?.content?.trim() || ''
    if (!text) {
      const msg = res.choices?.[0]?.message as any
      throw new Error(
        `empty content finish=${res.choices?.[0]?.finish_reason} reasoning=${JSON.stringify(msg?.reasoning_content)?.slice(0, 80)}`,
      )
    }
    return text.slice(0, 80)
  })

  // 2) Transport: getCompletionWithProfile non-stream
  await run('getCompletionWithProfile non-stream', async () => {
    const opts = buildOpenAIChatCompletionCreateParams({
      model: profile.modelName,
      maxTokens: 128,
      temperature: 0,
      stream: false,
      toolSchemas: [],
      // low/unset effort disables MiMo thinking so small budgets still return text
      reasoningEffort: 'low',
      messages: [
        { role: 'system', content: 'Reply with exactly: ok' },
        { role: 'user', content: 'status?' },
      ],
    })
    if ((opts as any).thinking?.type !== 'disabled') {
      throw new Error(
        `expected thinking disabled for mimo low effort, got ${JSON.stringify((opts as any).thinking)}`,
      )
    }
    const res = (await getCompletionWithProfile(
      profile,
      opts,
      0,
      3,
    )) as OpenAI.ChatCompletion
    const msg = res.choices?.[0]?.message as any
    const text = (msg?.content || '').trim()
    if (!text) {
      throw new Error(
        `empty content finish=${res.choices?.[0]?.finish_reason} reasoning=${JSON.stringify(msg?.reasoning_content)?.slice(0, 80)} usage=${JSON.stringify(res.usage)}`,
      )
    }
    return text.slice(0, 80)
  })

  // 3) Tool call via transport
  await run('tool call (get_weather)', async () => {
    const toolSchemas: OpenAI.ChatCompletionTool[] = [
      {
        type: 'function',
        function: {
          name: 'get_weather',
          description: 'Get current weather for a city',
          parameters: {
            type: 'object',
            properties: {
              city: { type: 'string', description: 'City name' },
            },
            required: ['city'],
          },
        },
      },
    ]
    const opts = buildOpenAIChatCompletionCreateParams({
      model: profile.modelName,
      maxTokens: 256,
      temperature: 0,
      stream: false,
      toolSchemas,
      messages: [
        {
          role: 'system',
          content:
            'You are a weather assistant. Always use the get_weather tool. Never answer without calling the tool.',
        },
        {
          role: 'user',
          content: 'What is the weather in Beijing? Use the tool.',
        },
      ],
    })
    // ensure mimo thinking disabled when tools present
    if (
      !(opts as any).thinking ||
      (opts as any).thinking?.type !== 'disabled'
    ) {
      // buildOpenAIChatCompletionCreateParams should set this for mimo
    }
    const res = (await getCompletionWithProfile(
      profile,
      opts,
      0,
      3,
    )) as OpenAI.ChatCompletion
    const msg = res.choices?.[0]?.message
    const toolCalls = msg?.tool_calls || []
    if (toolCalls.length === 0) {
      throw new Error(
        `no tool_calls; content=${JSON.stringify(msg?.content)?.slice(0, 200)} finish=${res.choices?.[0]?.finish_reason}`,
      )
    }
    const tc = toolCalls[0]
    const name = tc.function?.name
    let args: any = {}
    try {
      args = JSON.parse(tc.function?.arguments || '{}')
    } catch {
      throw new Error(`invalid tool args: ${tc.function?.arguments}`)
    }
    if (name !== 'get_weather') throw new Error(`unexpected tool ${name}`)
    if (!args.city) throw new Error(`missing city in ${JSON.stringify(args)}`)
    return `${name}(${JSON.stringify(args)}) id=${tc.id}`
  })

  // 4) Tool result round-trip
  await run('tool result → final answer', async () => {
    const toolSchemas: OpenAI.ChatCompletionTool[] = [
      {
        type: 'function',
        function: {
          name: 'get_weather',
          description: 'Get current weather for a city',
          parameters: {
            type: 'object',
            properties: { city: { type: 'string' } },
            required: ['city'],
          },
        },
      },
    ]

    // First turn with synthetic tool call already committed
    const messages: OpenAI.ChatCompletionMessageParam[] = [
      {
        role: 'system',
        content: 'Use tools when provided. After tool results, answer briefly.',
      },
      { role: 'user', content: 'Weather in Shanghai?' },
      {
        role: 'assistant',
        content: null as any,
        tool_calls: [
          {
            id: 'call_live_1',
            type: 'function',
            function: {
              name: 'get_weather',
              arguments: JSON.stringify({ city: 'Shanghai' }),
            },
          },
        ],
      },
      {
        role: 'tool',
        tool_call_id: 'call_live_1',
        content: 'Shanghai: 22C, cloudy, light wind.',
      },
    ]

    const opts = buildOpenAIChatCompletionCreateParams({
      model: profile.modelName,
      maxTokens: 128,
      temperature: 0,
      stream: false,
      toolSchemas,
      messages,
    })
    const res = (await getCompletionWithProfile(
      profile,
      opts,
      0,
      2,
    )) as OpenAI.ChatCompletion
    const text = res.choices?.[0]?.message?.content?.trim() || ''
    if (!text) {
      throw new Error(
        `empty final; finish=${res.choices?.[0]?.finish_reason} tools=${JSON.stringify(res.choices?.[0]?.message?.tool_calls)?.slice(0, 120)}`,
      )
    }
    return text.slice(0, 120)
  })

  // 5) Stream
  await run('stream completion', async () => {
    const opts = buildOpenAIChatCompletionCreateParams({
      model: profile.modelName,
      maxTokens: 64,
      temperature: 0,
      stream: true,
      toolSchemas: [],
      reasoningEffort: 'low',
      messages: [
        { role: 'system', content: 'Reply with one short sentence.' },
        { role: 'user', content: 'Say hello.' },
      ],
    })
    const stream = (await getCompletionWithProfile(
      profile,
      opts,
      0,
      2,
    )) as AsyncIterable<OpenAI.ChatCompletionChunk>
    let text = ''
    let chunks = 0
    for await (const chunk of stream) {
      chunks++
      text += chunk.choices?.[0]?.delta?.content || ''
    }
    if (!text.trim()) {
      throw new Error(`no content in stream (chunks=${chunks})`)
    }
    return `chunks=${chunks} text=${text.trim().slice(0, 60)}`
  })

  // 6) queryOpenAI orchestration + conversion
  await run('queryOpenAI with tool', async () => {
    const weatherTool = minimalTool(
      'get_weather',
      'Get current weather for a city. Input: {city: string}',
      z.object({ city: z.string() }),
    )

    const assistant = await queryOpenAI(
      [
        {
          type: 'user',
          uuid: crypto.randomUUID() as any,
          message: {
            role: 'user',
            content: 'What is the weather in Tokyo? You must call get_weather.',
          },
        },
      ],
      [
        'You are a weather assistant. Always call get_weather before answering. Never invent weather without the tool.',
      ],
      0,
      [weatherTool],
      new AbortController().signal,
      {
        safeMode: false,
        model: profile.modelName,
        prependCLISysprompt: false,
        modelProfile: profile,
        stream: false,
        maxTokens: 256,
        temperature: 0,
      },
    )

    if (assistant.isApiErrorMessage) {
      const t =
        assistant.message?.content
          ?.filter((b: any) => b.type === 'text')
          .map((b: any) => b.text)
          .join(' ') || ''
      throw new Error(`api error message: ${t.slice(0, 200)}`)
    }

    const toolUses = (assistant.message?.content || []).filter(
      (b: any) => b.type === 'tool_use',
    )
    if (toolUses.length === 0) {
      const text = (assistant.message?.content || [])
        .filter((b: any) => b.type === 'text')
        .map((b: any) => b.text)
        .join(' ')
      throw new Error(`no tool_use blocks; text=${text.slice(0, 200)}`)
    }
    const tu = toolUses[0]
    return `tool_use name=${tu.name} input=${JSON.stringify(tu.input)}`
  })

  // 7) conversion round-trip of tool messages (local, no network if we already have shapes)
  await run('conversion anthropic↔openai tool ordering', async () => {
    const messages = [
      {
        type: 'user' as const,
        message: {
          role: 'user' as const,
          content: [{ type: 'text', text: 'hi' }],
        },
      },
      {
        type: 'assistant' as const,
        costUSD: 0,
        durationMs: 0,
        uuid: crypto.randomUUID() as any,
        message: {
          id: 'a1',
          model: profile.modelName,
          role: 'assistant' as const,
          type: 'message' as const,
          stop_reason: 'tool_use',
          stop_sequence: null,
          usage: {
            input_tokens: 1,
            output_tokens: 1,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          },
          content: [
            {
              type: 'tool_use',
              id: 'tu1',
              name: 'get_weather',
              input: { city: 'Paris' },
            },
          ],
        },
      },
      {
        type: 'user' as const,
        message: {
          role: 'user' as const,
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tu1',
              content: 'Paris: sunny 20C',
            },
          ],
        },
      },
    ]
    const openaiMsgs = convertAnthropicMessagesToOpenAIMessages(messages as any)
    const roles = openaiMsgs.map((m: any) => m.role)
    if (!roles.includes('tool')) throw new Error(`roles=${roles.join(',')}`)
    if (!roles.includes('assistant')) throw new Error('missing assistant')
    return roles.join('→')
  })

  console.log('\n=== Summary ===')
  const passed = results.filter(r => r.pass).length
  const failed = results.filter(r => !r.pass)
  for (const r of results) {
    console.log(
      `${r.pass ? 'PASS' : 'FAIL'}  ${r.ms.toString().padStart(5)}ms  ${r.name}${r.note && !r.pass ? ` — ${r.note.slice(0, 120)}` : ''}`,
    )
  }
  console.log(`\n${passed}/${results.length} passed`)
  if (failed.length) process.exit(1)
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
