/**
 * Optional Responses-API adapter factory.
 *
 * Adapters currently live in @kode/core. Hosts bind the real factory at boot so
 * @kode/ai does not hard-import adapter implementation modules. When unbound,
 * queryOpenAI stays on the Chat Completions path.
 */

import type { UnifiedRequestParams } from './messageTypes'
import type { AiModelProfileLike } from './runtimeConfig'

export type AiModelAdapter = {
  createRequest: (params: UnifiedRequestParams) => any
  parseResponse: (
    response: any,
    streamOptions?: any,
  ) => Promise<any> | any
}

export type AiAdapterFactory = {
  shouldUseResponsesAPI: (modelProfile: AiModelProfileLike) => boolean
  createAdapter: (modelProfile: AiModelProfileLike) => AiModelAdapter
}

let factory: AiAdapterFactory | null = null

export function bindAiAdapterFactory(
  next: AiAdapterFactory | null | undefined,
): void {
  factory = next ?? null
}

export function getAiAdapterFactory(): AiAdapterFactory | null {
  return factory
}
