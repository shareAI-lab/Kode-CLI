import { Box } from 'ink'
import type { ToolUseBlockParam } from '@anthropic-ai/sdk/resources/index.mjs'
import * as React from 'react'
import { useMemo, useRef } from 'react'
import type { ReactNode } from 'react'
import { Message } from '#ui-ink/components/Message'
import { MessageResponse } from '#ui-ink/components/MessageResponse'
import type { Message as MessageType } from '#core/query'
import type { Tool } from '#core/tooling/Tool'
import {
  getErroredToolUseMessages,
  getInProgressToolUseIDs,
  getToolUseID,
  getUnresolvedToolUseIDs,
  INTERRUPT_MESSAGE,
  isNotEmptyMessage,
  normalizeMessagesIncremental,
  reorderMessages,
  type IncrementalNormalizeMessagesCache,
  type NormalizedMessage,
} from '#core/utils/messages'
import { getTheme } from '#core/utils/theme'
import { getReplStaticPrefixLength } from '#cli-utils/replStaticSplit'
import {
  buildTranscriptRenderModel,
  type TranscriptChunkState,
} from './transcriptRenderModel'

export type TranscriptItem = { jsx: ReactNode; key: string }

const EMPTY_TOOL_USE_IDS = new Set<string>()

export function useTranscriptItems(args: {
  messages: MessageType[]
  tools: Tool[]
  verbose: boolean
  debug: boolean
  toolJSX: {
    jsx: ReactNode | null
    shouldHidePromptInput: boolean
    displayMode?: 'inline' | 'fullscreen'
  } | null
  toolUseConfirm: unknown | null
  isMessageSelectorVisible: boolean
  forkNumber: number
  keepRecentInFrame?: boolean
}): {
  normalizedMessages: NormalizedMessage[]
  orderedMessages: NormalizedMessage[]
  unresolvedToolUseIDs: Set<string>
  inProgressToolUseIDs: Set<string>
  erroredToolUseIDs: Set<string>
  replStaticPrefixLength: number
  items: TranscriptItem[]
} {
  const chunkStateRef = useRef<Map<string, TranscriptChunkState>>(new Map())
  const normalizedCacheRef = useRef<IncrementalNormalizeMessagesCache | null>(
    null,
  )
  const normalizedMessages = useMemo(() => {
    const snapshot = normalizeMessagesIncremental({
      messages: args.messages,
      previous: normalizedCacheRef.current,
    })
    normalizedCacheRef.current = snapshot
    return snapshot.normalizedMessages.filter(isNotEmptyMessage)
  }, [args.messages])

  const unresolvedToolUseIDs = useMemo(
    () => getUnresolvedToolUseIDs(normalizedMessages),
    [normalizedMessages],
  )

  const inProgressToolUseIDs = useMemo(
    () => getInProgressToolUseIDs(normalizedMessages, unresolvedToolUseIDs),
    [normalizedMessages, unresolvedToolUseIDs],
  )

  const erroredToolUseIDs = useMemo(
    () =>
      new Set(
        getErroredToolUseMessages(normalizedMessages).map(
          _ => (_.message.content[0]! as ToolUseBlockParam).id,
        ),
      ),
    [normalizedMessages],
  )

  const orderedMessages = useMemo(
    () => reorderMessages(normalizedMessages),
    [normalizedMessages],
  )

  const replStaticPrefixLength = useMemo(
    () =>
      getReplStaticPrefixLength(
        orderedMessages,
        normalizedMessages,
        unresolvedToolUseIDs,
        args.keepRecentInFrame,
      ),
    [
      orderedMessages,
      normalizedMessages,
      unresolvedToolUseIDs,
      args.keepRecentInFrame,
    ],
  )

  const chunked = useMemo(
    () =>
      buildTranscriptRenderModel({
        orderedMessages,
        replStaticPrefixLength,
        chunkState: chunkStateRef.current,
      }),
    [orderedMessages, replStaticPrefixLength],
  )

  const items = useMemo(() => {
    const theme = getTheme()

    return chunked.renderMessages.map(
      ({ message, key, isTransient }, index) => {
        const toolUseID = getToolUseID(message)
        const isInStaticPrefix = index < chunked.replStaticPrefixLength

        const rendered =
          message.type === 'progress' ? (
            message.content.message.content[0]?.type === 'text' &&
            message.content.message.content[0].text === INTERRUPT_MESSAGE ? (
              <Message
                message={message.content}
                messages={message.normalizedMessages}
                addMargin={false}
                tools={message.tools}
                verbose={args.verbose}
                debug={args.debug}
                erroredToolUseIDs={EMPTY_TOOL_USE_IDS}
                inProgressToolUseIDs={EMPTY_TOOL_USE_IDS}
                unresolvedToolUseIDs={EMPTY_TOOL_USE_IDS}
                shouldAnimate={false}
                shouldShowDot={false}
                isTransient={isTransient}
              />
            ) : (
              <MessageResponse
                children={
                  <Message
                    message={message.content}
                    messages={message.normalizedMessages}
                    addMargin={false}
                    tools={message.tools}
                    verbose={args.verbose}
                    debug={args.debug}
                    erroredToolUseIDs={EMPTY_TOOL_USE_IDS}
                    inProgressToolUseIDs={EMPTY_TOOL_USE_IDS}
                    unresolvedToolUseIDs={
                      new Set([
                        (
                          message.content.message
                            .content[0]! as ToolUseBlockParam
                        ).id,
                      ])
                    }
                    shouldAnimate={false}
                    shouldShowDot={false}
                    isTransient={isTransient}
                  />
                }
              />
            )
          ) : (
            <Message
              message={message}
              messages={normalizedMessages}
              addMargin={true}
              tools={args.tools}
              verbose={args.verbose}
              debug={args.debug}
              erroredToolUseIDs={erroredToolUseIDs}
              inProgressToolUseIDs={inProgressToolUseIDs}
              shouldAnimate={
                !args.toolJSX &&
                !args.toolUseConfirm &&
                !args.isMessageSelectorVisible &&
                (!toolUseID || inProgressToolUseIDs.has(toolUseID))
              }
              shouldShowDot={true}
              unresolvedToolUseIDs={unresolvedToolUseIDs}
              isTransient={isTransient}
            />
          )

        if (args.debug) {
          return {
            key,
            jsx: (
              <Box
                borderStyle="single"
                borderColor={isInStaticPrefix ? theme.success : theme.error}
                key={key}
                width="100%"
              >
                {rendered}
              </Box>
            ),
          }
        }

        return {
          key,
          jsx: (
            <Box key={key} width="100%">
              {rendered}
            </Box>
          ),
        }
      },
    )
  }, [
    args.debug,
    args.isMessageSelectorVisible,
    args.toolJSX,
    args.toolUseConfirm,
    args.tools,
    args.verbose,
    chunked.renderMessages,
    chunked.replStaticPrefixLength,
    erroredToolUseIDs,
    inProgressToolUseIDs,
    normalizedMessages,
    unresolvedToolUseIDs,
  ])

  return {
    normalizedMessages,
    orderedMessages,
    unresolvedToolUseIDs,
    inProgressToolUseIDs,
    erroredToolUseIDs,
    replStaticPrefixLength: chunked.replStaticPrefixLength,
    items,
  }
}
