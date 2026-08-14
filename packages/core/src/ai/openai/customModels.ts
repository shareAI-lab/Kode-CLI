import { fetch } from 'undici'

type ModelsResponseShape = { data?: unknown; models?: unknown }

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null) return null
  return value as Record<string, unknown>
}

function extractModelArray(value: unknown): unknown[] | null {
  const record = asRecord(value)
  if (!record) return null

  if (Array.isArray(record.data)) return record.data
  if (Array.isArray(record.models)) return record.models
  return null
}

/**
 * Fetch available models from a custom OpenAI-compatible API.
 */
export async function fetchCustomModels(
  baseURL: string,
  apiKey: string,
): Promise<unknown[]> {
  const hasVersionNumber = /\/v\d+/.test(baseURL)
  const cleanBaseURL = baseURL.replace(/\/+$/, '')
  const modelsURL = hasVersionNumber
    ? `${cleanBaseURL}/models`
    : `${cleanBaseURL}/v1/models`

  const response = await fetch(modelsURL, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
  })

  if (!response.ok) {
    if (response.status === 401) {
      throw new Error(
        'Invalid API key. Please check your API key and try again.',
      )
    }
    if (response.status === 403) {
      throw new Error(
        'API key does not have permission to access models. Please check your API key permissions.',
      )
    }
    if (response.status === 404) {
      throw new Error(
        'API endpoint not found. Please check if the base URL is correct and supports the /models endpoint.',
      )
    }
    if (response.status === 429) {
      throw new Error(
        'Rate limit exceeded. Please wait a moment and try again.',
      )
    }

    throw new Error(
      `Failed to fetch models: HTTP ${response.status} ${response.statusText}`,
    )
  }

  const json = (await response.json()) as ModelsResponseShape
  const models = extractModelArray(json)
  if (!models) {
    throw new Error('Invalid response format: missing models array')
  }
  return models
}
