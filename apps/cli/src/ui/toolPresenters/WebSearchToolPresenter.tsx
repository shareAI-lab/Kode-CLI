import { Box, Text } from 'ink'
import * as React from 'react'
import { getTheme } from '#core/utils/theme'

type ResultOptions = { verbose: boolean }

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object') return null
  if (Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function countSearchHits(output: unknown): number {
  const record = asRecord(output)
  const results = Array.isArray(record?.results) ? record.results : []
  let count = 0
  for (const item of results) {
    const itemRecord = asRecord(item)
    const content = itemRecord?.content
    if (Array.isArray(content)) count += content.length
  }
  return count
}

function readProviders(output: unknown): string[] {
  const record = asRecord(output)
  const providers = record?.providers
  if (!Array.isArray(providers)) return []
  return providers.filter(
    (provider): provider is string => typeof provider === 'string',
  )
}

/**
 * Compact one-line summary for a completed web search:
 *   ✓ Search · 12 results (duckduckgo, bing, baidu)
 */
export function renderWebSearchToolResultMessage(
  output: unknown,
  options: ResultOptions,
): React.ReactNode {
  const record = asRecord(output)
  const query =
    typeof record?.query === 'string' ? (record.query as string) : ''
  const hitCount = countSearchHits(output)
  const providers = readProviders(output)

  const queryLabel = query ? ` "${query}"` : ''
  const providerLabel = providers.length > 0 ? ` (${providers.join(', ')})` : ''

  if (options.verbose) {
    return (
      <Box flexDirection="column">
        <Text>
          Search{queryLabel} · {hitCount} results{providerLabel}
        </Text>
        {Array.isArray(record?.results)
          ? record.results.flatMap((item, index) => {
              const itemRecord = asRecord(item)
              const content = itemRecord?.content
              if (!Array.isArray(content)) return []
              return (content as Array<{ title?: unknown; url?: unknown }>).map(
                (hit, hitIndex) => (
                  <Text
                    key={`${index}-${hitIndex}`}
                    dimColor
                    wrap="truncate-end"
                  >
                    {'  '}· {String(hit.title ?? '').slice(0, 60)} —{' '}
                    {String(hit.url ?? '')}
                  </Text>
                ),
              )
            })
          : null}
      </Box>
    )
  }

  return (
    <Text color={getTheme().success}>
      ✓ Search{queryLabel} · {hitCount} results{providerLabel}
    </Text>
  )
}
