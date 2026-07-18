import { afterEach, describe, expect, test } from 'bun:test'
import React, { useEffect, useState } from 'react'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { Box, Text } from 'ink'
import PromptInput from '#ui-ink/components/PromptInput'
import type { PastedImageAttachment } from '#ui-ink/components/PromptInput/pasteTypes'
import type { PromptMode } from '#ui-ink/components/PromptInput/types'
import { KeypressProvider } from '#ui-ink/contexts/KeypressContext'
import { PermissionProvider } from '#ui-ink/contexts/PermissionContext'
import { useCancelRequest } from '#ui-ink/hooks/useCancelRequest'
import { useKeypress } from '#ui-ink/hooks/useKeypress'
import { setCwd } from '#core/utils/state'
import { clearConfigCacheForTesting } from '#config'
import { createInkHarnessManager, createInkTestHarness } from './inkTestHarness'

function PromptInputHarness({
  conversationKey,
  showRaw = false,
}: {
  conversationKey: string
  showRaw?: boolean
}): React.ReactNode {
  const [input, setInput] = useState('')
  const [mode, setMode] = useState<PromptMode>('prompt')
  const [submitCount, setSubmitCount] = useState(0)
  const [abortController, setAbortController] =
    useState<AbortController | null>(null)
  const [isLoading, setIsLoading] = useState(false)

  const prompt = (
    <PromptInput
      commands={[]}
      forkNumber={0}
      messageLogName="tui"
      isDisabled={false}
      isLoading={isLoading}
      onQuery={async () => {}}
      debug={false}
      verbose={false}
      messages={[]}
      setToolJSX={() => {}}
      tools={[]}
      input={input}
      onInputChange={setInput}
      mode={mode}
      onModeChange={setMode}
      submitCount={submitCount}
      onSubmitCountChange={updater => setSubmitCount(prev => updater(prev))}
      setIsLoading={setIsLoading}
      setAbortController={setAbortController}
      onShowMessageSelector={() => {}}
      setForkConvoWithMessagesOnTheNextRender={() => {}}
      readFileTimestamps={{}}
      abortController={abortController}
    />
  )

  return (
    <KeypressProvider>
      <PermissionProvider
        conversationKey={conversationKey}
        isBypassPermissionsModeAvailable={true}
      >
        {showRaw ? (
          <Box flexDirection="column">
            <Text>RAW:{JSON.stringify(input)}</Text>
            <Text>SUBMIT_COUNT:{submitCount}</Text>
            {prompt}
          </Box>
        ) : (
          prompt
        )}
      </PermissionProvider>
    </KeypressProvider>
  )
}

function PromptInputCancelHarness({
  conversationKey,
  initialIsLoading,
}: {
  conversationKey: string
  initialIsLoading: boolean
}): React.ReactNode {
  return (
    <KeypressProvider>
      <PermissionProvider
        conversationKey={conversationKey}
        isBypassPermissionsModeAvailable={true}
      >
        <PromptInputCancelHarnessInner initialIsLoading={initialIsLoading} />
      </PermissionProvider>
    </KeypressProvider>
  )
}

function PromptInputCancelHarnessInner({
  initialIsLoading,
}: {
  initialIsLoading: boolean
}): React.ReactNode {
  const [input, setInput] = useState('')
  const [mode, setMode] = useState<PromptMode>('prompt')
  const [submitCount, setSubmitCount] = useState(0)
  const [abortController, setAbortController] =
    useState<AbortController | null>(() => new AbortController())
  const [isLoading, setIsLoading] = useState(initialIsLoading)
  const [cancelled, setCancelled] = useState(false)
  const [queryCount, setQueryCount] = useState(0)
  const [cancelRequestKey, setCancelRequestKey] = useState(0)

  useCancelRequest(
    () => {},
    () => {},
    () => {},
    () => {
      abortController?.abort()
      setCancelRequestKey(prev => prev + 1)
      setCancelled(true)
      setIsLoading(false)
    },
    isLoading,
    false,
    abortController?.signal,
  )

  return (
    <Box flexDirection="column">
      <Text>RAW:{JSON.stringify(input)}</Text>
      <Text>LOADING:{String(isLoading)}</Text>
      <Text>ABORTED:{String(abortController?.signal.aborted ?? false)}</Text>
      <Text>CANCELLED:{String(cancelled)}</Text>
      <Text>QUERY_COUNT:{queryCount}</Text>
      <PromptInput
        commands={[]}
        forkNumber={0}
        messageLogName="tui"
        isDisabled={false}
        isLoading={isLoading}
        onQuery={async () => {
          setQueryCount(prev => prev + 1)
          setIsLoading(false)
        }}
        debug={false}
        verbose={false}
        messages={[]}
        setToolJSX={() => {}}
        tools={[]}
        input={input}
        onInputChange={setInput}
        mode={mode}
        onModeChange={setMode}
        submitCount={submitCount}
        onSubmitCountChange={updater => setSubmitCount(prev => updater(prev))}
        setIsLoading={setIsLoading}
        setAbortController={setAbortController}
        onShowMessageSelector={() => {}}
        setForkConvoWithMessagesOnTheNextRender={() => {}}
        readFileTimestamps={{}}
        abortController={abortController}
        cancelRequestKey={cancelRequestKey}
      />
    </Box>
  )
}

function PromptInputCtrlCCancelHarness({
  conversationKey,
  initialIsLoading,
}: {
  conversationKey: string
  initialIsLoading: boolean
}): React.ReactNode {
  return (
    <KeypressProvider>
      <PermissionProvider
        conversationKey={conversationKey}
        isBypassPermissionsModeAvailable={true}
      >
        <PromptInputCtrlCCancelHarnessInner
          initialIsLoading={initialIsLoading}
        />
      </PermissionProvider>
    </KeypressProvider>
  )
}

function PromptInputCtrlCCancelHarnessInner({
  initialIsLoading,
}: {
  initialIsLoading: boolean
}): React.ReactNode {
  const [input, setInput] = useState('')
  const [mode, setMode] = useState<PromptMode>('prompt')
  const [submitCount, setSubmitCount] = useState(0)
  const [abortController] = useState<AbortController | null>(
    () => new AbortController(),
  )
  const [isLoading, setIsLoading] = useState(initialIsLoading)
  const [cancelled, setCancelled] = useState(false)

  useKeypress(
    (inputChar, key) => {
      if (key.ctrl && inputChar === 'c' && isLoading) {
        abortController?.abort()
        setCancelled(true)
        setIsLoading(false)
        return true
      }
    },
    { priority: 50 },
  )

  return (
    <Box flexDirection="column">
      <Text>RAW:{JSON.stringify(input)}</Text>
      <Text>LOADING:{String(isLoading)}</Text>
      <Text>ABORTED:{String(abortController?.signal.aborted ?? false)}</Text>
      <Text>CANCELLED:{String(cancelled)}</Text>
      <PromptInput
        commands={[]}
        forkNumber={0}
        messageLogName="tui"
        isDisabled={false}
        isLoading={isLoading}
        onQuery={async () => {}}
        debug={false}
        verbose={false}
        messages={[]}
        setToolJSX={() => {}}
        tools={[]}
        input={input}
        onInputChange={setInput}
        mode={mode}
        onModeChange={setMode}
        submitCount={submitCount}
        onSubmitCountChange={updater => setSubmitCount(prev => updater(prev))}
        setIsLoading={setIsLoading}
        setAbortController={() => {}}
        onShowMessageSelector={() => {}}
        setForkConvoWithMessagesOnTheNextRender={() => {}}
        readFileTimestamps={{}}
        abortController={abortController}
      />
    </Box>
  )
}

function DraftPastePersistenceHarness({
  conversationKey,
}: {
  conversationKey: string
}): React.ReactNode {
  return (
    <KeypressProvider>
      <PermissionProvider
        conversationKey={conversationKey}
        isBypassPermissionsModeAvailable={true}
      >
        <DraftPastePersistenceHarnessInner />
      </PermissionProvider>
    </KeypressProvider>
  )
}

function DraftPastePersistenceHarnessInner(): React.ReactNode {
  const [input, setInput] = useState('hello [Pasted text #1] world')
  const [mode, setMode] = useState<PromptMode>('prompt')
  const [submitCount, setSubmitCount] = useState(0)
  const [abortController, setAbortController] =
    useState<AbortController | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [showPrompt, setShowPrompt] = useState(true)
  const [draftPastes, setDraftPastes] = useState<{
    pastedTexts: Array<{ placeholder: string; text: string }>
    pastedImages: PastedImageAttachment[]
  }>({
    pastedTexts: [{ placeholder: '[Pasted text #1]', text: 'PASTE' }],
    pastedImages: [],
  })
  const [submittedText, setSubmittedText] = useState<string>('')

  useKeypress(
    (inputChar, key) => {
      if (key.ctrl && inputChar === 'g') {
        setShowPrompt(prev => !prev)
        return true
      }
      if (key.ctrl && inputChar === 'r') {
        setInput('hello world')
        return true
      }
    },
    { priority: 50 },
  )

  return (
    <Box flexDirection="column">
      <Text>SUB:{JSON.stringify(submittedText)}</Text>
      <Text>DRAFT:{JSON.stringify(draftPastes)}</Text>
      {showPrompt ? (
        <PromptInput
          commands={[]}
          forkNumber={0}
          messageLogName="tui"
          isDisabled={false}
          isLoading={isLoading}
          onQuery={async newMessages => {
            const lastUser = [...newMessages]
              .reverse()
              .find(m => m.type === 'user') as any
            const content = lastUser?.message?.content
            const text =
              typeof content === 'string'
                ? content
                : Array.isArray(content)
                  ? content
                      .map(block =>
                        typeof block === 'string'
                          ? block
                          : typeof (block as any)?.text === 'string'
                            ? (block as any).text
                            : '',
                      )
                      .join('')
                  : ''

            setSubmittedText(text)
            setIsLoading(false)
            setAbortController(null)
          }}
          debug={false}
          verbose={false}
          messages={[]}
          setToolJSX={() => {}}
          tools={[]}
          input={input}
          onInputChange={setInput}
          mode={mode}
          onModeChange={setMode}
          submitCount={submitCount}
          onSubmitCountChange={updater => setSubmitCount(prev => updater(prev))}
          setIsLoading={setIsLoading}
          setAbortController={setAbortController}
          onShowMessageSelector={() => {}}
          setForkConvoWithMessagesOnTheNextRender={() => {}}
          readFileTimestamps={{}}
          abortController={abortController}
          draftPastes={draftPastes}
          onDraftPastesChange={setDraftPastes}
        />
      ) : (
        <Text>OVERLAY</Text>
      )}
    </Box>
  )
}

function PromptQueueAutoDrainHarness({
  conversationKey,
}: {
  conversationKey: string
}): React.ReactNode {
  const [input, setInput] = useState('')
  const [mode, setMode] = useState<PromptMode>('prompt')
  const [submitCount, setSubmitCount] = useState(0)
  const [abortController, setAbortController] =
    useState<AbortController | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [processed, setProcessed] = useState<string[]>([])

  useEffect(() => {
    const timeout = setTimeout(() => setIsLoading(false), 600)
    return () => clearTimeout(timeout)
  }, [])

  return (
    <KeypressProvider>
      <PermissionProvider
        conversationKey={conversationKey}
        isBypassPermissionsModeAvailable={true}
      >
        <Box flexDirection="column">
          <Text>PROCESSED:{JSON.stringify(processed)}</Text>
          <Text>LOADING:{String(isLoading)}</Text>
          <PromptInput
            commands={[]}
            forkNumber={0}
            messageLogName="tui"
            isDisabled={false}
            isLoading={isLoading}
            onQuery={async newMessages => {
              const lastUser = [...newMessages]
                .reverse()
                .find(m => m.type === 'user') as any
              const content = lastUser?.message?.content
              const text =
                typeof content === 'string'
                  ? content
                  : Array.isArray(content)
                    ? content
                        .map(block =>
                          typeof block === 'string'
                            ? block
                            : typeof (block as any)?.text === 'string'
                              ? (block as any).text
                              : '',
                        )
                        .join('')
                    : ''

              setProcessed(prev => [...prev, text])
              setIsLoading(false)
              setAbortController(null)
            }}
            debug={false}
            verbose={false}
            messages={[]}
            setToolJSX={() => {}}
            tools={[]}
            input={input}
            onInputChange={setInput}
            mode={mode}
            onModeChange={setMode}
            submitCount={submitCount}
            onSubmitCountChange={updater =>
              setSubmitCount(prev => updater(prev))
            }
            setIsLoading={setIsLoading}
            setAbortController={setAbortController}
            onShowMessageSelector={() => {}}
            setForkConvoWithMessagesOnTheNextRender={() => {}}
            readFileTimestamps={{}}
            abortController={abortController}
          />
        </Box>
      </PermissionProvider>
    </KeypressProvider>
  )
}

const harnessManager = createInkHarnessManager()

async function waitForOutput(
  harness: ReturnType<typeof createInkTestHarness>,
  expected: string,
  timeoutMs = 3_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (harness.getOutput().includes(expected)) {
      await harness.wait(50)
      return
    }
    await harness.wait(20)
  }
  throw new Error(`Timed out waiting for prompt input output: ${expected}`)
}

afterEach(async () => {
  await harnessManager.cleanup()
})

describe('TUI E2E regression (Ink render): PromptInput', () => {
  test('Completion: Space inserts a space (does not accept suggestion)', async () => {
    await setCwd(process.cwd())

    const conversationKey = `tui:${Math.random().toString(16).slice(2)}`
    const h = createInkTestHarness(
      <PromptInputHarness conversationKey={conversationKey} showRaw={true} />,
    )
    harnessManager.track(h)

    await h.wait(25)
    h.clearOutput()

    h.stdin.write('./d')
    await h.wait(75)
    expect(h.getOutput()).toContain('RAW:\"./d\"')

    h.clearOutput()
    h.stdin.write(' ')
    await h.wait(75)

    const out = h.getOutput()
    expect(out).toContain('RAW:\"./d \"')
    expect(out).not.toContain('RAW:\"./dist/')
    expect(out).not.toContain('RAW:\"loading...')
  })

  test('Completion: Enter submits the current input on the first press', async () => {
    await setCwd(process.cwd())

    const conversationKey = `tui:${Math.random().toString(16).slice(2)}`
    const h = createInkTestHarness(
      <PromptInputHarness conversationKey={conversationKey} showRaw={true} />,
    )
    harnessManager.track(h)

    await h.wait(25)
    h.clearOutput()

    h.stdin.write('./d')
    await h.wait(75)
    expect(h.getOutput()).toContain('RAW:\"./d\"')

    h.clearOutput()
    h.stdin.write('\r')
    await h.wait(200)

    expect(h.getOutput()).toContain('RAW:\"\"')
  })

  test('submit clears the input value', async () => {
    const conversationKey = `tui:${Math.random().toString(16).slice(2)}`
    const h = createInkTestHarness(
      <PromptInputHarness conversationKey={conversationKey} showRaw={true} />,
    )
    harnessManager.track(h)

    await h.wait(25)
    h.clearOutput()

    h.stdin.write('hello')
    await h.wait(75)
    expect(h.getOutput()).toContain('RAW:\"hello\"')

    h.clearOutput()
    h.stdin.write('\r')
    await h.wait(200)

    expect(h.getOutput()).toContain('RAW:\"\"')
  })

  test('rapid Enter after typing submits without requiring a second press', async () => {
    const conversationKey = `tui:${Math.random().toString(16).slice(2)}`
    const h = createInkTestHarness(
      <PromptInputHarness conversationKey={conversationKey} showRaw={true} />,
    )
    harnessManager.track(h)

    await h.wait(25)
    h.clearOutput()

    h.stdin.write('x')
    h.stdin.write('\r')
    await h.wait(200)

    expect(h.getOutput()).toContain('SUBMIT_COUNT:1')
  })

  test('typing and Enter delivered in the same stdin chunk submits on the first press', async () => {
    const conversationKey = `tui:${Math.random().toString(16).slice(2)}`
    const h = createInkTestHarness(
      <PromptInputHarness conversationKey={conversationKey} showRaw={true} />,
    )
    harnessManager.track(h)

    await h.wait(25)
    h.clearOutput()

    h.stdin.write('hello\r')
    await h.wait(200)

    expect(h.getOutput()).toContain('SUBMIT_COUNT:1')
    expect(h.getOutput()).toContain('RAW:""')
  })

  test('non-ASCII input followed by Enter submits on the first intentional press', async () => {
    const conversationKey = `tui:${Math.random().toString(16).slice(2)}`
    const h = createInkTestHarness(
      <PromptInputHarness conversationKey={conversationKey} showRaw={true} />,
    )
    harnessManager.track(h)

    await h.wait(25)
    h.clearOutput()

    h.stdin.write('中文')
    h.stdin.write('\r')
    await h.wait(200)

    expect(h.getOutput()).toContain('SUBMIT_COUNT:1')
    expect(h.getOutput()).toContain('RAW:""')
  })

  test('delayed paste placeholder uses latest cursor position', async () => {
    await setCwd(process.cwd())

    const conversationKey = `tui:${Math.random().toString(16).slice(2)}`
    const h = createInkTestHarness(
      <PromptInputHarness conversationKey={conversationKey} showRaw={true} />,
    )
    harnessManager.track(h)

    await waitForOutput(h, 'RAW:""')
    h.clearOutput()

    h.stdin.write('hi')
    await waitForOutput(h, 'RAW:"hi"')

    // Long paste chunks are aggregated on a timer; typing during that window
    // should not be lost or inserted relative to a stale render closure.
    h.stdin.write('a'.repeat(801))
    await h.wait(25)
    h.stdin.write('!')
    await waitForOutput(h, 'RAW:"hi![Pasted text #1]"')

    expect(h.getOutput()).toContain('RAW:\"hi![Pasted text #1]\"')

    h.stdin.write('\r')
    await h.wait(150)
  })

  test('medium single-line paste folds before rendering full text', async () => {
    await setCwd(process.cwd())

    const conversationKey = `tui:${Math.random().toString(16).slice(2)}`
    const h = createInkTestHarness(
      <PromptInputHarness conversationKey={conversationKey} showRaw={true} />,
    )
    harnessManager.track(h)

    await h.wait(25)
    h.clearOutput()

    h.stdin.write('hi')
    await h.wait(75)
    h.stdin.write('a'.repeat(200))
    await h.wait(350)

    const output = h.getOutput()
    expect(output).toContain('RAW:"hi[Pasted text #1]"')
    expect(output).not.toContain(`RAW:"hi${'a'.repeat(200)}"`)

    h.stdin.write('\r')
    await h.wait(150)
  })

  test('bracketed paste folds promptly without waiting for legacy paste aggregation', async () => {
    await setCwd(process.cwd())

    const conversationKey = `tui:${Math.random().toString(16).slice(2)}`
    const h = createInkTestHarness(
      <PromptInputHarness conversationKey={conversationKey} showRaw={true} />,
    )
    harnessManager.track(h)

    await h.wait(25)
    h.clearOutput()

    h.stdin.write(`\x1b[200~${'a'.repeat(200)}\x1b[201~`)
    await h.wait(75)

    const output = h.getOutput()
    expect(output).toContain('RAW:"[Pasted text #1]"')
    expect(output).not.toContain(`RAW:"${'a'.repeat(200)}"`)

    h.clearOutput()
    h.stdin.write('\r')
    await h.wait(200)

    expect(h.getOutput()).toContain('SUBMIT_COUNT:1')
  })

  test('rapid Enter after a paste-sized chunk shows paste guard without inserting newline', async () => {
    await setCwd(process.cwd())

    const conversationKey = `tui:${Math.random().toString(16).slice(2)}`
    const h = createInkTestHarness(
      <PromptInputHarness conversationKey={conversationKey} showRaw={true} />,
    )
    harnessManager.track(h)

    await h.wait(25)
    h.clearOutput()

    h.stdin.write('a'.repeat(801))
    h.stdin.write('\r')
    await h.wait(100)

    const guardedOutput = h.getOutput()
    expect(guardedOutput).toContain(
      'Paste detected. Added as a placeholder; press Enter to send.',
    )
    expect(guardedOutput).not.toContain('SUBMIT_COUNT:1')
    expect(guardedOutput).not.toContain('RAW:"\\n')

    await h.wait(200)
    expect(h.getOutput()).toContain('RAW:"[Pasted text #1]"')

    h.clearOutput()
    h.stdin.write('\r')
    await h.wait(200)

    expect(h.getOutput()).toContain('SUBMIT_COUNT:1')
  })

  test('shift+tab cycles permission mode in the prompt status line', async () => {
    const conversationKey = `tui:${Math.random().toString(16).slice(2)}`
    const h = createInkTestHarness(
      <PromptInputHarness conversationKey={conversationKey} />,
    )
    harnessManager.track(h)

    await h.wait(25)
    h.clearOutput()

    h.stdin.write('\u001B[Z')
    await h.wait(50)

    expect(h.getOutput()).toContain('Tools Plan (shift+tab)')
    expect(h.getOutput()).not.toContain('Tool permissions:')
  })

  test('shift+enter inserts newline (CSI-u)', async () => {
    const conversationKey = `tui:${Math.random().toString(16).slice(2)}`
    const h = createInkTestHarness(
      <PromptInputHarness conversationKey={conversationKey} showRaw={true} />,
    )
    harnessManager.track(h)

    await h.wait(25)
    h.clearOutput()

    h.stdin.write('hello')
    await h.wait(75)
    expect(h.getOutput()).toContain('RAW:\"hello\"')

    h.clearOutput()
    h.stdin.write('\u001b[13;2u')
    await h.wait(75)

    h.stdin.write('world')
    await h.wait(75)

    expect(h.getOutput()).toContain('RAW:\"hello\\nworld\"')
  })

  test('shift+enter inserts newline (CSI-tilde)', async () => {
    const conversationKey = `tui:${Math.random().toString(16).slice(2)}`
    const h = createInkTestHarness(
      <PromptInputHarness conversationKey={conversationKey} showRaw={true} />,
    )
    harnessManager.track(h)

    await h.wait(25)
    h.clearOutput()

    h.stdin.write('hello')
    await h.wait(75)
    expect(h.getOutput()).toContain('RAW:\"hello\"')

    h.clearOutput()
    h.stdin.write('\u001b[13;2~')
    await h.wait(75)

    h.stdin.write('world')
    await h.wait(75)

    expect(h.getOutput()).toContain('RAW:\"hello\\nworld\"')
  })

  test('CSI-u printable keys insert as text', async () => {
    const conversationKey = `tui:${Math.random().toString(16).slice(2)}`
    const h = createInkTestHarness(
      <PromptInputHarness conversationKey={conversationKey} showRaw={true} />,
    )
    harnessManager.track(h)

    await h.wait(25)
    h.clearOutput()

    // kitty/CSI-u can encode unmodified printable keys as codepoints, e.g. `k` -> ESC[107u
    h.stdin.write('\u001b[107u')
    await h.wait(75)

    expect(h.getOutput()).toContain('RAW:\"k\"')
  })

  test('alt+enter inserts newline (CSI-u)', async () => {
    const conversationKey = `tui:${Math.random().toString(16).slice(2)}`
    const h = createInkTestHarness(
      <PromptInputHarness conversationKey={conversationKey} showRaw={true} />,
    )
    harnessManager.track(h)

    await h.wait(25)
    h.clearOutput()

    h.stdin.write('hello')
    await h.wait(75)
    expect(h.getOutput()).toContain('RAW:\"hello\"')

    h.clearOutput()
    h.stdin.write('\u001b[13;3u')
    await h.wait(75)

    h.stdin.write('world')
    await h.wait(75)

    expect(h.getOutput()).toContain('RAW:\"hello\\nworld\"')
  })

  test('alt+enter inserts newline (ESC+CR)', async () => {
    const conversationKey = `tui:${Math.random().toString(16).slice(2)}`
    const h = createInkTestHarness(
      <PromptInputHarness conversationKey={conversationKey} showRaw={true} />,
    )
    harnessManager.track(h)

    await h.wait(25)
    h.clearOutput()

    h.stdin.write('hello')
    await h.wait(75)
    expect(h.getOutput()).toContain('RAW:\"hello\"')

    h.clearOutput()
    h.stdin.write('\u001b\r')
    await h.wait(75)

    h.stdin.write('world')
    await h.wait(75)

    expect(h.getOutput()).toContain('RAW:\"hello\\nworld\"')
  })

  test('queued prompts auto-drain after a turn completes', async () => {
    const conversationKey = `tui:${Math.random().toString(16).slice(2)}`
    const h = createInkTestHarness(
      <PromptQueueAutoDrainHarness conversationKey={conversationKey} />,
    )
    harnessManager.track(h)

    await h.wait(25)
    h.clearOutput()

    // While "busy", Tab queues to the back.
    h.stdin.write('first')
    await h.wait(75)
    h.stdin.write('\t')
    await h.wait(75)

    // Enter queues to the front (next-up).
    h.stdin.write('urgent')
    await h.wait(75)
    h.stdin.write('\r')
    await h.wait(75)

    // Initial "busy" period elapses, then the queue should drain automatically.
    await h.wait(900)

    expect(h.getOutput()).toContain('PROCESSED:[\"urgent\",\"first\"]')
  })

  test('statusline renders when configured', async () => {
    const originalHome = process.env.HOME
    const originalUserProfile = process.env.USERPROFILE
    const originalEnabled = process.env.KODE_STATUSLINE_ENABLED
    const originalConfigDir = process.env.KODE_CONFIG_DIR

    const homeDir = mkdtempSync(join(tmpdir(), 'kode-statusline-home-'))
    process.env.HOME = homeDir
    process.env.USERPROFILE = homeDir
    process.env.KODE_STATUSLINE_ENABLED = '1'
    process.env.KODE_CONFIG_DIR = join(homeDir, '.kode')
    clearConfigCacheForTesting()

    mkdirSync(join(homeDir, '.kode'), { recursive: true })
    const cmd =
      process.platform === 'win32'
        ? 'cmd /c echo hello-statusline'
        : "printf 'hello-statusline'"
    writeFileSync(
      join(homeDir, '.kode', 'settings.json'),
      JSON.stringify({ statusLine: cmd }, null, 2) + '\n',
      'utf8',
    )

    try {
      const conversationKey = `tui:${Math.random().toString(16).slice(2)}`
      const h = createInkTestHarness(
        <PromptInputHarness conversationKey={conversationKey} />,
      )
      harnessManager.track(h)

      await h.wait(25)
      await h.wait(1000)

      expect(h.getOutput()).toContain('hello-statusline')
    } finally {
      if (originalHome === undefined) delete process.env.HOME
      else process.env.HOME = originalHome

      if (originalUserProfile === undefined) delete process.env.USERPROFILE
      else process.env.USERPROFILE = originalUserProfile

      if (originalEnabled === undefined)
        delete process.env.KODE_STATUSLINE_ENABLED
      else process.env.KODE_STATUSLINE_ENABLED = originalEnabled

      if (originalConfigDir === undefined) delete process.env.KODE_CONFIG_DIR
      else process.env.KODE_CONFIG_DIR = originalConfigDir

      clearConfigCacheForTesting()
      rmSync(homeDir, { recursive: true, force: true })
    }
  })

  test('Ctrl+C cancels running task', async () => {
    const conversationKey = `tui:${Math.random().toString(16).slice(2)}`
    const h = createInkTestHarness(
      <PromptInputCancelHarness
        conversationKey={conversationKey}
        initialIsLoading={true}
      />,
    )
    harnessManager.track(h)

    await h.wait(25)
    h.clearOutput()

    h.stdin.write('\u0003')
    await h.wait(100)

    const out = h.getOutput()
    expect(out).toContain('LOADING:false')
    expect(out).toContain('ABORTED:true')
    expect(out).toContain('CANCELLED:true')
    expect(out).toContain('QUERY_COUNT:0')
  })

  test('alt+up recalls queued/pending prompt for editing', async () => {
    const conversationKey = `tui:${Math.random().toString(16).slice(2)}`
    const h = createInkTestHarness(
      <PromptInputCancelHarness
        conversationKey={conversationKey}
        initialIsLoading={true}
      />,
    )
    harnessManager.track(h)

    await h.wait(25)
    h.clearOutput()

    // Enter while busy -> pending prompt.
    h.stdin.write('hello')
    await h.wait(75)
    h.stdin.write('\r')
    await h.wait(75)

    // Tab while busy -> queued prompt.
    h.stdin.write('first')
    await h.wait(75)
    h.stdin.write('\t')
    await h.wait(75)

    // Alt+Up recalls the most recent queued/pending item for editing.
    h.stdin.write('\u001b[1;3A')
    await h.wait(75)

    const out = h.getOutput()
    expect(out).toContain('RAW:\"first\"')
    expect(out).toContain('LOADING:true')
    expect(out).toContain('ABORTED:false')
    expect(out).toContain('CANCELLED:false')
  })

  test('Esc cancels running task even when prompts are queued', async () => {
    const conversationKey = `tui:${Math.random().toString(16).slice(2)}`
    const h = createInkTestHarness(
      <PromptInputCancelHarness
        conversationKey={conversationKey}
        initialIsLoading={true}
      />,
    )
    harnessManager.track(h)

    await h.wait(25)
    h.clearOutput()

    h.stdin.write('hello')
    await h.wait(75)

    h.stdin.write('\r')
    await h.wait(75)

    h.stdin.write('\u001b')
    await h.wait(100)

    const out = h.getOutput()
    expect(out).toContain('RAW:\"\"')
    expect(out).toContain('LOADING:false')
    expect(out).toContain('ABORTED:true')
    expect(out).toContain('CANCELLED:true')
    expect(out).toContain('QUERY_COUNT:0')

    await h.wait(700)
    expect(h.getOutput()).toContain('QUERY_COUNT:0')
  })

  test('Ctrl+C cancels running task and discards queued prompts', async () => {
    const conversationKey = `tui:${Math.random().toString(16).slice(2)}`
    const h = createInkTestHarness(
      <PromptInputCancelHarness
        conversationKey={conversationKey}
        initialIsLoading={true}
      />,
    )
    harnessManager.track(h)

    await h.wait(25)
    h.clearOutput()

    h.stdin.write('hello')
    await h.wait(75)

    h.stdin.write('\r')
    await h.wait(75)

    h.stdin.write('\u0003')
    await h.wait(100)

    const out = h.getOutput()
    expect(out).toContain('RAW:\"\"')
    expect(out).toContain('LOADING:false')
    expect(out).toContain('ABORTED:true')
    expect(out).toContain('CANCELLED:true')
    expect(out).toContain('QUERY_COUNT:0')

    await h.wait(700)
    expect(h.getOutput()).toContain('QUERY_COUNT:0')
  })

  test('Esc cancels running task when no queued prompt exists', async () => {
    const conversationKey = `tui:${Math.random().toString(16).slice(2)}`
    const h = createInkTestHarness(
      <PromptInputCancelHarness
        conversationKey={conversationKey}
        initialIsLoading={true}
      />,
    )
    harnessManager.track(h)

    await h.wait(25)
    h.clearOutput()

    h.stdin.write('\u001b')
    await h.wait(100)

    const out = h.getOutput()
    expect(out).toContain('LOADING:false')
    expect(out).toContain('ABORTED:true')
    expect(out).toContain('CANCELLED:true')
  })

  test('draft pasted content survives unmount/remount (overlay lifecycle)', async () => {
    const conversationKey = `tui:${Math.random().toString(16).slice(2)}`
    const h = createInkTestHarness(
      <DraftPastePersistenceHarness conversationKey={conversationKey} />,
    )
    harnessManager.track(h)

    await h.wait(25)
    h.clearOutput()

    // Hide PromptInput (simulate a fullscreen overlay).
    h.stdin.write('\x07')
    await h.wait(50)
    expect(h.getOutput()).toContain('OVERLAY')

    h.clearOutput()

    // Show PromptInput again.
    h.stdin.write('\x07')
    await h.wait(50)

    // Submit and verify placeholder expansion still has access to pasted content.
    h.stdin.write('\r')
    await h.wait(150)

    const out = h.getOutput()
    expect(out).toContain('SUB:\"hello PASTE world\"')
    expect(out).not.toContain('SUB:\"hello [Pasted text #1] world\"')
  })

  test('removed pasted text placeholders are not expanded on submit', async () => {
    const conversationKey = `tui:${Math.random().toString(16).slice(2)}`
    const h = createInkTestHarness(
      <DraftPastePersistenceHarness conversationKey={conversationKey} />,
    )
    harnessManager.track(h)

    await h.wait(25)
    h.clearOutput()

    // Simulate editing the prompt so the placeholder is no longer present.
    h.stdin.write('\x12')
    await h.wait(75)

    h.stdin.write('\r')
    await h.wait(150)

    const out = h.getOutput()
    expect(out).toContain('SUB:\"hello world\"')
    expect(out).not.toContain('SUB:\"hello PASTE world\"')
  })

  test('up arrow on middle line moves cursor up (not history)', async () => {
    await setCwd(process.cwd())

    const conversationKey = `tui:${Math.random().toString(16).slice(2)}`
    const h = createInkTestHarness(
      <PromptInputHarness conversationKey={conversationKey} showRaw={true} />,
    )
    harnessManager.track(h)

    await h.wait(25)
    h.clearOutput()

    // Type multi-line input: "ab\ncd"
    h.stdin.write('ab')
    await h.wait(75)
    h.stdin.write('\u001b[13;2u') // Shift+Enter to insert newline (CSI-u)
    await h.wait(75)
    h.stdin.write('cd')
    await h.wait(75)
    expect(h.getOutput()).toContain('RAW:\"ab\\ncd\"')

    h.clearOutput()

    // Wait for fast browse mode to expire (1.5 seconds), then press Up
    await h.wait(1600)

    // Press Up arrow (should move cursor from line 1 to line 0)
    h.stdin.write('\u001b[A')
    await h.wait(75)

    // Type 'X' - if cursor moved up, it should be inserted at end of line 0
    h.stdin.write('X')
    await h.wait(75)

    // The input should be "abX\ncd" (X inserted on first line)
    const out = h.getOutput()
    expect(out).toContain('RAW:\"abX\\ncd\"')
  })
})
