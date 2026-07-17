import type { ProxyAgent, Response } from 'undici'
import { ProxyAgent as ProxyAgentCtor, fetch } from 'undici'

import { getGlobalConfig } from '#core/utils/config'
import {
  buildCompatHeaders,
  type RequestHeadersProfile,
} from '#core/ai/llm/restrictedClientCompat'

/**
 * Call GPT-5 Responses API with proper parameter handling.
 *
 * Returns the raw `Response` so adapters can parse/stream as needed.
 */
export async function callGPT5ResponsesAPI(
  modelProfile: unknown,
  request: unknown,
  signal?: AbortSignal,
  requestHeadersProfile?: RequestHeadersProfile,
): Promise<Response> {
  const profile = modelProfile as { baseURL?: string; apiKey?: string } | null
  const baseURL = profile?.baseURL || 'https://api.openai.com/v1'
  const apiKey = profile?.apiKey

  const proxyUrl = getGlobalConfig().proxy
  const proxy: ProxyAgent | undefined = proxyUrl
    ? new ProxyAgentCtor(proxyUrl)
    : undefined

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(requestHeadersProfile === 'compat' ? buildCompatHeaders() : {}),
    ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
  }

  try {
    const response = await fetch(`${baseURL}/responses`, {
      method: 'POST',
      headers,
      body: JSON.stringify(request),
      dispatcher: proxy,
      signal,
    })

    if (!response.ok) {
      const errorText = await response.text()
      throw new Error(
        `GPT-5 Responses API error: ${response.status} ${response.statusText} - ${errorText}`,
      )
    }

    return response
  } catch (error) {
    if (signal?.aborted) {
      throw new Error('Request cancelled by user')
    }
    throw error
  }
}
