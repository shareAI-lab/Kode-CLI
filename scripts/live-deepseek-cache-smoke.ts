/**
 * Live DeepSeek smoke: chat + tools + prefix-cache hit on multi-turn.
 *
 * Credentials from OpenCode:
 *   ~/.config/opencode/opencode.json → provider.deepseek
 *
 *   bun scripts/live-deepseek-cache-smoke.ts
 */

import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'

import { getCompletionWithProfile } from '../packages/ai/src/openai/completion.ts'
import { buildOpenAIChatCompletionCreateParams } from '../packages/ai/src/llm/openai/params.ts'
import { queryOpenAI } from '../packages/ai/src/llm/openai/queryOpenAI.ts'
import { normalizeUsage } from '../packages/ai/src/llm/openai/usage.ts'
import { bindAiRuntime } from '../packages/ai/src/internal/runtimeConfig.ts'
import type OpenAI from 'openai'

type Profile = {
  provider: string
  modelName: string
  baseURL: string
  apiKey: string
  maxTokens: number
  name: string
}

function validateDeepSeekBaseURL(value: string): string {
  const url = new URL(value)
  if (url.protocol !== 'https:' || url.hostname !== 'api.deepseek.com') {
    throw new Error(
      'live DeepSeek smoke only permits https://api.deepseek.com; set DEEPSEEK_API_KEY for a direct request',
    )
  }
  return url.origin
}

function loadDeepSeek(): Profile {
  if (process.env.DEEPSEEK_API_KEY) {
    return {
      provider: 'deepseek',
      modelName: process.env.DEEPSEEK_MODEL || 'deepseek-v4-flash',
      baseURL: validateDeepSeekBaseURL(
        process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com',
      ),
      apiKey: process.env.DEEPSEEK_API_KEY,
      maxTokens: 256,
      name: 'env-deepseek',
    }
  }
  const candidates = [
    join(homedir(), '.config/opencode/opencode.json'),
    '/mnt/c/Users/Administrator/.config/opencode/opencode.json',
  ]
  const path = candidates.find(p => existsSync(p))
  if (!path) throw new Error('No DeepSeek credentials found')
  const raw = JSON.parse(readFileSync(path, 'utf8'))
  const ds = raw.provider?.deepseek
  if (!ds?.options?.apiKey)
    throw new Error('provider.deepseek missing in opencode')
  const models = Object.keys(ds.models || {})
  const model =
    process.env.DEEPSEEK_MODEL ||
    (models.includes('deepseek-v4-flash') ? 'deepseek-v4-flash' : models[0]) ||
    'deepseek-v4-flash'
  return {
    provider: 'deepseek',
    modelName: model,
    baseURL: validateDeepSeekBaseURL(
      ds.options.baseURL || 'https://api.deepseek.com',
    ),
    apiKey: ds.options.apiKey,
    maxTokens: 256,
    name: `opencode-deepseek-${model}`,
  }
}

function redact(_value: string) {
  return '[configured]'
}

async function main() {
  const profile = loadDeepSeek()
  console.log('DeepSeek live smoke')
  console.log('  model  :', profile.modelName)
  console.log('  baseURL:', profile.baseURL)
  console.log('  apiKey :', redact(profile.apiKey))
  console.log('')

  bindAiRuntime({ getStream: () => false, getMainModelProfile: () => profile })

  const results: Array<{
    name: string
    pass: boolean
    ms: number
    note?: string
  }> = []

  async function run(name: string, fn: () => Promise<string | void>) {
    const t0 = Date.now()
    process.stdout.write(`→ ${name} ... `)
    try {
      const note = (await fn()) || undefined
      const ms = Date.now() - t0
      results.push({ name, pass: true, ms, note })
      console.log(`OK (${ms}ms)${note ? ` — ${note}` : ''}`)
    } catch (e) {
      const ms = Date.now() - t0
      const note = e instanceof Error ? e.message : String(e)
      results.push({ name, pass: false, ms, note })
      console.log(`FAIL (${ms}ms)`)
      console.error('   ', note)
    }
  }

  const stableSystem =
    'You are Kode coding assistant. Stable system prefix for cache tests. ' +
    'Keep answers short. '.repeat(20)

  await run('turn1 chat (seed cache)', async () => {
    const opts = buildOpenAIChatCompletionCreateParams({
      model: profile.modelName,
      maxTokens: 64,
      temperature: 0,
      stream: false,
      toolSchemas: [],
      provider: 'deepseek',
      reasoningEffort: 'low',
      messages: [
        { role: 'system', content: stableSystem },
        { role: 'user', content: 'Reply with exactly: alpha' },
      ],
    })
    const res = (await getCompletionWithProfile(
      profile,
      opts,
      0,
      2,
    )) as OpenAI.ChatCompletion
    const text = res.choices?.[0]?.message?.content?.trim() || ''
    if (!text) throw new Error('empty content')
    const u = normalizeUsage(res.usage)
    const rawMiss =
      (res.usage as { prompt_cache_miss_tokens?: number } | undefined)
        ?.prompt_cache_miss_tokens ?? 0
    return `text=${text.slice(0, 40)} cache_read=${u.cache_read_input_tokens} cache_miss=${rawMiss} in=${u.input_tokens}`
  })

  await run('turn2 chat (expect cache hit > 0)', async () => {
    // Disk cache construction takes a few seconds after turn1.
    await new Promise(r => setTimeout(r, 3000))
    // Append-only multi-turn: same prefix as turn1
    const opts = buildOpenAIChatCompletionCreateParams({
      model: profile.modelName,
      maxTokens: 64,
      temperature: 0,
      stream: false,
      toolSchemas: [],
      provider: 'deepseek',
      reasoningEffort: 'low',
      messages: [
        { role: 'system', content: stableSystem },
        { role: 'user', content: 'Reply with exactly: alpha' },
        { role: 'assistant', content: 'alpha' },
        { role: 'user', content: 'Reply with exactly: beta' },
      ],
    })
    const res = (await getCompletionWithProfile(
      profile,
      opts,
      0,
      2,
    )) as OpenAI.ChatCompletion
    const text = res.choices?.[0]?.message?.content?.trim() || ''
    const u = normalizeUsage(res.usage)
    const hit = u.cache_read_input_tokens ?? 0
    const rawHit = (res.usage as any)?.prompt_cache_hit_tokens
    if (!text) throw new Error('empty content')
    if (hit <= 0 && !(typeof rawHit === 'number' && rawHit > 0)) {
      throw new Error(
        `expected cache hit after settle; usage=${JSON.stringify(res.usage)}`,
      )
    }
    const rawMiss =
      (res.usage as { prompt_cache_miss_tokens?: number } | undefined)
        ?.prompt_cache_miss_tokens ?? 0
    return `text=${text.slice(0, 40)} cache_read=${hit || rawHit} cache_miss=${rawMiss} HIT`
  })

  await run('tool call', async () => {
    const toolSchemas: OpenAI.ChatCompletionTool[] = [
      {
        type: 'function',
        function: {
          name: 'get_time',
          description: 'Get current time for a city',
          parameters: {
            type: 'object',
            properties: { city: { type: 'string' } },
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
      provider: 'deepseek',
      reasoningEffort: 'low',
      messages: [
        {
          role: 'system',
          content: 'Always call get_time tool. Never answer without the tool.',
        },
        { role: 'user', content: 'What time is it in Tokyo? Use the tool.' },
      ],
    })
    if ((opts as any).thinking?.type !== 'disabled') {
      throw new Error('expected thinking disabled with tools')
    }
    const res = (await getCompletionWithProfile(
      profile,
      opts,
      0,
      2,
    )) as OpenAI.ChatCompletion
    const calls = res.choices?.[0]?.message?.tool_calls || []
    if (!calls.length) {
      throw new Error(
        `no tool_calls content=${JSON.stringify(res.choices?.[0]?.message?.content)?.slice(0, 120)}`,
      )
    }
    return `${calls[0].function?.name}(${calls[0].function?.arguments})`
  })

  await run('queryOpenAI tool path', async () => {
    const tool = {
      name: 'get_time',
      inputSchema: z.object({ city: z.string() }),
      prompt: async () => 'Get time for a city',
      isEnabled: async () => true,
      isReadOnly: true,
      needsPermissions: () => false,
      userFacingName: () => 'get_time',
      renderToolUseMessage: () => null,
      renderToolResultMessage: () => null,
      renderToolUseRejectedMessage: () => null,
      renderToolUseErrorMessage: () => null,
      call: async () => ({ type: 'result' as const, data: {} }),
    } as any

    const assistant = await queryOpenAI(
      [
        {
          type: 'user',
          uuid: crypto.randomUUID() as any,
          message: {
            role: 'user',
            content: 'Time in London? Call get_time.',
          },
        },
      ],
      ['Always use get_time tool before answering.'],
      0,
      [tool],
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
      throw new Error(JSON.stringify(assistant.message?.content)?.slice(0, 200))
    }
    const tools = (assistant.message?.content || []).filter(
      (b: any) => b.type === 'tool_use',
    )
    if (!tools.length) {
      throw new Error(
        `no tool_use: ${JSON.stringify(assistant.message?.content)?.slice(0, 200)}`,
      )
    }
    const u = normalizeUsage(assistant.message?.usage)
    return `tool=${tools[0].name} cache_read=${u.cache_read_input_tokens}`
  })

  console.log('\n=== Summary ===')
  let failed = 0
  for (const r of results) {
    console.log(
      `${r.pass ? 'PASS' : 'FAIL'}  ${String(r.ms).padStart(5)}ms  ${r.name}${r.note ? ` — ${r.note}` : ''}`,
    )
    if (!r.pass) failed++
  }
  console.log(`\n${results.length - failed}/${results.length} passed`)
  if (failed) process.exit(1)
}

main().catch(e => {
  console.error(e)
  process.exit(1)
})
