import { afterEach, describe, expect, test } from 'bun:test'
import React, { useMemo, useState } from 'react'
import { Box } from 'ink'
import { AskUserQuestionPermissionRequest } from '#ui-ink/components/permissions/AskUserQuestionPermissionRequest/AskUserQuestionPermissionRequest'
import { AskUserQuestionTool } from '#tools/tools/interaction/AskUserQuestionTool/AskUserQuestionTool'
import { BashToolRunInBackgroundOverlay } from '#tools/tools/system/BashTool/BashToolRunInBackgroundOverlay'
import {
  createAssistantMessage,
  createProgressMessage,
  normalizeMessages,
  reorderMessages,
} from '#core/utils/messages'
import type { Message as KodeMessage } from '#core/query'
import { Message } from '#ui-ink/components/Message'
import { MessageResponse } from '#ui-ink/components/MessageResponse'
import {
  FAST_RETURN_TIMEOUT,
  KeypressProvider,
} from '#ui-ink/contexts/KeypressContext'
import { createInkHarnessManager, createInkTestHarness } from './inkTestHarness'

const harnessManager = createInkHarnessManager()

afterEach(async () => {
  await harnessManager.cleanup()
})

describe('TUI E2E regression (Ink render): Misc', () => {
  test('AskUserQuestion: select Other, type, Enter submits answer', async () => {
    let allowed = false
    let done = false
    const input: any = {
      questions: [
        {
          question: 'What type of Snake game would you like?',
          header: 'Snake Game Requirements',
          multiSelect: false,
          options: [
            {
              label: 'HTML5 Canvas version (web browser)',
              description: 'Playable in browser',
            },
            {
              label: 'Terminal/Console version',
              description: 'Playable in terminal',
            },
          ],
        },
      ],
    }

    const toolUseConfirm: any = {
      assistantMessage: createAssistantMessage(''),
      tool: AskUserQuestionTool,
      description: 'Ask user question',
      input,
      commandPrefix: null,
      toolUseContext: {
        messageId: 'm',
        abortController: new AbortController(),
        readFileTimestamps: {},
      },
      riskScore: null,
      onAbort: () => {},
      onAllow: () => {
        allowed = true
      },
      onReject: () => {},
    }

    const h = createInkTestHarness(
      <KeypressProvider>
        <AskUserQuestionPermissionRequest
          toolUseConfirm={toolUseConfirm}
          onDone={() => {
            done = true
          }}
          verbose={false}
        />
      </KeypressProvider>,
    )
    harnessManager.track(h)

    const waitForOutput = async (text: string) => {
      const deadline = Date.now() + 2_000
      while (!h.getOutput().includes(text) && Date.now() < deadline) {
        await h.wait(10)
      }
      expect(h.getOutput()).toContain(text)
    }

    await h.wait(25)

    h.stdin.write('\u001B[B')
    await h.wait(10)
    h.stdin.write('\u001B[B')
    await waitForOutput('Type something.')

    let typed = ''
    for (const ch of 'threejs') {
      h.stdin.write(ch)
      typed += ch
      // Wait for the committed input frame before sending the next key.
      // Fixed 5 ms gaps can race React updates and drop the second 'e' in CI.
      await waitForOutput(`${typed}▌`)
    }

    // Avoid KeypressProvider's "fast return" heuristic (treats rapid enter after typing as insertable).
    await h.wait(FAST_RETURN_TIMEOUT + 10)
    h.stdin.write('\r')
    await h.wait(25)

    expect(allowed).toBe(true)
    expect(done).toBe(true)
    const stored =
      toolUseConfirm.toolUseContext.options?.askUserQuestionAnswersByToolUseId
        ?.m
    expect(stored?.['What type of Snake game would you like?']).toBe('threejs')
  })

  test('Bash overlay: ctrl+b triggers background callback', async () => {
    let backgrounded = false
    const h = createInkTestHarness(
      <BashToolRunInBackgroundOverlay
        onBackground={() => {
          backgrounded = true
        }}
      />,
    )
    harnessManager.track(h)

    await h.wait(25)

    h.stdin.write('\x02')
    await h.wait(25)

    expect(backgrounded).toBe(true)
  })

  test('queued Waiting… progress is replaced by Running… for same tool_use_id', async () => {
    const toolUseId = 't2'
    const siblings = new Set<string>(['t1', toolUseId])

    const waiting = createProgressMessage(
      toolUseId,
      siblings,
      createAssistantMessage('<tool-progress>Waiting…</tool-progress>'),
      [],
      [],
    )

    const running = createProgressMessage(
      toolUseId,
      siblings,
      createAssistantMessage('<tool-progress>Running…</tool-progress>'),
      [],
      [],
    )

    function MessagesHarness({
      messages,
    }: {
      messages: KodeMessage[]
    }): React.ReactNode {
      const normalized = useMemo(() => normalizeMessages(messages), [messages])
      const ordered = useMemo(() => reorderMessages(normalized), [normalized])

      return (
        <Box flexDirection="column">
          {ordered.map(msg => {
            if (msg.type === 'progress') {
              return (
                <React.Fragment key={msg.uuid}>
                  <MessageResponse
                    children={
                      <Message
                        message={msg.content}
                        messages={msg.normalizedMessages}
                        addMargin={false}
                        tools={msg.tools}
                        verbose={false}
                        debug={false}
                        erroredToolUseIDs={new Set()}
                        inProgressToolUseIDs={new Set()}
                        unresolvedToolUseIDs={new Set()}
                        shouldAnimate={false}
                        shouldShowDot={false}
                      />
                    }
                  />
                </React.Fragment>
              )
            }

            if (msg.type !== 'user' && msg.type !== 'assistant') return null

            return (
              <React.Fragment key={msg.uuid}>
                <Message
                  message={msg}
                  messages={normalized}
                  addMargin={true}
                  tools={[]}
                  verbose={false}
                  debug={false}
                  erroredToolUseIDs={new Set()}
                  inProgressToolUseIDs={new Set()}
                  unresolvedToolUseIDs={new Set()}
                  shouldAnimate={false}
                  shouldShowDot={false}
                />
              </React.Fragment>
            )
          })}
        </Box>
      )
    }

    function AutoUpdateMessagesHarness(): React.ReactNode {
      const [messages, setMessages] = useState<KodeMessage[]>([waiting])

      React.useEffect(() => {
        const handle = setTimeout(() => {
          setMessages([waiting, running])
        }, 60)
        return () => clearTimeout(handle)
      }, [])

      return <MessagesHarness messages={messages} />
    }

    const h = createInkTestHarness(<AutoUpdateMessagesHarness />)
    harnessManager.track(h)

    await h.wait(40)
    expect(h.getOutput()).toContain('Waiting…')

    h.clearOutput()
    await h.wait(90)

    expect(h.getOutput()).toContain('Running…')
    expect(h.getOutput()).not.toContain('Waiting…')
  })
})
