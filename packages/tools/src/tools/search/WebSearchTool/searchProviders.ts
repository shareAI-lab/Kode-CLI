import { parse } from 'node-html-parser'

export interface SearchResult {
  title: string
  snippet: string
  link: string
}

export interface SearchProvider {
  name: string
  search: (
    query: string,
    apiKey?: string,
    signal?: AbortSignal,
  ) => Promise<SearchResult[]>
  isEnabled: (apiKey?: string) => boolean
}

const SEARCH_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36'

const duckDuckGoSearchProvider: SearchProvider = {
  name: 'duckduckgo',
  isEnabled: () => true,
  search: async (
    query: string,
    _apiKey?: string,
    signal?: AbortSignal,
  ): Promise<SearchResult[]> => {
    const response = await fetch(
      `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`,
      {
        headers: {
          'User-Agent': SEARCH_USER_AGENT,
        },
        signal,
      },
    )

    if (!response.ok) {
      throw new Error(
        `DuckDuckGo search failed with status: ${response.status}`,
      )
    }

    const html = await response.text()
    const root = parse(html)
    const results: SearchResult[] = []

    const resultNodes = root.querySelectorAll('.result.web-result')

    for (const node of resultNodes) {
      const titleNode = node.querySelector('.result__a')
      const snippetNode = node.querySelector('.result__snippet')

      if (titleNode && snippetNode) {
        const title = titleNode.text
        const link = titleNode.getAttribute('href')
        const snippet = snippetNode.text

        if (title && link && snippet) {
          let cleanLink = link
          // Both https:// and protocol-relative (//) DuckDuckGo redirects are
          // rewritten to the real destination URL.
          const ddgRedirectMatch =
            link.match(/^https?:\/\/duckduckgo\.com\/l\/\?uddg=/i) ||
            link.match(/^\/\/duckduckgo\.com\/l\/\?uddg=/i)
          if (ddgRedirectMatch) {
            try {
              const url = new URL(link, 'https://duckduckgo.com')
              cleanLink = url.searchParams.get('uddg') || link
            } catch {
              cleanLink = link
            }
          }
          results.push({
            title: title.trim(),
            snippet: snippet.trim(),
            link: cleanLink,
          })
        }
      }
    }

    return results
  },
}

const bingSearchProvider: SearchProvider = {
  name: 'bing',
  isEnabled: () => true,
  search: async (
    query: string,
    _apiKey?: string,
    signal?: AbortSignal,
  ): Promise<SearchResult[]> => {
    const response = await fetch(
      `https://www.bing.com/search?q=${encodeURIComponent(query)}&count=10&setlang=zh-hans`,
      {
        headers: {
          'User-Agent': SEARCH_USER_AGENT,
          'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        },
        signal,
      },
    )

    if (!response.ok) {
      throw new Error(`Bing search failed with status: ${response.status}`)
    }

    const html = await response.text()
    const root = parse(html)
    const results: SearchResult[] = []

    for (const node of root.querySelectorAll('li.b_algo')) {
      const titleNode = node.querySelector('h2 a')
      if (!titleNode) continue
      const title = titleNode.text
      const link = titleNode.getAttribute('href')
      const snippetNode = node.querySelector('.b_caption p, .b_lineclamp2, p')
      const snippet = snippetNode?.text ?? ''
      if (title && link) {
        results.push({
          title: title.trim(),
          snippet: snippet.trim(),
          link,
        })
      }
    }

    return results
  },
}

const baiduSearchProvider: SearchProvider = {
  name: 'baidu',
  isEnabled: () => true,
  search: async (
    query: string,
    _apiKey?: string,
    signal?: AbortSignal,
  ): Promise<SearchResult[]> => {
    const response = await fetch(
      `https://www.baidu.com/s?wd=${encodeURIComponent(query)}&rn=10`,
      {
        headers: {
          'User-Agent': SEARCH_USER_AGENT,
          'Accept-Language': 'zh-CN,zh;q=0.9',
        },
        signal,
      },
    )

    if (!response.ok) {
      throw new Error(`Baidu search failed with status: ${response.status}`)
    }

    const html = await response.text()
    const root = parse(html)
    const results: SearchResult[] = []

    for (const node of root.querySelectorAll('.result, .c-container')) {
      const titleNode = node.querySelector('h3 a')
      if (!titleNode) continue
      const title = titleNode.text
      const link = titleNode.getAttribute('href')
      const snippetNode = node.querySelector(
        '.c-abstract, .content-right_8Zs40, .c-span-last',
      )
      const snippet = snippetNode?.text ?? ''
      if (title && link) {
        results.push({
          title: title.trim(),
          snippet: snippet.trim(),
          link,
        })
      }
    }

    return results
  },
}

export const searchProviders = {
  duckduckgo: duckDuckGoSearchProvider,
  bing: bingSearchProvider,
  baidu: baiduSearchProvider,
}

const SEARCH_TIMEOUT_MS = 6_000
// Repeated identical queries (e.g. parallel searches by the model) reuse the
// most recent results instead of hitting every provider again.
const SEARCH_CACHE_TTL_MS = 30_000
const searchCache = new Map<
  string,
  { expiresAt: number; results: SearchResult[]; providers: string[] }
>()

function cachedSearch(query: string) {
  const entry = searchCache.get(query)
  if (entry && entry.expiresAt > Date.now()) return entry
  return null
}

async function searchWithAbort(
  provider: SearchProvider,
  query: string,
  ms: number,
): Promise<SearchResult[]> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), ms)
  timer.unref?.()
  try {
    return await provider.search(query, undefined, controller.signal)
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Runs all configured search providers in parallel and merges their hits so a
 * single unreachable provider (e.g. DuckDuckGo blocked in some networks) can
 * never turn a search into zero results. Failures and timeouts are skipped.
 */
export async function searchWithFallback(
  query: string,
): Promise<{ results: SearchResult[]; providers: string[] }> {
  const cached = cachedSearch(query)
  if (cached) return cached

  const providers = [
    searchProviders.duckduckgo,
    searchProviders.bing,
    searchProviders.baidu,
  ]

  const settled = await Promise.allSettled(
    providers.map(provider =>
      searchWithAbort(provider, query, SEARCH_TIMEOUT_MS),
    ),
  )

  const seen = new Set<string>()
  const results: SearchResult[] = []
  const usedProviders: string[] = []

  settled.forEach((outcome, index) => {
    if (outcome.status !== 'fulfilled') return
    const provider = providers[index]!
    const hits = outcome.value.filter(result => {
      const key = result.link || result.title
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    if (hits.length > 0) {
      usedProviders.push(provider.name)
      results.push(...hits)
    }
  })

  const outcome = { results, providers: usedProviders }
  searchCache.set(query, {
    expiresAt: Date.now() + SEARCH_CACHE_TTL_MS,
    ...outcome,
  })
  if (searchCache.size > 64) {
    const oldest = searchCache.keys().next().value
    if (oldest) searchCache.delete(oldest)
  }
  return outcome
}
