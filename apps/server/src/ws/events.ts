import type { RawData } from 'ws'
import { isUuid } from '@kode/runtime'

export type ClientWsMessage =
  | {
      type: 'cancel'
      turnId?: string
      clientMessageUuid?: string
    }
  | {
      type: 'permission_response'
      requestId: string
      decision: 'allow_once' | 'allow_always' | 'deny'
      updatedInput: Record<string, unknown> | null
      rejectionMessage: string | null
    }
  | { type: 'fs_read'; path: string }
  | { type: 'fs_write'; path: string; content: string }
  | { type: 'git_branches' }
  | { type: 'git_checkout'; branch: string }
  | { type: 'git_status' }
  | { type: 'git_diff'; path: string; staged: boolean }
  | { type: 'git_stage'; path: string }
  | { type: 'git_commit'; message: string }
  | { type: 'list_sessions' }
  | { type: 'new_session' }
  | { type: 'resume'; sessionId: string }
  | { type: 'prompt'; prompt: string; clientMessageUuid?: string }

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export type LogMessage = {
  type: 'log'
  log: { level: LogLevel; message: string }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function toText(message: RawData): string {
  if (typeof message === 'string') return message
  if (Array.isArray(message)) {
    return message
      .map(part => (typeof part === 'string' ? part : part.toString()))
      .join('')
  }
  return message.toString()
}

export function parseClientWsMessage(message: RawData):
  | {
      ok: true
      value: ClientWsMessage
    }
  | { ok: false; error: string } {
  const text = toText(message)
  let payload: unknown
  try {
    payload = JSON.parse(text)
  } catch {
    return { ok: false, error: 'Invalid JSON message' }
  }

  if (!isRecord(payload)) return { ok: false, error: 'Invalid payload' }

  const type = payload.type
  if (type === 'cancel') {
    const turnId =
      typeof payload.turnId === 'string' ? payload.turnId.trim() : ''
    const clientMessageUuid =
      typeof payload.clientMessageUuid === 'string'
        ? payload.clientMessageUuid.trim()
        : ''
    if (turnId && !isUuid(turnId)) {
      return { ok: false, error: 'Invalid turnId' }
    }
    if (clientMessageUuid && !isUuid(clientMessageUuid)) {
      return { ok: false, error: 'Invalid clientMessageUuid' }
    }
    return {
      ok: true,
      value: {
        type: 'cancel',
        ...(turnId ? { turnId } : {}),
        ...(clientMessageUuid ? { clientMessageUuid } : {}),
      },
    }
  }
  if (type === 'list_sessions')
    return { ok: true, value: { type: 'list_sessions' } }
  if (type === 'new_session')
    return { ok: true, value: { type: 'new_session' } }

  if (type === 'fs_read') {
    const path = typeof payload.path === 'string' ? payload.path : ''
    if (!path.trim()) return { ok: false, error: 'Invalid path' }
    return { ok: true, value: { type: 'fs_read', path } }
  }

  if (type === 'fs_write') {
    const path = typeof payload.path === 'string' ? payload.path : ''
    const content = typeof payload.content === 'string' ? payload.content : ''
    if (!path.trim()) return { ok: false, error: 'Invalid path' }
    return { ok: true, value: { type: 'fs_write', path, content } }
  }

  if (type === 'git_branches')
    return { ok: true, value: { type: 'git_branches' } }

  if (type === 'git_checkout') {
    const branch = typeof payload.branch === 'string' ? payload.branch : ''
    if (!branch.trim()) return { ok: false, error: 'Invalid branch' }
    return { ok: true, value: { type: 'git_checkout', branch } }
  }

  if (type === 'git_status') return { ok: true, value: { type: 'git_status' } }

  if (type === 'git_diff') {
    const path = typeof payload.path === 'string' ? payload.path : ''
    const staged = payload.staged === true
    if (!path.trim()) return { ok: false, error: 'Invalid path' }
    return { ok: true, value: { type: 'git_diff', path, staged } }
  }

  if (type === 'git_stage') {
    const path = typeof payload.path === 'string' ? payload.path : ''
    if (!path.trim()) return { ok: false, error: 'Invalid path' }
    return { ok: true, value: { type: 'git_stage', path } }
  }

  if (type === 'git_commit') {
    const message = typeof payload.message === 'string' ? payload.message : ''
    if (!message.trim()) return { ok: false, error: 'Invalid commit message' }
    return { ok: true, value: { type: 'git_commit', message } }
  }

  if (type === 'resume') {
    const sessionId =
      typeof payload.session_id === 'string' ? payload.session_id.trim() : ''
    if (!sessionId) return { ok: false, error: 'Invalid session_id' }
    return { ok: true, value: { type: 'resume', sessionId } }
  }

  if (type === 'prompt') {
    const prompt = typeof payload.prompt === 'string' ? payload.prompt : ''
    if (!prompt.trim()) return { ok: false, error: 'Missing prompt' }
    const clientMessageUuid =
      typeof payload.clientMessageUuid === 'string'
        ? payload.clientMessageUuid.trim()
        : ''
    if (clientMessageUuid && !isUuid(clientMessageUuid)) {
      return { ok: false, error: 'Invalid clientMessageUuid' }
    }
    return {
      ok: true,
      value: {
        type: 'prompt',
        prompt,
        ...(clientMessageUuid ? { clientMessageUuid } : {}),
      },
    }
  }

  if (type === 'permission_response') {
    const requestId =
      typeof payload.request_id === 'string' ? payload.request_id : ''
    const decision =
      payload.decision === 'allow_once' ||
      payload.decision === 'allow_always' ||
      payload.decision === 'deny'
        ? payload.decision
        : null
    if (!requestId || !decision)
      return { ok: false, error: 'Invalid permission response' }

    const updatedInput = isRecord(payload.updated_input)
      ? payload.updated_input
      : null
    const rejectionMessage =
      typeof payload.rejection_message === 'string'
        ? payload.rejection_message
        : null

    return {
      ok: true,
      value: {
        type: 'permission_response',
        requestId,
        decision,
        updatedInput,
        rejectionMessage,
      },
    }
  }

  return { ok: false, error: `Unsupported message type: ${String(type)}` }
}

export function sendJson(
  ws: { send: (data: string) => void },
  payload: unknown,
): void {
  ws.send(JSON.stringify(payload))
}

export function log(level: LogLevel, message: string): LogMessage {
  return { type: 'log', log: { level, message } }
}
