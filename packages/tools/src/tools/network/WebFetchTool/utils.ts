import { lookup } from 'node:dns/promises'
import { isIP, type LookupFunction } from 'node:net'
import { Address4, Address6 } from 'ip-address'
import { Agent, fetch as undiciFetch } from 'undici'

const MAX_CONTENT_CHARS = 100_000
const MAX_URL_LENGTH = 2000
const MAX_REDIRECTS = 10

type TextContentBlock = { type: 'text'; text: string }

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object') return null
  return value as Record<string, unknown>
}

function isTextContentBlock(block: unknown): block is TextContentBlock {
  const record = asRecord(block)
  if (!record) return false
  return record.type === 'text' && typeof record.text === 'string'
}

export function extractTextFromMessageContent(content: unknown): string | null {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return null
  const textBlock = content.find(isTextContentBlock)
  return textBlock ? textBlock.text : null
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes)) return `${bytes}B`
  if (bytes < 1024) return `${Math.max(0, Math.round(bytes))}B`
  const units = ['KB', 'MB', 'GB', 'TB'] as const
  let value = bytes / 1024
  let unitIndex = 0
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024
    unitIndex++
  }
  const rounded = Math.round(value * 10) / 10
  return `${rounded}${units[unitIndex]}`
}

export function normalizeUrl(url: string): string {
  if (url.startsWith('http://')) {
    return url.replace('http://', 'https://')
  }
  return url
}

function unbracketHostname(hostname: string): string {
  return hostname.startsWith('[') && hostname.endsWith(']')
    ? hostname.slice(1, -1)
    : hostname
}

export function isPublicNetworkAddress(address: string): boolean {
  try {
    if (isIP(address) === 4) {
      const parsed = new Address4(address)
      const [first, second, third] = parsed.toArray()
      return !(
        parsed.isPrivate() ||
        parsed.isLoopback() ||
        parsed.isLinkLocal() ||
        parsed.isUnspecified() ||
        parsed.isBroadcast() ||
        parsed.isCGNAT() ||
        parsed.isMulticast() ||
        // 0.0.0.0/8 routes to the loopback interface on Linux; only the
        // all-zeros address is covered by isUnspecified().
        first === 0 ||
        first! >= 224 ||
        (first === 192 && second === 0) ||
        // 198.51.100.0/24 and 203.0.113.0/24 are documentation ranges.
        (first === 198 && second === 51 && third === 100) ||
        (first === 203 && second === 0 && third === 113)
        // 198.18.0.0/15 (RFC 2544 benchmarking) is intentionally allowed: it
        // is never routed on the public internet, cannot reach internal
        // networks, and proxy stacks (Clash/Surge fake-ip) use it as a
        // virtual mapping range whose traffic is forwarded to the real
        // destination for the already-validated hostname.
      )
    }

    if (isIP(address) === 6) {
      const parsed = new Address6(address)
      // Current public unicast space is 2000::/3. Limiting literals and DNS
      // answers to it also rejects mapped IPv4, NAT64, ULA, link-local,
      // loopback, multicast, and other special-use address families.
      return (
        parsed.binaryZeroPad().startsWith('001') &&
        !parsed.isPrivate() &&
        !parsed.isLoopback() &&
        !parsed.isLinkLocal() &&
        !parsed.isUnspecified() &&
        !parsed.isMulticast() &&
        !parsed.isDocumentation() &&
        !parsed.isTeredo() &&
        !parsed.is6to4()
      )
    }
  } catch {
    return false
  }
  return false
}

export function isValidWebFetchUrl(url: string): boolean {
  if (url.length > MAX_URL_LENGTH) return false
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false
  if (parsed.username || parsed.password) return false

  const hostname = unbracketHostname(parsed.hostname)
  const ipVersion = isIP(hostname)
  if (ipVersion !== 0) return isPublicNetworkAddress(hostname)

  const labels = hostname.replace(/\.$/u, '').split('.')
  return labels.length >= 2 && labels.every(label => label.length > 0)
}

export type WebFetchAddress = { address: string; family?: number }

export type WebFetchLookup = (hostname: string) => Promise<WebFetchAddress[]>

export type ResolvedWebFetchTarget = {
  hostname: string
  addresses: Array<{ address: string; family: 4 | 6 }>
}

export type WebFetchRequest = (
  url: string,
  init: {
    method: 'GET'
    headers: Record<string, string>
    signal: AbortSignal
    redirect: 'manual'
  },
  target: ResolvedWebFetchTarget,
) => Promise<Response>

const lookupAll: WebFetchLookup = async hostname =>
  await lookup(hostname, { all: true, verbatim: true })

export async function assertPublicWebFetchTarget(
  url: string,
  lookupHostname: WebFetchLookup = lookupAll,
): Promise<void> {
  await resolvePublicWebFetchTarget(url, lookupHostname)
}

export async function resolvePublicWebFetchTarget(
  url: string,
  lookupHostname: WebFetchLookup = lookupAll,
): Promise<ResolvedWebFetchTarget> {
  if (!isValidWebFetchUrl(url)) throw new Error('Invalid URL')

  const parsed = new URL(url)
  const hostname = unbracketHostname(parsed.hostname)
  const literalFamily = isIP(hostname)
  if (literalFamily === 4 || literalFamily === 6) {
    return {
      hostname,
      addresses: [{ address: hostname, family: literalFamily }],
    }
  }

  const addresses = await lookupHostname(hostname)
  if (
    addresses.length === 0 ||
    addresses.some(result => !isPublicNetworkAddress(result.address))
  ) {
    throw new Error('URL resolves to a non-public network address')
  }

  return {
    hostname,
    addresses: addresses.map(result => {
      const family = isIP(result.address)
      if (family !== 4 && family !== 6) {
        throw new Error('URL resolves to an invalid network address')
      }
      return { address: result.address, family }
    }),
  }
}

export function createPinnedLookup(
  addresses: ResolvedWebFetchTarget['addresses'],
): LookupFunction {
  const pinned = addresses.map(address => ({ ...address }))
  return (_hostname, options, callback) => {
    const compatible =
      options.family === 4 || options.family === 6
        ? pinned.filter(address => address.family === options.family)
        : pinned
    if (compatible.length === 0) {
      const error = Object.assign(new Error('No approved address family'), {
        code: 'ENOTFOUND',
      })
      callback(error, '', 0)
      return
    }
    if (options.all) {
      callback(null, compatible)
      return
    }
    const selected = compatible[0]!
    callback(null, selected.address, selected.family)
  }
}

async function closeAgent(agent: Agent, force = false): Promise<void> {
  try {
    if (force) await agent.destroy()
    else await agent.close()
  } catch {
    // The response transport is already closed.
  }
}

function bindResponseToAgent(response: Response, agent: Agent): Response {
  if (!response.body) {
    void closeAgent(agent)
    return response
  }

  const reader = response.body.getReader()
  let finished = false
  const finish = async (force = false) => {
    if (finished) return
    finished = true
    await closeAgent(agent, force)
  }

  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read()
        if (done) {
          controller.close()
          await finish()
          return
        }
        if (value) controller.enqueue(value)
      } catch (error) {
        controller.error(error)
        await finish(true)
      }
    },
    async cancel(reason) {
      try {
        await reader.cancel(reason)
      } finally {
        await finish(true)
      }
    },
  })

  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  })
}

const pinnedWebFetchRequest: WebFetchRequest = async (url, init, target) => {
  const agent = new Agent({
    autoSelectFamily: true,
    connect: { lookup: createPinnedLookup(target.addresses) },
  })
  try {
    const response = await undiciFetch(url, {
      ...init,
      dispatcher: agent,
    })
    return bindResponseToAgent(response as unknown as Response, agent)
  } catch (error) {
    await closeAgent(agent, true)
    throw error
  }
}

function normalizeHostname(hostname: string): string {
  return hostname.replace(/^www\./i, '').toLowerCase()
}

function isSameHost(originalUrl: string, redirectUrl: string): boolean {
  try {
    const original = new URL(originalUrl)
    const redirect = new URL(redirectUrl)
    if (redirect.protocol !== original.protocol) return false
    if (redirect.port !== original.port) return false
    if (redirect.username || redirect.password) return false
    return (
      normalizeHostname(original.hostname) ===
      normalizeHostname(redirect.hostname)
    )
  } catch {
    return false
  }
}

export function createTimeoutSignal(
  parent: AbortSignal,
  timeoutMs: number,
): {
  signal: AbortSignal
  cleanup: () => void
} {
  const controller = new AbortController()
  const onAbort = () => controller.abort()
  if (parent.aborted) {
    controller.abort()
  } else {
    parent.addEventListener('abort', onAbort, { once: true })
  }
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timeout)
      parent.removeEventListener('abort', onAbort)
    },
  }
}

export async function readResponseTextLimited(
  response: Response,
  maxBytes: number,
): Promise<{ text: string; bytes: number }> {
  if (!response.body) return { text: '', bytes: 0 }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let bytes = 0
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      if (!value) continue
      bytes += value.byteLength
      if (bytes > maxBytes) {
        try {
          await reader.cancel()
        } catch {
          // ignore
        }
        throw new Error(
          `Response exceeded maximum allowed size (${maxBytes} bytes)`,
        )
      }
      chunks.push(value)
    }
  } finally {
    try {
      reader.releaseLock()
    } catch {
      // ignore
    }
  }

  const buffer = Buffer.concat(chunks.map(chunk => Buffer.from(chunk)))
  return { text: buffer.toString('utf-8'), bytes }
}

export function truncateFetchedContent(content: string): string {
  if (content.length <= MAX_CONTENT_CHARS) return content
  return `${content.substring(0, MAX_CONTENT_CHARS)}...[content truncated]`
}

export function isMarkdownHost(url: string, contentType: string): boolean {
  const lowerContentType = contentType.toLowerCase()
  if (lowerContentType.includes('text/markdown')) return true
  try {
    const parsed = new URL(url)
    const host = parsed.hostname.toLowerCase()
    if (
      host === 'raw.githubusercontent.com' ||
      host === 'gist.githubusercontent.com' ||
      host === 'modelcontextprotocol.io' ||
      host === 'github.com'
    ) {
      return true
    }
    const pathname = parsed.pathname.toLowerCase()
    return pathname.endsWith('.md') || pathname.endsWith('.markdown')
  } catch {
    return false
  }
}

export function buildWebFetchApplyPrompt(
  content: string,
  prompt: string,
  allowBroaderQuoting: boolean,
): string {
  return `
Web page content:
---
${content}
---

${prompt}

${
  allowBroaderQuoting
    ? 'Provide a concise response based on the content above. Include relevant details, code examples, and documentation excerpts as needed.'
    : `Provide a concise response based only on the content above. In your response:
 - Enforce a strict 125-character maximum for quotes from any source document. Open Source Software is ok as long as we respect the license.
 - Use quotation marks for exact language from articles; any language outside of the quotation should never be word-for-word the same.
 - You are not a lawyer and never comment on the legality of your own prompts and responses.
 - Never produce or reproduce exact song lyrics.`
}
`
}

function getChromeLikeHeaders(): Record<string, string> {
  const platformHint =
    process.platform === 'darwin'
      ? 'macOS'
      : process.platform === 'win32'
        ? 'Windows'
        : 'Linux'
  const userAgent =
    process.platform === 'darwin'
      ? 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36'
      : process.platform === 'win32'
        ? 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36'
        : 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36'

  return {
    'User-Agent': userAgent,
    Accept:
      'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Cache-Control': 'no-cache',
    Pragma: 'no-cache',
    'Upgrade-Insecure-Requests': '1',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'none',
    'Sec-Fetch-User': '?1',
    'sec-ch-ua':
      '"Chromium";v="121", "Not A(Brand";v="99", "Google Chrome";v="121"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': `"${platformHint}"`,
  }
}

export async function fetchWithRedirectDetection(
  url: string,
  signal: AbortSignal,
  options: {
    lookupHostname?: WebFetchLookup
    fetchImpl?: WebFetchRequest
  } = {},
): Promise<
  | {
      type: 'redirect'
      originalUrl: string
      redirectUrl: string
      statusCode: number
    }
  | { type: 'response'; response: Response; finalUrl: string }
> {
  let current = url
  const headers = getChromeLikeHeaders()
  const fetchImpl = options.fetchImpl ?? pinnedWebFetchRequest
  for (let i = 0; i < MAX_REDIRECTS; i++) {
    const target = await resolvePublicWebFetchTarget(
      current,
      options.lookupHostname,
    )
    const response = await fetchImpl(
      current,
      {
        method: 'GET',
        headers,
        signal,
        redirect: 'manual',
      },
      target,
    )

    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location')
      if (!location) {
        return { type: 'response', response, finalUrl: current }
      }
      const redirectUrl = new URL(location, current).toString()
      if (isSameHost(current, redirectUrl)) {
        await response.body?.cancel()
        current = redirectUrl
        continue
      }
      await response.body?.cancel()
      return {
        type: 'redirect',
        originalUrl: url,
        redirectUrl,
        statusCode: response.status,
      }
    }

    return { type: 'response', response, finalUrl: current }
  }
  throw new Error(`Too many redirects (maximum ${MAX_REDIRECTS})`)
}
