import type { RequestOptions } from '@modelcontextprotocol/sdk/shared/protocol.js'
import type {
  ClientRequest,
  Result,
  ServerCapabilities,
} from '@modelcontextprotocol/sdk/types.js'
import { ResultSchema } from '@modelcontextprotocol/sdk/types.js'

import { logMCPError } from '@kode/logging/log/errors'

import { getClients } from './clients'
import { getMcpToolTimeoutMs } from './settings'
import {
  createTimeoutSignal,
  mergeAbortSignals,
  type TimeoutSignal,
} from './timeouts'
import type { ConnectedClient } from './types'

const MAX_MCP_PAGINATED_PAGES = 1_000

type PaginatedResult = Result & {
  nextCursor?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requestWithCursor(req: ClientRequest, cursor?: string): ClientRequest {
  if (!cursor) return req

  const raw = req as unknown as Record<string, unknown>
  const params = isRecord(raw.params) ? { ...raw.params, cursor } : { cursor }
  return { ...req, params } as ClientRequest
}

function getNextCursor(result: PaginatedResult): string | undefined {
  const cursor = result.nextCursor
  return typeof cursor === 'string' && cursor.length > 0 ? cursor : undefined
}

export async function requestClientPages<
  ResultT extends PaginatedResult,
  ResultSchemaT extends typeof ResultSchema,
>(
  client: ConnectedClient,
  req: ClientRequest,
  resultSchema: ResultSchemaT,
): Promise<ResultT[]> {
  const timeoutMs = getMcpToolTimeoutMs()
  const pages: ResultT[] = []
  const seenCursors = new Set<string>()
  let cursor: string | undefined

  for (let page = 0; page < MAX_MCP_PAGINATED_PAGES; page++) {
    let timeoutSignal: TimeoutSignal | null = null
    let mergedSignal: TimeoutSignal | null = null

    try {
      timeoutSignal = timeoutMs ? createTimeoutSignal(timeoutMs) : null
      mergedSignal = mergeAbortSignals([timeoutSignal?.signal])

      const options: RequestOptions | undefined = mergedSignal?.signal
        ? { signal: mergedSignal.signal }
        : undefined

      const result = (await client.client.request(
        requestWithCursor(req, cursor),
        resultSchema,
        options,
      )) as ResultT

      pages.push(result)

      const nextCursor = getNextCursor(result)
      if (!nextCursor) return pages

      if (seenCursors.has(nextCursor)) {
        throw new Error(
          `MCP server returned repeated nextCursor for '${req.method}'`,
        )
      }

      seenCursors.add(nextCursor)
      cursor = nextCursor
    } finally {
      mergedSignal?.cleanup()
      timeoutSignal?.cleanup()
    }
  }

  throw new Error(
    `MCP server returned more than ${MAX_MCP_PAGINATED_PAGES} pages for '${req.method}'`,
  )
}

export async function requestAll<
  ResultT extends Result,
  ResultSchemaT extends typeof ResultSchema,
>(
  req: ClientRequest,
  resultSchema: ResultSchemaT,
  requiredCapability: keyof ServerCapabilities,
): Promise<{ client: ConnectedClient; result: ResultT }[]> {
  const timeoutMs = getMcpToolTimeoutMs()
  const clients = await getClients()
  const results = await Promise.allSettled(
    clients.map(async client => {
      if (client.type !== 'connected') return null

      let timeoutSignal: TimeoutSignal | null = null
      let mergedSignal: TimeoutSignal | null = null

      try {
        let capabilities = client.capabilities ?? null

        if (!capabilities) {
          try {
            capabilities = client.client.getServerCapabilities() ?? null
          } catch {
            capabilities = null
          }
          client.capabilities = capabilities
        }

        if (!capabilities?.[requiredCapability]) {
          return null
        }

        timeoutSignal = timeoutMs ? createTimeoutSignal(timeoutMs) : null
        mergedSignal = mergeAbortSignals([timeoutSignal?.signal])

        const options: RequestOptions | undefined = mergedSignal?.signal
          ? { signal: mergedSignal.signal }
          : undefined

        return {
          client,
          result: (await client.client.request(
            req,
            resultSchema,
            options,
          )) as ResultT,
        }
      } catch (error) {
        logMCPError(
          client.name,
          `Failed to request '${req.method}': ${error instanceof Error ? error.message : String(error)}`,
        )
        return null
      } finally {
        mergedSignal?.cleanup()
        timeoutSignal?.cleanup()
      }
    }),
  )

  return results
    .filter(
      (
        result,
      ): result is PromiseFulfilledResult<{
        client: ConnectedClient
        result: ResultT
      } | null> => result.status === 'fulfilled',
    )
    .map(result => result.value)
    .filter(
      (result): result is { client: ConnectedClient; result: ResultT } =>
        result !== null,
    )
}

export async function requestAllPages<
  ResultT extends PaginatedResult,
  ResultSchemaT extends typeof ResultSchema,
>(
  req: ClientRequest,
  resultSchema: ResultSchemaT,
  requiredCapability: keyof ServerCapabilities,
): Promise<{ client: ConnectedClient; results: ResultT[] }[]> {
  const clients = await getClients()
  const results = await Promise.allSettled(
    clients.map(async client => {
      if (client.type !== 'connected') return null

      try {
        let capabilities = client.capabilities ?? null

        if (!capabilities) {
          try {
            capabilities = client.client.getServerCapabilities() ?? null
          } catch {
            capabilities = null
          }
          client.capabilities = capabilities
        }

        if (!capabilities?.[requiredCapability]) {
          return null
        }

        return {
          client,
          results: await requestClientPages<ResultT, ResultSchemaT>(
            client,
            req,
            resultSchema,
          ),
        }
      } catch (error) {
        logMCPError(
          client.name,
          `Failed to request '${req.method}': ${error instanceof Error ? error.message : String(error)}`,
        )
        return null
      }
    }),
  )

  return results
    .filter(
      (
        result,
      ): result is PromiseFulfilledResult<{
        client: ConnectedClient
        results: ResultT[]
      } | null> => result.status === 'fulfilled',
    )
    .map(result => result.value)
    .filter(
      (result): result is { client: ConnectedClient; results: ResultT[] } =>
        result !== null,
    )
}
