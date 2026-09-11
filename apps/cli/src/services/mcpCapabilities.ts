import { randomUUID } from 'node:crypto'

import type {
  CreateMessageRequest,
  CreateMessageResult,
  ElicitRequest,
  ElicitResult,
} from '@modelcontextprotocol/sdk/types.js'

import type { AssistantMessage, UserMessage } from '#core/query'
import { getModelManager } from '#core/utils/model'
import {
  setMcpCapabilityResponders,
  type McpCapabilityRequestContext,
  type McpCapabilityResponders,
} from '#core/mcp/client'

export type McpElicitationPrompt = {
  serverName: string
  request: ElicitRequest
  resolve: (result: ElicitResult) => void
}

/**
 * Renders a prompt. Returns an optional dismiss callback the host uses to take
 * the form down again (on timeout or when the server cancels).
 */
export type McpElicitationPresenter = (
  prompt: McpElicitationPrompt,
) => void | (() => void)

let elicitationPresenter: McpElicitationPresenter | null = null

/**
 * Tail of the elicitation queue. Each prompt chains onto the previous one so
 * only a single form is ever displayed.
 */
let elicitationQueue: Promise<void> = Promise.resolve()

/**
 * How long a form may block the session before it is auto-cancelled. `0`
 * disables the timeout and waits indefinitely.
 */
export function getElicitationTimeoutMs(): number {
  const raw = process.env.MCP_ELICITATION_TIMEOUT_MS
  const parsed = raw ? Number.parseInt(raw, 10) : NaN
  if (Number.isFinite(parsed) && parsed >= 0) return parsed
  return 300_000
}

/**
 * Register the UI that renders `elicitation/create` requests.
 *
 * The presenter is installed by the mounted REPL, so it is late-bound: the
 * elicitation *capability* is advertised from CLI startup, but a request that
 * arrives before the UI is mounted fails closed with a decline.
 */
export function setMcpElicitationPresenter(
  next: McpElicitationPresenter | null,
): void {
  elicitationPresenter = next
}

export function isMcpElicitationAvailable(): boolean {
  return elicitationPresenter !== null
}

export async function elicitFromUser(
  serverName: string,
  request: ElicitRequest,
  context?: McpCapabilityRequestContext,
): Promise<ElicitResult> {
  if (!elicitationPresenter) return { action: 'decline' }

  // Serialize prompts: the CLI renders one form at a time, and letting a second
  // server request replace an in-flight one would orphan the first promise and
  // leave that server's tool call hanging.
  const previous = elicitationQueue
  let release: () => void = () => {}
  elicitationQueue = new Promise<void>(resolve => {
    release = resolve
  })

  await previous

  try {
    // Re-read after the wait: the REPL may have unmounted while we queued.
    const present = elicitationPresenter
    if (!present) return { action: 'decline' }
    if (context?.signal?.aborted) return { action: 'cancel' }

    const timeoutMs = getElicitationTimeoutMs()

    return await new Promise<ElicitResult>(resolve => {
      let settled = false
      let timer: ReturnType<typeof setTimeout> | null = null
      let dismiss: (() => void) | undefined

      const settle = (result: ElicitResult): void => {
        if (settled) return
        settled = true
        if (timer) clearTimeout(timer)
        context?.signal?.removeEventListener('abort', onAbort)
        resolve(result)
      }

      const close = (result: ElicitResult): void => {
        if (settled) return
        settle(result)
        dismiss?.()
      }

      const onAbort = (): void => close({ action: 'cancel' })

      const returned = present({ serverName, request, resolve: settle })
      dismiss = typeof returned === 'function' ? returned : undefined

      context?.signal?.addEventListener('abort', onAbort, { once: true })

      if (timeoutMs > 0) {
        timer = setTimeout(() => close({ action: 'cancel' }), timeoutMs)
      }
    })
  } finally {
    release()
  }
}

function isSamplingEnabled(): boolean {
  const raw = process.env.MCP_ALLOW_SAMPLING?.trim().toLowerCase()
  return raw === '1' || raw === 'true' || raw === 'yes'
}

function getSamplingAllowlist(): Set<string> | null {
  const raw = process.env.MCP_SAMPLING_SERVERS
  if (!raw) return null
  const names = raw
    .split(',')
    .map(name => name.trim())
    .filter(Boolean)
  return names.length > 0 ? new Set(names) : null
}

/**
 * Sampling lets a server spend the host's model budget, so it is opt-in.
 * Nothing is advertised (and every request is rejected) unless
 * `MCP_ALLOW_SAMPLING` is set; `MCP_SAMPLING_SERVERS` narrows it to a list.
 */
export function isSamplingAllowedForServer(serverName: string): boolean {
  if (!isSamplingEnabled()) return false
  const allowlist = getSamplingAllowlist()
  if (!allowlist) return true
  return allowlist.has(serverName)
}

/**
 * Pick a model for a sampling request.
 *
 * MCP `modelPreferences.hints` are advisory: an unknown hint must never fail
 * the request, so a hint is only honoured when it matches a model the user
 * actually has configured. Otherwise the cost/speed/intelligence priorities
 * choose between Kode's cheap/fast pointer and the main agent pointer.
 */
export function matchSamplingModelHint(
  preferences: unknown,
  availableModels: string[],
): string | null {
  if (!preferences || typeof preferences !== 'object') return null
  const hints = (preferences as { hints?: unknown }).hints
  if (!Array.isArray(hints)) return null

  for (const hint of hints) {
    if (!hint || typeof hint !== 'object') continue
    const name = (hint as { name?: unknown }).name
    if (typeof name !== 'string' || !name.trim()) continue

    const wanted = name.trim().toLowerCase()
    const match = availableModels.find(
      candidate => candidate.toLowerCase() === wanted,
    )
    if (match) return match
  }

  return null
}

export function pickSamplingModelPointer(
  preferences: unknown,
): 'quick' | 'main' {
  const record =
    preferences && typeof preferences === 'object'
      ? (preferences as Record<string, unknown>)
      : {}

  const weight = (value: unknown): number =>
    typeof value === 'number' && Number.isFinite(value) ? value : 0

  const intelligence = weight(record.intelligencePriority)
  const speed = weight(record.speedPriority)
  const cost = weight(record.costPriority)

  // Only escalate to the main model when the server explicitly weights
  // capability above both speed and cost.
  return intelligence > 0.5 && intelligence >= speed && intelligence >= cost
    ? 'main'
    : 'quick'
}

export function resolveSamplingModel(preferences: unknown): string {
  const available = getModelManager().getAllAvailableModelNames()
  return (
    matchSamplingModelHint(preferences, available) ??
    pickSamplingModelPointer(preferences)
  )
}

function renderSamplingContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content.map(renderSamplingContent).join('\n')
  }
  if (content && typeof content === 'object') {
    const record = content as { type?: unknown; text?: unknown }
    if (record.type === 'text' && typeof record.text === 'string') {
      return record.text
    }
    try {
      return JSON.stringify(content)
    } catch {
      return String(content)
    }
  }
  return String(content)
}

/**
 * Map the sampling conversation onto Kode's message model.
 *
 * Role structure is preserved (assistant turns stay assistant turns) rather
 * than being flattened into a single user prompt, which would misrepresent the
 * conversation to the model.
 */
export function buildSamplingMessages(
  params: CreateMessageRequest['params'],
): (UserMessage | AssistantMessage)[] {
  const messages: (UserMessage | AssistantMessage)[] = []

  for (const message of params.messages ?? []) {
    const text = renderSamplingContent(message.content)

    if (message.role === 'assistant') {
      messages.push({
        type: 'assistant',
        uuid: randomUUID(),
        costUSD: 0,
        durationMs: 0,
        message: {
          id: `msg_${randomUUID()}`,
          type: 'message',
          role: 'assistant',
          model: '',
          content: [{ type: 'text', text }],
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      } as AssistantMessage)
      continue
    }

    messages.push({
      type: 'user',
      uuid: randomUUID(),
      // Block content (not a bare string) so user and assistant turns have the
      // same shape and downstream consumers never need to handle both.
      message: { role: 'user', content: [{ type: 'text', text }] },
    })
  }

  return messages
}

/**
 * Resolve the token budget for a sampling request.
 *
 * The server's `maxTokens` is honoured but clamped to `MCP_SAMPLING_MAX_TOKENS`
 * so a server cannot spend an unbounded amount of the user's model budget.
 */
export function resolveSamplingMaxTokens(requested: unknown): number {
  const rawCeiling = process.env.MCP_SAMPLING_MAX_TOKENS
  const parsedCeiling = rawCeiling ? Number.parseInt(rawCeiling, 10) : NaN
  const ceiling =
    Number.isFinite(parsedCeiling) && parsedCeiling > 0 ? parsedCeiling : 4096

  const asked =
    typeof requested === 'number' && Number.isFinite(requested) && requested > 0
      ? Math.floor(requested)
      : ceiling

  return Math.min(asked, ceiling)
}

/** Anthropic stop reasons -> the MCP `stopReason` vocabulary. */
function mapSamplingStopReason(raw: unknown): string {
  switch (raw) {
    case 'max_tokens':
      return 'maxTokens'
    case 'stop_sequence':
      return 'stopSequence'
    case 'end_turn':
      return 'endTurn'
    default:
      return typeof raw === 'string' && raw ? raw : 'endTurn'
  }
}

export async function sampleFromHost(
  serverName: string,
  request: CreateMessageRequest,
  context?: McpCapabilityRequestContext,
): Promise<CreateMessageResult> {
  if (!isSamplingAllowedForServer(serverName)) {
    throw new Error(
      `Sampling is disabled for MCP server "${serverName}". Set MCP_ALLOW_SAMPLING=1 to enable it.`,
    )
  }

  const params = request.params
  const { queryLLM } = await import('#core/ai/llmLazy')

  const assistant = await queryLLM(
    buildSamplingMessages(params),
    params.systemPrompt ? [params.systemPrompt] : [],
    0, // maxThinkingTokens: sampling is a plain completion, not a reasoning turn
    [], // tools: sampling-with-tools is not supported yet
    context?.signal ?? new AbortController().signal,
    {
      safeMode: false,
      model: resolveSamplingModel(params.modelPreferences),
      // The server's system prompt is authoritative: Kode's coding-agent
      // system prompt must not leak into (or override) a sampling request.
      prependCLISysprompt: false,
      maxTokens: resolveSamplingMaxTokens(params.maxTokens),
      stopSequences: Array.isArray(params.stopSequences)
        ? params.stopSequences
        : undefined,
    },
  )

  const blocks = assistant.message?.content
  const text = Array.isArray(blocks)
    ? blocks
        .map(block => block as { type?: unknown; text?: unknown })
        .filter(
          (block): block is { type: 'text'; text: string } =>
            block.type === 'text' && typeof block.text === 'string',
        )
        .map(block => block.text)
        .join('\n')
    : ''

  return {
    model: assistant.message?.model ?? 'unknown',
    role: 'assistant',
    content: { type: 'text', text },
    stopReason: mapSamplingStopReason(assistant.message?.stop_reason),
  }
}

/**
 * Install the capability responders for an interactive CLI host.
 *
 * Elicitation is only advertised when the session has a UI that can answer it;
 * sampling is only advertised when the user opted in.
 */
export function installCliMcpCapabilities(options: {
  interactive: boolean
}): void {
  const responders: McpCapabilityResponders = {}

  if (options.interactive) {
    responders.elicit = elicitFromUser
    responders.elicitationModes = ['form', 'url']
  }

  if (isSamplingEnabled()) {
    responders.sample = sampleFromHost
  }

  setMcpCapabilityResponders(responders)
}
