import { CopilotClient, type ModelInfo } from '@github/copilot-sdk'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { getCopilotCommand, startExternalRuntimeLogin } from './externalRuntime'

export type CopilotLoginStatus =
  | { kind: 'authenticated'; login?: string }
  | { kind: 'unauthenticated' }
  | { kind: 'unavailable' }

export type CopilotRecommendedModel = {
  model: string
  displayName: string
  reasoningEffort?: string
}

export type CopilotAuthService = {
  getStatus(): Promise<CopilotLoginStatus>
  startLogin(): Promise<void>
  getAvailableModels(): Promise<CopilotRecommendedModel[]>
}

type CopilotClientRuntime = Pick<
  CopilotClient,
  'start' | 'stop' | 'getAuthStatus' | 'listModels'
>

type CopilotClientFactory = () => CopilotClientRuntime

export function getCopilotHome(): string {
  return join(homedir(), '.copilot')
}

function isSafeModelId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 160 &&
    /^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/.test(value)
  )
}

function displayNameForModel(model: ModelInfo): string {
  return (
    (typeof model.name === 'string' &&
    model.name.length > 0 &&
    model.name.length <= 120 &&
    !/[\u0000-\u001f\u007f]/.test(model.name)
      ? model.name
      : undefined) ?? model.id
  )
}

export function selectCopilotModels(
  models: readonly ModelInfo[],
): CopilotRecommendedModel[] {
  const used = new Set<string>()
  return models.flatMap(model => {
    if (!isSafeModelId(model.id) || used.has(model.id)) return []
    used.add(model.id)
    return [
      {
        model: model.id,
        displayName: displayNameForModel(model),
        ...(isSafeModelId(model.defaultReasoningEffort)
          ? { reasoningEffort: model.defaultReasoningEffort }
          : {}),
      },
    ]
  })
}

async function withClient<T>(
  clientFactory: CopilotClientFactory,
  run: (client: CopilotClientRuntime) => Promise<T>,
): Promise<T> {
  const client = clientFactory()
  try {
    await client.start()
    return await run(client)
  } finally {
    await client.stop().catch(() => {})
  }
}

export function createCopilotAuthService(
  clientFactory: CopilotClientFactory = () =>
    // Empty mode disables the CLI's ambient tools, while the canonical home
    // lets the official runtime resolve the OAuth login it owns.
    new CopilotClient({ mode: 'empty', baseDirectory: getCopilotHome() }),
): CopilotAuthService {
  return {
    async getStatus() {
      try {
        return await withClient(clientFactory, async client => {
          const status = await client.getAuthStatus()
          return status.isAuthenticated
            ? { kind: 'authenticated', login: status.login }
            : { kind: 'unauthenticated' }
        })
      } catch {
        return { kind: 'unavailable' }
      }
    },
    startLogin: () => startExternalRuntimeLogin(getCopilotCommand(['login'])),
    async getAvailableModels() {
      return withClient(clientFactory, async client => {
        const status = await client.getAuthStatus()
        if (!status.isAuthenticated) {
          throw new Error('GitHub Copilot is not authenticated')
        }
        const models = selectCopilotModels(await client.listModels())
        if (models.length === 0) {
          throw new Error('GitHub Copilot returned no usable models')
        }
        return models
      })
    },
  }
}

export const copilotAuthService = createCopilotAuthService()
