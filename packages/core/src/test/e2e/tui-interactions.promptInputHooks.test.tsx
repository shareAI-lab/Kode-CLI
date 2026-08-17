import { afterEach, describe, expect, mock, test } from 'bun:test'
import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Text } from 'ink'
import TextInput from '#ui-ink/components/TextInput'
import { KeypressProvider } from '#ui-ink/contexts/KeypressContext'
import { createInkHarnessManager, createInkTestHarness } from './inkTestHarness'

const harnessManager = createInkHarnessManager()

afterEach(async () => {
  await harnessManager.cleanup()
  mock.restore()
})

describe('TUI E2E regression (Ink render): PromptInput hooks', () => {
  test('quick model switch clears dismiss timeout on unmount', async () => {
    mock.module('#core/utils/tokens', () => ({
      estimateTokens: () => 0,
    }))
    mock.module('#core/utils/model', () => ({
      getModelManager: () => ({
        getModelSwitchingDebugInfo: () => ({
          activeModels: 2,
          availableModels: [] as string[],
          totalModels: 2,
        }),
        switchToNextModel: () => ({
          success: true,
          modelName: 'next-model',
          message: 'Switched to next-model',
        }),
      }),
    }))

    const { useQuickModelSwitch } =
      await import('#ui-ink/components/PromptInput/useQuickModelSwitch')

    const messages: Array<{ show: boolean; text?: string }> = []
    let submitCount = 0

    function QuickModelSwitchHarness(): React.ReactNode {
      const modelMessages = useMemo(() => [] as any[], [])
      const switchModel = useQuickModelSwitch({
        messages: modelMessages,
        onSubmitCountChange: updater => {
          submitCount = updater(submitCount)
        },
        setModelSwitchMessage: message => {
          messages.push(message)
        },
      })

      useEffect(() => {
        switchModel()
      }, [switchModel])

      return <Text>quick-model-switch</Text>
    }

    const h = createInkTestHarness(<QuickModelSwitchHarness />)
    harnessManager.track(h)

    await h.wait(50)
    expect(messages).toEqual([{ show: true, text: 'Switched to next-model' }])
    expect(submitCount).toBe(1)

    h.unmount()
    await h.wait(3200)

    expect(messages).toEqual([{ show: true, text: 'Switched to next-model' }])
  })

  test('external edit ignores editor result after unmount', async () => {
    let resolveEditor:
      ((value: { text: string | null; editorLabel?: string }) => void) | null =
      null
    // resolveEditor is assigned inside the mocked module's Promise executor;
    // call through a closure so CFA doesn't narrow it to null at the call site.
    const fireResolveEditor = (value: {
      text: string | null
      editorLabel?: string
    }): void => {
      resolveEditor?.(value)
    }

    mock.module('#cli-utils/externalEditor', () => ({
      launchExternalEditor: () =>
        new Promise<{ text: string | null; editorLabel?: string }>(resolve => {
          resolveEditor = resolve
        }),
    }))

    const { useExternalEdit } =
      await import('#ui-ink/components/PromptInput/useExternalEdit')

    const messages: Array<{ show: boolean; text?: string }> = []
    const inputs: string[] = []
    const offsets: number[] = []

    function ExternalEditHarness(): React.ReactNode {
      const didStartRef = useRef(false)
      const { handleExternalEdit } = useExternalEdit({
        input: 'draft',
        isDisabled: false,
        isLoading: false,
        onInputChange: text => {
          inputs.push(text)
        },
        setCursorOffset: offset => {
          offsets.push(offset)
        },
        setMessage: message => {
          messages.push(message)
        },
      })

      useEffect(() => {
        if (didStartRef.current) return
        didStartRef.current = true
        void handleExternalEdit()
      }, [handleExternalEdit])

      return <Text>external-edit</Text>
    }

    const h = createInkTestHarness(<ExternalEditHarness />)
    harnessManager.track(h)

    await h.wait(50)
    expect(messages).toEqual([
      { show: true, text: 'Opening external editor...' },
    ])

    h.unmount()
    fireResolveEditor({ text: 'edited text', editorLabel: 'test-editor' })
    await h.wait(50)

    expect(inputs).toEqual([])
    expect(offsets).toEqual([])
    expect(messages).toEqual([
      { show: true, text: 'Opening external editor...' },
    ])
  })

  test('opens only one editor while the prompt is entering external edit mode', async () => {
    let launches = 0
    let resolveEditor: ((value: { text: string | null }) => void) | null = null
    const finishEditor = (): void => {
      resolveEditor?.({ text: null })
    }

    mock.module('#cli-utils/externalEditor', () => ({
      launchExternalEditor: () => {
        launches += 1
        return new Promise<{ text: string | null }>(resolve => {
          resolveEditor = resolve
        })
      },
    }))

    const { useExternalEdit } =
      await import('#ui-ink/components/PromptInput/useExternalEdit')

    function ExternalEditHarness(): React.ReactNode {
      const didStartRef = useRef(false)
      const { handleExternalEdit } = useExternalEdit({
        input: 'draft',
        isDisabled: false,
        isLoading: false,
        onInputChange: () => {},
        setCursorOffset: () => {},
        setMessage: () => {},
      })

      useEffect(() => {
        if (didStartRef.current) return
        didStartRef.current = true
        void handleExternalEdit()
        void handleExternalEdit()
      }, [handleExternalEdit])

      return <Text>external-edit</Text>
    }

    const h = createInkTestHarness(<ExternalEditHarness />)
    harnessManager.track(h)

    await h.wait(50)
    expect(launches).toBe(1)

    h.unmount()
    finishEditor()
  })

  test('external edit reports launcher failures without leaving the prompt blocked', async () => {
    mock.module('#cli-utils/externalEditor', () => ({
      launchExternalEditor: async () => {
        throw new Error('temporary editor file unavailable')
      },
    }))

    const { useExternalEdit } =
      await import('#ui-ink/components/PromptInput/useExternalEdit')

    const messages: Array<{ show: boolean; text?: string }> = []

    function ExternalEditFailureHarness(): React.ReactNode {
      const didStartRef = useRef(false)
      const { handleExternalEdit, isEditingExternally } = useExternalEdit({
        input: 'draft',
        isDisabled: false,
        isLoading: false,
        onInputChange: () => {},
        setCursorOffset: () => {},
        setMessage: message => {
          messages.push(message)
        },
      })

      useEffect(() => {
        if (didStartRef.current) return
        didStartRef.current = true
        void handleExternalEdit()
      }, [handleExternalEdit])

      return <Text>{isEditingExternally ? 'editing' : 'ready'}</Text>
    }

    const h = createInkTestHarness(<ExternalEditFailureHarness />)
    harnessManager.track(h)

    await h.wait(50)

    expect(messages).toEqual([
      { show: true, text: 'Opening external editor...' },
      {
        show: true,
        text: 'Unable to open the external editor. Check $EDITOR and try again.',
      },
    ])
    expect(h.getOutput()).toContain('ready')
  })

  test('does not deliver a deferred bracketed paste after input unmounts', async () => {
    const pasted: string[] = []

    function DeferredPasteHarness(): React.ReactNode {
      const [value, setValue] = useState('')
      return (
        <KeypressProvider>
          <TextInput
            value={value}
            onChange={setValue}
            onPaste={text => {
              pasted.push(text)
            }}
            columns={80}
            cursorOffset={0}
            onChangeCursorOffset={() => {}}
          />
        </KeypressProvider>
      )
    }

    const h = createInkTestHarness(<DeferredPasteHarness />)
    harnessManager.track(h)
    await h.wait(25)

    const pastedText = 'x'.repeat(200)
    h.stdin.write(`\x1b[200~${pastedText}\x1b[201~`)
    h.unmount()

    await h.wait(25)
    expect(pasted).toEqual([])
  })

  test('cancels deferred marker fallback paste after unmount', async () => {
    const { useBracketedPasteSequences } =
      await import('#ui-ink/components/TextInputBracketedPaste')
    const pasted: string[] = []
    const handlePaste = {
      current: null as ((input: string) => boolean) | null,
    }

    function MarkerPasteHarness(): React.ReactNode {
      const handler = useBracketedPasteSequences({
        insertText: () => {},
        onPaste: text => {
          pasted.push(text)
        },
        terminalColumns: 80,
      })

      useEffect(() => {
        handlePaste.current = handler
      }, [handler])

      useEffect(() => {
        return () => {
          handlePaste.current = null
        }
      }, [])

      return <Text>marker-paste</Text>
    }

    const h = createInkTestHarness(<MarkerPasteHarness />)
    harnessManager.track(h)
    await h.wait(25)

    handlePaste.current?.(`\x1b[200~${'x'.repeat(200)}\x1b[201~`)
    h.unmount()

    await h.wait(25)
    expect(pasted).toEqual([])
  })
})
