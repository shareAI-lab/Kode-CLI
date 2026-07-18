import type OpenAI from 'openai'
import type { Response } from 'undici'

import { debug as debugLogger } from '#core/utils/debugLogger'

export type StreamDegradationReason =
  | 'read_error'
  | 'json_parse_error'
  | 'provider_error'
  | 'unexpected_error'
  | 'empty_response'

export class OpenAIStreamError extends Error {
  readonly reason: StreamDegradationReason

  constructor(reason: StreamDegradationReason, message: string) {
    super(message)
    this.name = 'OpenAIStreamError'
    this.reason = reason
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function trimForLog(value: string): string {
  return value.length <= 500 ? value : `${value.slice(0, 500)}...`
}

function extractStreamErrorMessage(value: unknown): string | null {
  const record = asRecord(value)
  if (!record || !('error' in record)) return null

  const error = record.error
  if (typeof error === 'string' && error.trim()) return error.trim()

  const errorRecord = asRecord(error)
  if (!errorRecord) return 'OpenAI stream returned an error payload'

  const message = errorRecord.message
  if (typeof message === 'string' && message.trim()) return message.trim()

  try {
    return JSON.stringify(errorRecord)
  } catch {
    return 'OpenAI stream returned an error payload'
  }
}

export function createStreamProcessor(
  stream: NonNullable<Response['body']>,
  signal?: AbortSignal,
): AsyncGenerator<OpenAI.ChatCompletionChunk, void, unknown> {
  return (async function* () {
    const reader = stream.getReader()
    const decoder = new TextDecoder('utf-8')
    let buffer = ''

    try {
      while (true) {
        if (signal?.aborted) break

        let readResult: Awaited<ReturnType<typeof reader.read>>
        try {
          readResult = await reader.read()
        } catch (e) {
          if (signal?.aborted) break
          debugLogger.warn('OPENAI_STREAM_READ_ERROR', {
            error: e instanceof Error ? e.message : String(e),
          })
          throw new OpenAIStreamError(
            'read_error',
            `OpenAI stream read failed: ${
              e instanceof Error ? e.message : String(e)
            }`,
          )
        }

        const { done, value } = readResult
        if (done) break

        const chunk = value instanceof Uint8Array ? value : new Uint8Array()
        buffer += decoder.decode(chunk, { stream: true })

        let lineEnd = buffer.indexOf('\n')
        while (lineEnd !== -1) {
          const line = buffer.substring(0, lineEnd).trim()
          buffer = buffer.substring(lineEnd + 1)

          if (line === 'data: [DONE]') {
            return
          }

          if (line.startsWith('data: ')) {
            const data = line.slice(6).trim()
            if (data) {
              try {
                const parsed = JSON.parse(data)
                const errorMessage = extractStreamErrorMessage(parsed)
                if (errorMessage) {
                  throw new OpenAIStreamError(
                    'provider_error',
                    `OpenAI stream error: ${errorMessage}`,
                  )
                }
                yield parsed as OpenAI.ChatCompletionChunk
              } catch (e) {
                if (e instanceof OpenAIStreamError) throw e
                debugLogger.warn('OPENAI_STREAM_JSON_PARSE_ERROR', {
                  data: trimForLog(data),
                  error: e instanceof Error ? e.message : String(e),
                })
                throw new OpenAIStreamError(
                  'json_parse_error',
                  `OpenAI stream emitted malformed JSON: ${trimForLog(data)}`,
                )
              }
            }
          }

          lineEnd = buffer.indexOf('\n')
        }
      }

      if (buffer.trim()) {
        const lines = buffer.trim().split('\n')
        for (const line of lines) {
          if (!line.startsWith('data: ') || line === 'data: [DONE]') continue
          const data = line.slice(6).trim()
          if (!data) continue
          try {
            const parsed = JSON.parse(data)
            const errorMessage = extractStreamErrorMessage(parsed)
            if (errorMessage) {
              throw new OpenAIStreamError(
                'provider_error',
                `OpenAI stream error: ${errorMessage}`,
              )
            }
            yield parsed as OpenAI.ChatCompletionChunk
          } catch (e) {
            if (e instanceof OpenAIStreamError) throw e
            debugLogger.warn('OPENAI_STREAM_FINAL_JSON_PARSE_ERROR', {
              data: trimForLog(data),
              error: e instanceof Error ? e.message : String(e),
            })
            throw new OpenAIStreamError(
              'json_parse_error',
              `OpenAI stream emitted malformed JSON: ${trimForLog(data)}`,
            )
          }
        }
      }
    } catch (e) {
      if (e instanceof OpenAIStreamError) throw e
      debugLogger.warn('OPENAI_STREAM_UNEXPECTED_ERROR', {
        error: e instanceof Error ? e.message : String(e),
      })
      throw new OpenAIStreamError(
        'unexpected_error',
        `OpenAI stream failed unexpectedly: ${
          e instanceof Error ? e.message : String(e)
        }`,
      )
    } finally {
      try {
        reader.releaseLock()
      } catch (e) {
        debugLogger.warn('OPENAI_STREAM_RELEASE_LOCK_ERROR', {
          error: e instanceof Error ? e.message : String(e),
        })
      }
    }
  })()
}

export function streamCompletion(
  stream: NonNullable<Response['body']>,
  signal?: AbortSignal,
): AsyncGenerator<OpenAI.ChatCompletionChunk, void, unknown> {
  return createStreamProcessor(stream, signal)
}
