import React from 'react'

import type { Command } from '../types'
import {
  cancelSessionMessage,
  getSessionMessageHistory,
  getSessionMessageInboxSummary,
  getSessionMessageStatus,
  listSessionMessageTargets,
  markSessionMessagesRead,
  peekSessionMessages,
  replyToSessionMessage,
  resolveSessionMessageTarget,
  sendSessionMessage,
  SessionMessageError,
} from '@kode/protocol/sessionMessaging'
import { getCwd } from '#core/utils/state'
import { getEffectiveSessionId } from '#core/utils/sessionId'
import { workspaceSafetyService } from '#core/services/workspaceSafety'
import { SessionMessageScreen } from '#ui-ink/screens/overlays/SessionMessageScreen'

const USAGE = [
  'Usage:',
  '  /sm                         Open the interactive message center',
  '  /sm list                    List same-workspace sessions',
  '  /sm send <session> <text>   Send a durable message',
  '  /sm reply <message> <text>  Reply in the same thread',
  '  /sm inbox                   Show pending messages and unread count',
  '  /sm history [query]         Search sent and received history',
  '  /sm read <message|all>      Mark pending messages read in the UI',
  '  /sm cancel <message>        Withdraw a queued outgoing message',
  '  /sm status <message>        Check queued/claimed/delivered status',
].join('\n')

function formatError(error: unknown): string {
  if (error instanceof SessionMessageError) {
    return `Session message error (${error.code}): ${error.message}`
  }
  return `Session message error: ${error instanceof Error ? error.message : String(error)}`
}

function splitIdentifierAndBody(rest: string): {
  identifier: string
  body: string
} | null {
  const separator = rest.search(/\s/)
  if (separator === -1) return null
  const identifier = rest.slice(0, separator).trim()
  const body = rest.slice(separator).trim()
  if (!identifier || !body) return null
  return { identifier, body }
}

function boundedBody(body: string, maxCharacters = 1_000): string {
  return body.length > maxCharacters
    ? `${body.slice(0, maxCharacters)}\n[message preview truncated]`
    : body
}

export async function runSessionMessageCommand(args: string): Promise<string> {
  const cwd = getCwd()
  const currentSessionId = getEffectiveSessionId()
  const raw = args.trim()
  const separator = raw.search(/\s/)
  const action = (
    separator === -1 ? raw : raw.slice(0, separator)
  ).toLowerCase()
  const rest = separator === -1 ? '' : raw.slice(separator).trim()

  try {
    if (action === 'list') {
      const activeSessionIds = workspaceSafetyService
        .listActivePeers({ cwd })
        .flatMap(peer => (peer.sessionId ? [peer.sessionId] : []))
      const sessions = listSessionMessageTargets({
        cwd,
        currentSessionId,
        activeSessionIds,
      })
      if (sessions.length === 0) {
        return 'No persisted sessions are available in this workspace.'
      }
      return [
        `Workspace sessions (current: ${currentSessionId})`,
        ...sessions.map(session => {
          const current = session.isCurrent ? '  [current]' : ''
          const modified = session.modifiedAt
            ? `  ${new Date(session.modifiedAt).toISOString()}`
            : ''
          const active =
            session.isActive && !session.isCurrent ? '  [active]' : ''
          return `${session.sessionId}  ${session.label}${current}${active}${modified}`
        }),
        '',
        'Send with: /sm send <session-id-or-prefix> <message>',
      ].join('\n')
    }

    if (action === 'inbox') {
      const [messages, summary] = await Promise.all([
        peekSessionMessages({ cwd, sessionId: currentSessionId }),
        getSessionMessageInboxSummary({ cwd, sessionId: currentSessionId }),
      ])
      if (messages.length === 0) return 'Session inbox is empty.'
      return [
        `Pending: ${messages.length} · Unread: ${summary.unreadCount}`,
        ...messages.flatMap(message => [
          '',
          `${message.messageId}  from=${message.senderSessionId}  ${new Date(message.sentAt).toISOString()}`,
          `thread=${message.threadId}${message.replyToMessageId ? `  reply_to=${message.replyToMessageId}` : ''}`,
          boundedBody(message.body),
        ]),
        '',
        'Pending messages enter this session model context on the next normal prompt.',
      ].join('\n')
    }

    if (action === 'history') {
      const history = getSessionMessageHistory({
        cwd,
        sessionId: currentSessionId,
        query: rest || undefined,
        limit: 50,
      })
      if (history.length === 0) return 'No session message history found.'
      return [
        `Session message history: ${history.length}`,
        ...history.flatMap(item => [
          '',
          `${item.message.messageId}  ${item.direction === 'outgoing' ? 'to' : 'from'}=${item.peerLabel}  status=${item.status}${item.isUnread ? '  [unread]' : ''}`,
          `sent=${new Date(item.message.sentAt).toISOString()}  thread=${item.message.threadId}`,
          boundedBody(item.message.body),
        ]),
      ].join('\n')
    }

    if (action === 'status') {
      if (!rest) return `${USAGE}\nA message ID is required for status.`
      const status = getSessionMessageStatus({
        cwd,
        senderSessionId: currentSessionId,
        messageId: rest,
      })
      if (status.status === 'unknown') {
        return `No delivery record found for message: ${status.messageId}`
      }
      if (status.status === 'delivered') {
        return `Delivered ${status.messageId} to ${status.targetSessionId} at ${new Date(status.deliveredAt).toISOString()}.`
      }
      if (status.status === 'cancelled') {
        return `Cancelled ${status.messageId} at ${new Date(status.cancelledAt).toISOString()}.`
      }
      return `${status.messageId} is ${status.status} for ${status.targetSessionId}.`
    }

    if (action === 'send') {
      const parsed = splitIdentifierAndBody(rest)
      if (!parsed) {
        return `${USAGE}\nA target and non-empty message are required.`
      }
      const target = resolveSessionMessageTarget({
        cwd,
        currentSessionId,
        identifier: parsed.identifier,
      })
      const message = await sendSessionMessage({
        cwd,
        senderSessionId: currentSessionId,
        targetSessionId: target.sessionId,
        body: parsed.body,
      })
      return [
        `Queued message ${message.messageId}`,
        `Target: ${target.label} (${target.sessionId})`,
        `Thread: ${message.threadId}`,
        "It will enter the target session context on that session's next normal prompt.",
        `Reply: /sm reply ${message.messageId.slice(0, 8)} <message>`,
        `Cancel while queued: /sm cancel ${message.messageId.slice(0, 8)}`,
      ].join('\n')
    }

    if (action === 'reply') {
      const parsed = splitIdentifierAndBody(rest)
      if (!parsed) {
        return `${USAGE}\nA message ID and non-empty reply are required.`
      }
      const message = await replyToSessionMessage({
        cwd,
        sessionId: currentSessionId,
        messageId: parsed.identifier,
        body: parsed.body,
      })
      return [
        `Queued reply ${message.messageId}`,
        `Target: ${message.targetSessionId}`,
        `Thread: ${message.threadId}`,
        `Reply to: ${message.replyToMessageId}`,
      ].join('\n')
    }

    if (action === 'cancel') {
      if (!rest) return `${USAGE}\nA message ID is required for cancel.`
      const status = await cancelSessionMessage({
        cwd,
        senderSessionId: currentSessionId,
        messageId: rest,
      })
      return status.status === 'cancelled'
        ? `Cancelled queued message ${status.messageId}.`
        : `Unable to cancel message ${rest}.`
    }

    if (action === 'read') {
      if (!rest) return `${USAGE}\nA message ID or "all" is required for read.`
      if (rest.toLowerCase() !== 'all' && rest.length < 8) {
        return 'Use a message ID prefix of at least 8 characters.'
      }
      const pending = await peekSessionMessages({
        cwd,
        sessionId: currentSessionId,
        limit: 256,
      })
      const messageIds =
        rest.toLowerCase() === 'all'
          ? pending.map(message => message.messageId)
          : pending
              .filter(message =>
                message.messageId.startsWith(rest.toLowerCase()),
              )
              .map(message => message.messageId)
      if (messageIds.length === 0) return `No pending message found: ${rest}`
      if (rest.toLowerCase() !== 'all' && messageIds.length > 1) {
        return `Message ID prefix is ambiguous: ${rest}`
      }
      const marked = await markSessionMessagesRead({
        cwd,
        sessionId: currentSessionId,
        messageIds,
      })
      return `Marked ${marked} pending message${marked === 1 ? '' : 's'} as read.`
    }

    return USAGE
  } catch (error) {
    return formatError(error)
  }
}

const sessionMessage = {
  type: 'local-jsx',
  name: 'session-message',
  aliases: ['sm'],
  description: 'Open the durable cross-session messaging center',
  argumentHint:
    '[list | send | reply | inbox | history | read | cancel | status]',
  isEnabled: true,
  isHidden: false,
  ui: { displayMode: 'fullscreen' },
  disableNonInteractive: true,
  async call(onDone, _context, args) {
    const raw = (args ?? '').trim()
    if (raw) {
      onDone(await runSessionMessageCommand(raw))
      return null
    }
    return React.createElement(SessionMessageScreen, {
      cwd: getCwd(),
      sessionId: getEffectiveSessionId(),
      onDone: () => onDone(),
    })
  },
  userFacingName() {
    return 'session-message'
  },
} satisfies Command

export default sessionMessage
