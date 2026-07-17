/**
 * Responses-API adapter factory binding.
 *
 * Defaults to the in-package ModelAdapterFactory. Hosts may still override via
 * bindAiAdapterFactory (e.g. experimental adapters). Pass null to force the
 * Chat Completions-only path in queryOpenAI.
 */

import type { UnifiedRequestParams } from './messageTypes'
import type { AiModelProfileLike } from './runtimeConfig'
import { ModelAdapterFactory } from '../adapters/modelAdapterFactory'

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

const defaultFactory: AiAdapterFactory = {
  shouldUseResponsesAPI: profile =>
    ModelAdapterFactory.shouldUseResponsesAPI(profile),
  createAdapter: profile => ModelAdapterFactory.createAdapter(profile),
}

let factory: AiAdapterFactory | null = defaultFactory
let explicitlyUnbound = false

export function bindAiAdapterFactory(
  next: AiAdapterFactory | null | undefined,
): void {
  if (next === null) {
    factory = null
    explicitlyUnbound = true
    return
  }
  if (next === undefined) {
    factory = defaultFactory
    explicitlyUnbound = false
    return
  }
  factory = next
  explicitlyUnbound = false
}

export function getAiAdapterFactory(): AiAdapterFactory | null {
  if (explicitlyUnbound) return null
  return factory ?? defaultFactory
}
