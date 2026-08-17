import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { Box, Text } from 'ink'
import figures from 'figures'

import {
  cancelSessionMessage,
  getSessionMessageHistory,
  getSessionMessageInboxSummary,
  listSessionMessageTargets,
  markSessionMessagesRead,
  replyToSessionMessage,
  sendSessionMessage,
  type SessionMessageHistoryItem,
  type SessionMessageInboxSummary,
  type SessionMessageTarget,
} from '@kode/protocol/sessionMessaging'
import { getTheme } from '#core/utils/theme'
import { workspaceSafetyService } from '#core/services/workspaceSafety'
import TextInput from '#ui-ink/components/TextInput'
import { useKeypress } from '#ui-ink/hooks/useKeypress'
import { KEYPRESS_PRIORITY } from '#ui-ink/constants/keypressPriority'
import { ScreenFrame } from '#ui-ink/primitives/layout/ScreenFrame'
import { useScreenLayout } from '#ui-ink/primitives/layout/useScreenLayout'
import { getWindowedList } from '#ui-ink/primitives/list/windowedList'
import { computeAvailableColumns } from '#ui-ink/primitives/layout/viewportColumns'

type Mode = 'history' | 'targets' | 'compose' | 'search'

function clamp(value: number, max: number): number {
  return Math.max(0, Math.min(value, Math.max(0, max)))
}

function compactTime(timestamp: number): string {
  return new Date(timestamp).toLocaleString(undefined, {
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function statusIcon(item: SessionMessageHistoryItem): string {
  if (item.isUnread) return '●'
  if (item.status === 'delivered') return '✓'
  if (item.status === 'cancelled') return '×'
  if (item.status === 'claimed') return '◐'
  if (item.status === 'queued') return '○'
  return '?'
}

export function SessionMessageScreen({
  cwd,
  sessionId,
  onDone,
}: {
  cwd: string
  sessionId: string
  onDone: () => void
}): React.ReactNode {
  const theme = getTheme()
  const layout = useScreenLayout()
  const [mode, setMode] = useState<Mode>('history')
  const [history, setHistory] = useState<SessionMessageHistoryItem[]>([])
  const [targets, setTargets] = useState<SessionMessageTarget[]>([])
  const [summary, setSummary] = useState<SessionMessageInboxSummary>({
    unreadCount: 0,
    senders: [],
  })
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [targetIndex, setTargetIndex] = useState(0)
  const [query, setQuery] = useState('')
  const [queryDraft, setQueryDraft] = useState('')
  const [queryCursorOffset, setQueryCursorOffset] = useState(0)
  const [composeBody, setComposeBody] = useState('')
  const [composeCursorOffset, setComposeCursorOffset] = useState(0)
  const [composeTarget, setComposeTarget] =
    useState<SessionMessageTarget | null>(null)
  const [replyTo, setReplyTo] = useState<SessionMessageHistoryItem | null>(null)
  const [threadId, setThreadId] = useState<string | null>(null)
  const [status, setStatus] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [cancelConfirm, setCancelConfirm] = useState<{
    messageId: string
    expiresAt: number
  } | null>(null)

  const refresh = useCallback(async () => {
    const activeSessionIds = workspaceSafetyService
      .listActivePeers({ cwd })
      .flatMap(peer => (peer.sessionId ? [peer.sessionId] : []))
    const nextTargets = listSessionMessageTargets({
      cwd,
      currentSessionId: sessionId,
      limit: 200,
      activeSessionIds,
    }).filter(target => !target.isCurrent)
    const [nextSummary] = await Promise.all([
      getSessionMessageInboxSummary({ cwd, sessionId }),
    ])
    const nextHistory = getSessionMessageHistory({
      cwd,
      sessionId,
      query: query || undefined,
      threadId: threadId ?? undefined,
      limit: 200,
    })
    setTargets(nextTargets)
    setSummary(nextSummary)
    setHistory(nextHistory)
    setSelectedIndex(index => clamp(index, nextHistory.length - 1))
    setTargetIndex(index => clamp(index, nextTargets.length - 1))
  }, [cwd, query, sessionId, threadId])

  useEffect(() => {
    void refresh().catch(error => {
      setStatus(error instanceof Error ? error.message : String(error))
    })
  }, [refresh])

  const maxVisible = Math.max(
    3,
    layout.rows - (layout.tightLayout ? 13 : layout.compactLayout ? 16 : 19),
  )
  const historyWindow = useMemo(
    () =>
      getWindowedList({
        itemCount: history.length,
        focusIndex: selectedIndex,
        maxVisible,
        indicatorRows: 2,
      }),
    [history.length, maxVisible, selectedIndex],
  )
  const targetWindow = useMemo(
    () =>
      getWindowedList({
        itemCount: targets.length,
        focusIndex: targetIndex,
        maxVisible,
        indicatorRows: 2,
      }),
    [maxVisible, targetIndex, targets.length],
  )
  const selected = history[selectedIndex] ?? null

  const beginReply = useCallback(() => {
    if (!selected) {
      setStatus('No message selected')
      return
    }
    setReplyTo(selected)
    setComposeTarget(null)
    setComposeBody('')
    setComposeCursorOffset(0)
    setMode('compose')
    setStatus(null)
  }, [selected])

  const beginNewMessage = useCallback(() => {
    if (targets.length === 0) {
      setStatus('No other persisted session is available in this workspace')
      return
    }
    setReplyTo(null)
    setComposeTarget(null)
    setTargetIndex(0)
    setMode('targets')
    setStatus(null)
  }, [targets.length])

  const sendComposed = useCallback(async () => {
    const body = composeBody.trim()
    if (!body || busy) return
    setBusy(true)
    setStatus(replyTo ? 'Sending reply…' : 'Sending message…')
    try {
      const message = replyTo
        ? await replyToSessionMessage({
            cwd,
            sessionId,
            messageId: replyTo.message.messageId,
            body,
          })
        : await sendSessionMessage({
            cwd,
            senderSessionId: sessionId,
            targetSessionId: composeTarget!.sessionId,
            body,
          })
      setComposeBody('')
      setComposeCursorOffset(0)
      setReplyTo(null)
      setComposeTarget(null)
      setThreadId(message.threadId)
      setMode('history')
      setStatus(
        `Queued ${message.messageId.slice(0, 8)} in thread ${message.threadId.slice(0, 8)}`,
      )
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }, [busy, composeBody, composeTarget, cwd, replyTo, sessionId])

  useKeypress(
    (input, key) => {
      const char = input.length === 1 ? input : ''
      if (key.escape || (key.ctrl && char === 'c')) {
        onDone()
        return true
      }
      if (key.upArrow || char === 'k') {
        setCancelConfirm(null)
        setSelectedIndex(index => clamp(index - 1, history.length - 1))
        return true
      }
      if (key.downArrow || char === 'j') {
        setCancelConfirm(null)
        setSelectedIndex(index => clamp(index + 1, history.length - 1))
        return true
      }
      if (key.pageUp) {
        setSelectedIndex(index => clamp(index - maxVisible, history.length - 1))
        return true
      }
      if (key.pageDown) {
        setSelectedIndex(index => clamp(index + maxVisible, history.length - 1))
        return true
      }
      if (char === 'n') {
        beginNewMessage()
        return true
      }
      if (char === 'r') {
        beginReply()
        return true
      }
      if (char === '/') {
        setQueryDraft(query)
        setQueryCursorOffset(query.length)
        setMode('search')
        setStatus(null)
        return true
      }
      if (char === 't' && selected) {
        setThreadId(current => (current ? null : selected.message.threadId))
        setSelectedIndex(0)
        return true
      }
      if (char === 'R') {
        void refresh()
        setStatus('Refreshed')
        return true
      }
      if (char === 'm' && selected?.isUnread && !busy) {
        setBusy(true)
        void markSessionMessagesRead({
          cwd,
          sessionId,
          messageIds: [selected.message.messageId],
        })
          .then(() => {
            setStatus(
              `Marked ${selected.message.messageId.slice(0, 8)} as read`,
            )
            return refresh()
          })
          .catch(error => {
            setStatus(error instanceof Error ? error.message : String(error))
          })
          .finally(() => setBusy(false))
        return true
      }
      if (
        char === 'x' &&
        selected?.direction === 'outgoing' &&
        selected.status === 'queued' &&
        !busy
      ) {
        if (
          cancelConfirm?.messageId !== selected.message.messageId ||
          cancelConfirm.expiresAt < Date.now()
        ) {
          setCancelConfirm({
            messageId: selected.message.messageId,
            expiresAt: Date.now() + 4_000,
          })
          setStatus(
            `Press x again to cancel ${selected.message.messageId.slice(0, 8)}`,
          )
          return true
        }
        setCancelConfirm(null)
        setBusy(true)
        void cancelSessionMessage({
          cwd,
          senderSessionId: sessionId,
          messageId: selected.message.messageId,
        })
          .then(() => {
            setStatus(`Cancelled ${selected.message.messageId.slice(0, 8)}`)
            return refresh()
          })
          .catch(error => {
            setStatus(error instanceof Error ? error.message : String(error))
          })
          .finally(() => setBusy(false))
        return true
      }
      return undefined
    },
    {
      isActive: mode === 'history',
      priority: KEYPRESS_PRIORITY.FULLSCREEN_OVERLAY,
    },
  )

  useKeypress(
    (input, key) => {
      const char = input.length === 1 ? input : ''
      if (key.escape || (key.ctrl && char === 'c')) {
        setMode('history')
        return true
      }
      if (key.upArrow || char === 'k') {
        setTargetIndex(index => clamp(index - 1, targets.length - 1))
        return true
      }
      if (key.downArrow || char === 'j') {
        setTargetIndex(index => clamp(index + 1, targets.length - 1))
        return true
      }
      if (key.return) {
        const target = targets[targetIndex]
        if (!target) return true
        setComposeTarget(target)
        setComposeBody('')
        setComposeCursorOffset(0)
        setMode('compose')
        return true
      }
      return undefined
    },
    {
      isActive: mode === 'targets',
      priority: KEYPRESS_PRIORITY.FULLSCREEN_OVERLAY,
    },
  )

  const inputColumns = computeAvailableColumns({
    columns: layout.columns,
    reservedColumns: layout.paddingX * 2 + 4,
  })

  return (
    <ScreenFrame
      title="Session Messages"
      exitState={{ pending: false, keyName: null }}
      paddingX={layout.paddingX}
      paddingY={layout.paddingY}
      gap={layout.gap}
    >
      <Box flexDirection="column" gap={layout.gap}>
        <Text color={theme.secondaryText} wrap="truncate-end">
          {summary.unreadCount} unread · {history.length} shown
          {query ? ` · search: ${query}` : ''}
          {threadId ? ` · thread: ${threadId.slice(0, 8)}` : ''}
        </Text>

        {mode === 'targets' ? (
          <Box flexDirection="column">
            <Text bold>Select a session</Text>
            <Text dimColor>
              {targetWindow.showUpIndicator ? `${figures.arrowUp} More` : ' '}
            </Text>
            {targets
              .slice(targetWindow.start, targetWindow.end)
              .map((target, index) => {
                const absoluteIndex = targetWindow.start + index
                const active = absoluteIndex === targetIndex
                return (
                  <Text
                    key={target.sessionId}
                    bold={active}
                    color={active ? theme.text : theme.secondaryText}
                    wrap="truncate-end"
                  >
                    {active ? figures.pointer : ' '} {target.label} ·{' '}
                    {target.sessionId.slice(0, 8)}
                    {target.isActive ? ' · active now' : ''}
                  </Text>
                )
              })}
            <Text dimColor>
              {targetWindow.showDownIndicator
                ? `${figures.arrowDown} More`
                : ' '}
            </Text>
            <Text dimColor>↑/↓ select · Enter compose · Esc back</Text>
          </Box>
        ) : mode === 'compose' ? (
          <Box flexDirection="column" gap={layout.gap}>
            <Text bold wrap="truncate-end">
              {replyTo
                ? `Reply to ${replyTo.peerLabel} · ${replyTo.message.messageId.slice(0, 8)}`
                : `New message to ${composeTarget?.label ?? 'session'}`}
            </Text>
            <TextInput
              value={composeBody}
              placeholder="Write a clear handoff, question, or finding…"
              onChange={setComposeBody}
              onSubmit={() => void sendComposed()}
              onExit={() => setMode('history')}
              columns={inputColumns}
              maxHeight={Math.max(3, Math.min(8, maxVisible))}
              multiline={true}
              focus={!busy}
              cursorOffset={composeCursorOffset}
              onChangeCursorOffset={setComposeCursorOffset}
            />
            <Text dimColor>
              Enter send · Shift+Enter newline · Esc cancel ·{' '}
              {composeBody.length}
              /16384 chars (UTF-8 byte limit applies)
            </Text>
          </Box>
        ) : mode === 'search' ? (
          <Box flexDirection="column" gap={layout.gap}>
            <Text bold>Search message history</Text>
            <TextInput
              value={queryDraft}
              placeholder="Body, session, message, or thread ID…"
              onChange={setQueryDraft}
              onSubmit={() => {
                setQuery(queryDraft.trim())
                setThreadId(null)
                setSelectedIndex(0)
                setMode('history')
              }}
              onExit={() => setMode('history')}
              columns={inputColumns}
              maxHeight={1}
              focus={true}
              cursorOffset={queryCursorOffset}
              onChangeCursorOffset={setQueryCursorOffset}
            />
            <Text dimColor>
              Enter apply · Esc back · empty search clears filter
            </Text>
          </Box>
        ) : (
          <Box flexDirection="column">
            <Text dimColor>
              {historyWindow.showUpIndicator ? `${figures.arrowUp} More` : ' '}
            </Text>
            {history.length === 0 ? (
              <Text dimColor>
                No messages. Press n to start a conversation with another
                session.
              </Text>
            ) : (
              history
                .slice(historyWindow.start, historyWindow.end)
                .map((item, index) => {
                  const absoluteIndex = historyWindow.start + index
                  const active = absoluteIndex === selectedIndex
                  const direction = item.direction === 'outgoing' ? '→' : '←'
                  return (
                    <Box key={item.message.messageId} flexDirection="column">
                      <Text
                        bold={active || item.isUnread}
                        color={active ? theme.text : theme.secondaryText}
                        wrap="truncate-end"
                      >
                        {active ? figures.pointer : ' '} {statusIcon(item)}{' '}
                        {direction} {item.peerLabel} ·{' '}
                        {compactTime(item.message.sentAt)} ·{' '}
                        {item.message.messageId.slice(0, 8)}
                      </Text>
                      <Text
                        color={active ? theme.text : theme.secondaryText}
                        dimColor={!active && !item.isUnread}
                        wrap="truncate-end"
                      >
                        {'   '}
                        {item.message.replyToMessageId ? '↳ ' : ''}
                        {item.message.body.replace(/\s+/g, ' ')}
                      </Text>
                    </Box>
                  )
                })
            )}
            <Text dimColor>
              {historyWindow.showDownIndicator
                ? `${figures.arrowDown} More`
                : ' '}
            </Text>
            <Text dimColor wrap="truncate-end">
              ↑/↓ navigate · n new · r reply · m read · x cancel queued · t
              thread/all · / search · R refresh · Esc close
            </Text>
          </Box>
        )}

        <Text
          color={
            status?.toLowerCase().includes('unable')
              ? theme.error
              : theme.secondaryText
          }
          wrap="truncate-end"
        >
          {busy
            ? 'Working…'
            : (status ??
              'Messages are local, durable, and limited to this Git workspace.')}
        </Text>
      </Box>
    </ScreenFrame>
  )
}
