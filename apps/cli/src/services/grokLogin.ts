import { GrokAcpClient } from '#core/ai/llm/externalRuntime/grokAcp'

import { getGrokCommand, startExternalRuntimeLogin } from './externalRuntime'

export type GrokLoginStatus =
  | { kind: 'authenticated' }
  | { kind: 'unauthenticated' }
  | { kind: 'unavailable' }

export type GrokAuthService = {
  getStatus(): Promise<GrokLoginStatus>
  startLogin(): Promise<void>
  getAvailableModels(): Promise<GrokRecommendedModel[]>
}

export type GrokRecommendedModel = {
  model: string
  displayName: string
  reasoningEffort?: string
}

type GrokAcpClientRuntime = Pick<
  GrokAcpClient,
  'start' | 'stop' | 'getInitializationResult'
>

type GrokAcpClientFactory = () => GrokAcpClientRuntime

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isSafeModelId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 160 &&
    /^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/.test(value)
  )
}

function safeDisplayName(value: unknown, fallback: string): string {
  return typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 120 &&
    !/[\u0000-\u001f\u007f]/.test(value)
    ? value
    : fallback
}

/**
 * The CLI's `grok models` command reports API-key state, not the Build OAuth
 * state. ACP `initialize → authenticate` is the official runtime operation
 * that proves the device/browser login can service Kode.
 */
export function selectGrokModels(
  initializationResult: unknown,
): GrokRecommendedModel[] {
  if (
    !isRecord(initializationResult) ||
    !isRecord(initializationResult._meta)
  ) {
    throw new Error('Grok ACP did not return its model state')
  }
  const modelState = initializationResult._meta.modelState
  if (!isRecord(modelState) || !Array.isArray(modelState.availableModels)) {
    throw new Error('Grok ACP did not return a model catalog')
  }

  const selected: Array<GrokRecommendedModel & { isCurrent: boolean }> = []
  const used = new Set<string>()
  for (const entry of modelState.availableModels) {
    if (!isRecord(entry) || !isSafeModelId(entry.modelId)) continue
    if (used.has(entry.modelId)) continue
    used.add(entry.modelId)

    const metadata = isRecord(entry._meta) ? entry._meta : undefined
    selected.push({
      model: entry.modelId,
      displayName: safeDisplayName(entry.name, entry.modelId),
      ...(typeof metadata?.reasoningEffort === 'string'
        ? { reasoningEffort: metadata.reasoningEffort }
        : {}),
      isCurrent: entry.modelId === modelState.currentModelId,
    })
  }
  selected.sort(
    (left, right) => Number(right.isCurrent) - Number(left.isCurrent),
  )
  return selected.map(({ isCurrent: _isCurrent, ...model }) => model)
}

async function withAuthenticatedGrok<T>(
  clientFactory: GrokAcpClientFactory,
  run: (client: GrokAcpClientRuntime) => Promise<T>,
): Promise<T> {
  const client = clientFactory()
  try {
    await client.start()
    return await run(client)
  } finally {
    await client.stop().catch(() => {})
  }
}

export function createGrokAuthService(
  clientFactory: GrokAcpClientFactory = () => new GrokAcpClient(),
): GrokAuthService {
  return {
    async getStatus() {
      try {
        await withAuthenticatedGrok(clientFactory, async () => undefined)
        return { kind: 'authenticated' }
      } catch {
        return { kind: 'unauthenticated' }
      }
    },
    startLogin: () =>
      startExternalRuntimeLogin(getGrokCommand(['login', '--oauth'])),
    async getAvailableModels() {
      return withAuthenticatedGrok(clientFactory, async client => {
        const models = selectGrokModels(client.getInitializationResult())
        if (models.length === 0) {
          throw new Error('Grok ACP returned no usable models')
        }
        return models
      })
    },
  }
}

export const grokAuthService = createGrokAuthService()
