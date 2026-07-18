import { afterEach, describe, expect, test } from 'bun:test'
import React, { useEffect, useMemo, useState } from 'react'
import { Box, Text } from 'ink'
import figures from 'figures'
import { AskUserQuestionPermissionRequest } from '#ui-ink/components/permissions/AskUserQuestionPermissionRequest/AskUserQuestionPermissionRequest'
import { AskUserQuestionTool } from '#tools/tools/interaction/AskUserQuestionTool/AskUserQuestionTool'
import { ExitPlanModePermissionRequest } from '#ui-ink/components/permissions/PlanModePermissionRequest/ExitPlanModePermissionRequest'
import { ExitPlanModeTool } from '#tools/tools/interaction/PlanModeTool/ExitPlanModeTool'
import {
  BashToolRunInBackgroundOverlay,
  createRunInBackgroundKeypressHandler,
} from '#tools/tools/system/BashTool/BashToolRunInBackgroundOverlay'
import { ModelConfig } from '#ui-ink/components/ModelConfig'
import {
  createAssistantMessage,
  createProgressMessage,
  normalizeMessages,
  reorderMessages,
} from '#core/utils/messages'
import type { Message as KodeMessage } from '#core/query'
import { getGlobalConfig, saveGlobalConfig } from '#core/utils/config'
import { reloadModelManager } from '#core/utils/model'
import { Message } from '#ui-ink/components/Message'
import { MessageResponse } from '#ui-ink/components/MessageResponse'
import { KeypressProvider } from '#ui-ink/contexts/KeypressContext'
import { createInkHarnessManager, createInkTestHarness } from './inkTestHarness'
import { Select } from '#ui-ink/components/CustomSelect/select'
import { ModelSelector } from '#ui-ink/components/ModelSelector/ModelSelector'
import { ScopedMultiSelect } from '#ui-ink/components/CustomSelect/multi-select'
import { useModelSelectorInput } from '#ui-ink/components/ModelSelector/useModelSelectorInput'
import { useModelSelectorState } from '#ui-ink/components/ModelSelector/useModelSelectorState'
import { ToolPicker } from '#host-cli/commands/agent/agents/ui/wizard/ToolPicker'
import { useKeypress } from '#ui-ink/hooks/useKeypress'
import { useToolKeypress } from '#ui-ink/hooks/useToolKeypress'
import { useMouse } from '#ui-ink/hooks/useMouse'
import { useScopedIndexState } from '#ui-ink/hooks/useScopedIndexState'
import { KEYPRESS_PRIORITY } from '#ui-ink/constants/keypressPriority'
import { PermissionProvider } from '#ui-ink/contexts/PermissionContext'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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

    await h.wait(25)

    h.stdin.write('\u001B[B')
    await h.wait(10)
    h.stdin.write('\u001B[B')
    await h.wait(10)

    for (const ch of 'threejs') {
      h.stdin.write(ch)
      await h.wait(5)
    }

    h.stdin.write('\r')
    await h.wait(25)

    expect(allowed).toBe(true)
    expect(done).toBe(true)
    const stored =
      toolUseConfirm.toolUseContext.options?.askUserQuestionAnswersByToolUseId
        ?.m
    expect(stored?.['What type of Snake game would you like?']).toBe('threejs')
  })

  test('AskUserQuestion: digit key selects a numbered option', async () => {
    let allowed = false
    let done = false
    const input: any = {
      questions: [
        {
          question: '剩余9个未合并的功能分支，是否也要删除？',
          header: '未合并分支',
          multiSelect: false,
          options: [
            {
              label: '全部删除，只留main',
              description: '删除所有codex/*、feat/*、guard/*、worktree/*分支',
            },
            {
              label: '保留不动',
              description: '这些未合并分支可能还有用，先保留',
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

    await h.wait(25)
    expect(h.getOutput()).toContain('1. 全部删除，只留main')
    expect(h.getOutput()).toContain('2. 保留不动')
    expect(h.getOutput()).toContain('3. Other')

    h.stdin.write('2')
    await h.wait(25)

    expect(allowed).toBe(true)
    expect(done).toBe(true)
    const stored =
      toolUseConfirm.toolUseContext.options?.askUserQuestionAnswersByToolUseId
        ?.m
    expect(stored?.['剩余9个未合并的功能分支，是否也要删除？']).toBe('保留不动')
  })

  test('AskUserQuestion: SGR mouse click selects a numbered option', async () => {
    let allowed = false
    let done = false
    const input: any = {
      questions: [
        {
          question: 'Pick mouse one',
          header: 'Pick Mouse',
          multiSelect: false,
          options: [
            {
              label: 'First',
              description: 'First option',
            },
            {
              label: 'Second',
              description: 'Second option',
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
        messageId: 'mouse-m',
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

    await h.wait(25)
    const outputLines = h.getOutput().split(/\r?\n/)
    const secondOptionLineIndex = outputLines.findIndex(line =>
      line.includes('2. Second'),
    )
    expect(secondOptionLineIndex).toBeGreaterThanOrEqual(0)

    h.stdin.write(`\x1b[<0;4;${secondOptionLineIndex + 1}M`)
    await h.wait(25)

    expect(allowed).toBe(true)
    expect(done).toBe(true)
    const stored =
      toolUseConfirm.toolUseContext.options
        ?.askUserQuestionAnswersByToolUseId?.['mouse-m']
    expect(stored?.['Pick mouse one']).toBe('Second')
  })

  test('AskUserQuestion: down-arrow focus survives keep-alive remount', async () => {
    let allowed = false
    let done = false
    const input: any = {
      questions: [
        {
          question: 'Pick one',
          header: 'Pick',
          multiSelect: false,
          options: [
            {
              label: 'First',
              description: 'First option',
            },
            {
              label: 'Second',
              description: 'Second option',
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

    function KeepAliveQuestionHarness(): React.ReactNode {
      const [showQuestion, setShowQuestion] = useState(true)

      useKeypress(
        (_input, key) => {
          if (!key.downArrow) return

          setTimeout(() => {
            setShowQuestion(false)
            setTimeout(() => setShowQuestion(true), 0)
          }, 0)
          return false
        },
        { priority: 10 },
      )

      if (!showQuestion) return <Text>Loading question...</Text>

      return (
        <AskUserQuestionPermissionRequest
          toolUseConfirm={toolUseConfirm}
          onDone={() => {
            done = true
          }}
          verbose={false}
        />
      )
    }

    const h = createInkTestHarness(
      <KeypressProvider>
        <KeepAliveQuestionHarness />
      </KeypressProvider>,
    )
    harnessManager.track(h)

    await h.wait(25)

    h.stdin.write('\u001B[B')
    await h.wait(100)
    h.stdin.write('\r')
    await h.wait(25)

    expect(allowed).toBe(true)
    expect(done).toBe(true)
    const stored =
      toolUseConfirm.toolUseContext.options?.askUserQuestionAnswersByToolUseId
        ?.m
    expect(stored?.['Pick one']).toBe('Second')
  })

  test('ExitPlanMode: down-arrow focus survives keep-alive remount without a plan', async () => {
    const previousConfigDir = process.env.KODE_CONFIG_DIR
    const configDir = mkdtempSync(join(tmpdir(), 'kode-plan-keepalive-'))
    process.env.KODE_CONFIG_DIR = configDir

    try {
      let allowed = false
      let rejected = false
      let done = false
      const conversationKey = `plan-keepalive-${Date.now()}-${Math.random()}`
      const toolUseConfirm: any = {
        assistantMessage: createAssistantMessage(''),
        tool: ExitPlanModeTool,
        description: 'Exit plan mode',
        input: {},
        commandPrefix: null,
        toolUseContext: {
          messageId: conversationKey,
          abortController: new AbortController(),
          readFileTimestamps: {},
          options: {
            messageLogName: 'plan',
            forkNumber: 1,
            safeMode: false,
          },
        },
        riskScore: null,
        onAbort: () => {},
        onAllow: () => {
          allowed = true
        },
        onReject: () => {
          rejected = true
        },
      }

      function KeepAliveExitPlanHarness(): React.ReactNode {
        const [showRequest, setShowRequest] = useState(true)

        useKeypress(
          (_input, key) => {
            if (!key.downArrow) return

            setTimeout(() => {
              setShowRequest(false)
              setTimeout(() => setShowRequest(true), 0)
            }, 0)
            return false
          },
          { priority: 10 },
        )

        if (!showRequest) return <Text>Loading plan approval...</Text>

        return (
          <PermissionProvider
            conversationKey={conversationKey}
            isBypassPermissionsModeAvailable
          >
            <ExitPlanModePermissionRequest
              toolUseConfirm={toolUseConfirm}
              onDone={() => {
                done = true
              }}
              verbose={false}
            />
          </PermissionProvider>
        )
      }

      const h = createInkTestHarness(
        <KeypressProvider>
          <KeepAliveExitPlanHarness />
        </KeypressProvider>,
      )
      harnessManager.track(h)

      await h.wait(25)

      h.stdin.write('\u001B[B')
      await h.wait(100)
      h.stdin.write('\r')
      await h.wait(25)

      expect(allowed).toBe(false)
      expect(rejected).toBe(true)
      expect(done).toBe(true)
    } finally {
      if (previousConfigDir === undefined) delete process.env.KODE_CONFIG_DIR
      else process.env.KODE_CONFIG_DIR = previousConfigDir
      rmSync(configDir, { recursive: true, force: true })
    }
  })

  test('ModelConfig: pointer picker keeps printable filter input out of parent shortcuts', async () => {
    const originalConfig = JSON.parse(JSON.stringify(getGlobalConfig()))

    saveGlobalConfig({
      ...getGlobalConfig(),
      modelProfiles: [
        {
          name: 'Code Model',
          provider: 'custom-openai',
          modelName: 'code-model',
          apiKey: 'test-key',
          maxTokens: 1024,
          contextLength: 128_000,
          isActive: true,
          createdAt: 1,
          lastUsed: 2,
        },
        {
          name: 'Other Model',
          provider: 'custom-openai',
          modelName: 'other-model',
          apiKey: 'test-key',
          maxTokens: 1024,
          contextLength: 128_000,
          isActive: true,
          createdAt: 2,
          lastUsed: 1,
        },
      ],
      modelPointers: {
        main: 'other-model',
        task: '',
        compact: '',
        quick: '',
      },
    })
    reloadModelManager()

    try {
      const h = createInkTestHarness(
        <KeypressProvider>
          <ModelConfig onClose={() => {}} />
        </KeypressProvider>,
      )
      harnessManager.track(h)

      await h.wait(100)
      h.stdin.write('\r')
      await h.wait(100)

      expect(h.getOutput()).toContain('Set main model')

      h.clearOutput()
      h.stdin.write('c')
      await h.wait(25)

      expect(getGlobalConfig().modelPointers?.main).toBe('other-model')
      expect(h.getOutput()).toContain('Set main model')
      expect(h.getOutput()).toContain('Code Model')

      h.clearOutput()
      h.stdin.write('\x04')
      await h.wait(25)

      expect(getGlobalConfig().modelPointers?.main).toBe('')
    } finally {
      saveGlobalConfig(originalConfig)
      reloadModelManager()
    }
  })

  test('Select: SGR mouse click selects the clicked option without leaking key input', async () => {
    let selected = ''
    let leakedKeypresses = 0

    function SelectHarness(): React.ReactNode {
      useKeypress(() => {
        leakedKeypresses += 1
      })

      return (
        <Select
          options={[
            { label: 'First', value: 'first' },
            { label: 'Second', value: 'second' },
            { label: 'Third', value: 'third' },
          ]}
          onChange={value => {
            selected = value
          }}
        />
      )
    }

    const h = createInkTestHarness(
      <KeypressProvider>
        <SelectHarness />
      </KeypressProvider>,
    )
    harnessManager.track(h)

    await h.wait(25)

    h.stdin.write('\x1b[<0;3;2M')
    await h.wait(25)

    expect(selected).toBe('second')
    expect(leakedKeypresses).toBe(0)
  })

  test('Select: mouse wheel does not change focus unless explicitly enabled', async () => {
    let focused = ''

    const h = createInkTestHarness(
      <KeypressProvider>
        <Select
          options={[
            { label: 'First', value: 'first' },
            { label: 'Second', value: 'second' },
            { label: 'Third', value: 'third' },
          ]}
          onFocus={value => {
            focused = value
          }}
        />
      </KeypressProvider>,
    )
    harnessManager.track(h)

    await h.wait(25)
    expect(focused).toBe('first')

    h.stdin.write('\x1b[<65;1;1M')
    await h.wait(25)

    expect(focused).toBe('first')
  })

  test('Select: mouse wheel navigation is available when explicitly enabled', async () => {
    let focused = ''

    const h = createInkTestHarness(
      <KeypressProvider>
        <Select
          enableMouseWheel={true}
          options={[
            { label: 'First', value: 'first' },
            { label: 'Second', value: 'second' },
            { label: 'Third', value: 'third' },
          ]}
          onFocus={value => {
            focused = value
          }}
        />
      </KeypressProvider>,
    )
    harnessManager.track(h)

    await h.wait(25)
    expect(focused).toBe('first')

    h.stdin.write('\x1b[<65;1;1M')
    await h.wait(25)

    expect(focused).toBe('second')
  })

  test('Select: grouped options focus the first selectable option', async () => {
    let selected = ''

    const h = createInkTestHarness(
      <KeypressProvider>
        <Select
          options={[
            {
              header: 'Group',
              options: [
                { label: 'First', value: 'first' },
                { label: 'Second', value: 'second' },
              ],
            },
          ]}
          onChange={value => {
            selected = value
          }}
        />
      </KeypressProvider>,
    )
    harnessManager.track(h)

    await h.wait(25)
    h.stdin.write('\r')
    await h.wait(25)

    expect(selected).toBe('first')
  })

  test('Select: grouped options render a single focus marker', async () => {
    const h = createInkTestHarness(
      <KeypressProvider>
        <Select
          options={[
            {
              header: 'Group',
              options: [
                { label: 'First', value: 'first' },
                { label: 'Second', value: 'second' },
              ],
            },
          ]}
        />
      </KeypressProvider>,
    )
    harnessManager.track(h)

    await h.wait(25)

    const output = h.getOutput()
    const focusMarkers = [figures.pointer, figures.triangleDownSmall].reduce(
      (count, marker) => count + output.split(marker).length - 1,
      0,
    )
    expect(focusMarkers).toBe(1)
  })

  test('Select: digit key selects the matching visible option', async () => {
    let selected = ''

    const h = createInkTestHarness(
      <KeypressProvider>
        <Select
          options={[
            {
              header: 'Group',
              options: [
                { label: 'First', value: 'first' },
                { label: 'Second', value: 'second' },
              ],
            },
            {
              header: 'More',
              options: [{ label: 'Third', value: 'third' }],
            },
          ]}
          onChange={value => {
            selected = value
          }}
        />
      </KeypressProvider>,
    )
    harnessManager.track(h)

    await h.wait(25)
    h.stdin.write('2')
    await h.wait(25)

    expect(selected).toBe('second')
  })

  test('Select: unstable onFocus callback does not create a parent update loop', async () => {
    let focusCalls = 0

    function SelectUnstableOnFocusHarness(): React.ReactNode {
      const [focusMeta, setFocusMeta] = useState({ value: '' })

      return (
        <Box flexDirection="column">
          <Text>FOCUS:{focusMeta.value}</Text>
          <Select
            options={[
              { label: 'First', value: 'first' },
              { label: 'Second', value: 'second' },
            ]}
            onFocus={value => {
              focusCalls += 1
              setFocusMeta({ value })
            }}
          />
        </Box>
      )
    }

    const h = createInkTestHarness(
      <KeypressProvider>
        <SelectUnstableOnFocusHarness />
      </KeypressProvider>,
    )
    harnessManager.track(h)

    await h.wait(100)

    expect(focusCalls).toBe(1)
    expect(h.getOutput()).toContain('FOCUS:first')

    h.stdin.write('\u001B[B')
    await h.wait(100)

    expect(focusCalls).toBe(2)
    expect(h.getOutput()).toContain('FOCUS:second')
  })

  test('Select: selected value is consumed across keep-alive rerenders', async () => {
    let selectedCount = 0

    function SelectActionHarness(): React.ReactNode {
      const [tick, setTick] = useState(0)

      useEffect(() => {
        const intervalId = setInterval(() => {
          setTick(prev => prev + 1)
        }, 30)
        return () => clearInterval(intervalId)
      }, [])

      return (
        <Select
          options={[
            { label: `Reconnect ${tick}`, value: 'reconnect' },
            { label: `Disable ${tick}`, value: 'disable' },
          ]}
          onChange={() => {
            selectedCount += 1
          }}
        />
      )
    }

    const h = createInkTestHarness(
      <KeypressProvider>
        <SelectActionHarness />
      </KeypressProvider>,
    )
    harnessManager.track(h)

    await h.wait(60)
    h.stdin.write('\r')
    await h.wait(150)

    expect(selectedCount).toBe(1)

    h.stdin.write('\r')
    await h.wait(120)

    expect(selectedCount).toBe(2)
  })

  test('Select: down-arrow focus survives keep-alive style rerenders', async () => {
    let focused = ''

    function SelectKeepAliveHarness(): React.ReactNode {
      const [tick, setTick] = useState(0)

      useEffect(() => {
        const intervalId = setInterval(() => {
          setTick(prev => prev + 1)
        }, 30)
        return () => clearInterval(intervalId)
      }, [])

      return (
        <Select
          options={[
            { label: `First ${tick}`, value: 'first' },
            { label: `Second ${tick}`, value: 'second' },
            { label: `Third ${tick}`, value: 'third' },
          ]}
          onFocus={value => {
            focused = value
          }}
        />
      )
    }

    const h = createInkTestHarness(
      <KeypressProvider>
        <SelectKeepAliveHarness />
      </KeypressProvider>,
    )
    harnessManager.track(h)

    await h.wait(60)
    expect(focused).toBe('first')

    h.stdin.write('\u001B[B')
    await h.wait(150)

    expect(focused).toBe('second')
  })

  test('ScopedMultiSelect: down-arrow focus survives keep-alive remount', async () => {
    let submitted: string[] = []
    const scope = `test:scoped-multiselect-remount:${Date.now()}:${Math.random()}`

    function ScopedMultiSelectKeepAliveHarness(): React.ReactNode {
      const [showSelect, setShowSelect] = useState(true)

      useKeypress(
        (_input, key) => {
          if (!key.downArrow) return

          setTimeout(() => {
            setShowSelect(false)
            setTimeout(() => setShowSelect(true), 0)
          }, 0)
          return false
        },
        { priority: 10 },
      )

      if (!showSelect) return <Text>Loading servers...</Text>

      return (
        <ScopedMultiSelect
          focusScope={scope}
          options={[
            { label: 'First', value: 'first' },
            { label: 'Second', value: 'second' },
            { label: 'Third', value: 'third' },
          ]}
          defaultValue={['first', 'second', 'third']}
          onSubmit={values => {
            submitted = values
          }}
        />
      )
    }

    const h = createInkTestHarness(
      <KeypressProvider>
        <ScopedMultiSelectKeepAliveHarness />
      </KeypressProvider>,
    )
    harnessManager.track(h)

    await h.wait(40)
    h.stdin.write('\u001B[B')
    await h.wait(100)
    h.stdin.write(' ')
    await h.wait(40)
    h.stdin.write('\r')
    await h.wait(40)

    expect(submitted).toEqual(['first', 'third'])
  })

  test('Select: down-arrow focus is not pulled back by stale focusValue during keep-alive rerenders', async () => {
    let focused = ''

    function SelectControlledKeepAliveHarness(): React.ReactNode {
      const [tick, setTick] = useState(0)

      useEffect(() => {
        const intervalId = setInterval(() => {
          setTick(prev => prev + 1)
        }, 30)
        return () => clearInterval(intervalId)
      }, [])

      return (
        <Select
          focusValue="first"
          options={[
            { label: `First ${tick}`, value: 'first' },
            { label: `Second ${tick}`, value: 'second' },
            { label: `Third ${tick}`, value: 'third' },
          ]}
          onFocus={value => {
            focused = value
          }}
        />
      )
    }

    const h = createInkTestHarness(
      <KeypressProvider>
        <SelectControlledKeepAliveHarness />
      </KeypressProvider>,
    )
    harnessManager.track(h)

    await h.wait(60)
    expect(focused).toBe('first')

    h.stdin.write('\u001B[B')
    await h.wait(150)

    expect(focused).toBe('second')
  })

  test('Select: stale focusValue does not pull focus back when keep-alive changes option structure', async () => {
    let focused = ''

    function SelectChangingStructureHarness(): React.ReactNode {
      const [showExtra, setShowExtra] = useState(false)

      useEffect(() => {
        const intervalId = setInterval(() => {
          setShowExtra(prev => !prev)
        }, 30)
        return () => clearInterval(intervalId)
      }, [])

      return (
        <Select
          focusValue="first"
          options={[
            { label: 'First', value: 'first' },
            { label: 'Second', value: 'second' },
            ...(showExtra ? [{ label: 'Third', value: 'third' }] : []),
          ]}
          onFocus={value => {
            focused = value
          }}
        />
      )
    }

    const h = createInkTestHarness(
      <KeypressProvider>
        <SelectChangingStructureHarness />
      </KeypressProvider>,
    )
    harnessManager.track(h)

    await h.wait(60)
    expect(focused).toBe('first')

    h.stdin.write('\u001B[B')
    await h.wait(180)

    expect(focused).toBe('second')
  })

  test('Select: down-arrow focus is not pulled back when keep-alive clears and restores stale focusValue', async () => {
    let focused = ''

    function SelectRestoredStaleFocusHarness(): React.ReactNode {
      const [tick, setTick] = useState(0)
      const [observedFocus, setObservedFocus] = useState('')
      const [focusValue, setFocusValue] = useState<string | undefined>('first')

      useEffect(() => {
        const intervalId = setInterval(() => {
          setTick(prev => prev + 1)
        }, 30)
        return () => clearInterval(intervalId)
      }, [])

      useEffect(() => {
        if (observedFocus !== 'second') return

        const timers = [
          setTimeout(() => setFocusValue(undefined), 20),
          setTimeout(() => setFocusValue('first'), 60),
        ]
        return () => {
          for (const timer of timers) clearTimeout(timer)
        }
      }, [observedFocus])

      return (
        <Select
          focusValue={focusValue}
          options={[
            { label: `First ${tick}`, value: 'first' },
            { label: `Second ${tick}`, value: 'second' },
            { label: `Third ${tick}`, value: 'third' },
          ]}
          onFocus={value => {
            focused = value
            setObservedFocus(value)
          }}
        />
      )
    }

    const h = createInkTestHarness(
      <KeypressProvider>
        <SelectRestoredStaleFocusHarness />
      </KeypressProvider>,
    )
    harnessManager.track(h)

    await h.wait(60)
    expect(focused).toBe('first')

    h.stdin.write('\u001B[B')
    await h.wait(180)

    expect(focused).toBe('second')
  })

  test('Select: down-arrow focus survives transient empty keep-alive options', async () => {
    let focused = ''

    function SelectTransientOptionsHarness(): React.ReactNode {
      const [showOptions, setShowOptions] = useState(true)

      useEffect(() => {
        const timers = [
          setTimeout(() => setShowOptions(false), 80),
          setTimeout(() => setShowOptions(true), 130),
          setTimeout(() => setShowOptions(false), 180),
          setTimeout(() => setShowOptions(true), 230),
        ]
        return () => {
          for (const timer of timers) clearTimeout(timer)
        }
      }, [])

      return (
        <Select
          focusValue="first"
          options={
            showOptions
              ? [
                  { label: 'First', value: 'first' },
                  { label: 'Second', value: 'second' },
                  { label: 'Third', value: 'third' },
                ]
              : []
          }
          onFocus={value => {
            focused = value
          }}
        />
      )
    }

    const h = createInkTestHarness(
      <KeypressProvider>
        <SelectTransientOptionsHarness />
      </KeypressProvider>,
    )
    harnessManager.track(h)

    await h.wait(40)
    expect(focused).toBe('first')

    h.stdin.write('\u001B[B')
    await h.wait(30)
    expect(focused).toBe('second')

    await h.wait(240)

    expect(focused).toBe('second')
  })

  test('Select: down-arrow focus survives transient keep-alive options missing the focused value', async () => {
    let focused = ''
    let selected = ''

    function SelectTransientMissingFocusedOptionHarness(): React.ReactNode {
      const [mode, setMode] = useState<'full' | 'missing'>('full')
      const [focusValue, setFocusValue] = useState<string | undefined>('first')

      useEffect(() => {
        if (focusValue !== 'second') return

        const timers = [
          setTimeout(() => setMode('missing'), 80),
          setTimeout(() => setMode('full'), 150),
        ]
        return () => {
          for (const timer of timers) clearTimeout(timer)
        }
      }, [focusValue])

      return (
        <Select
          focusValue={focusValue}
          options={
            mode === 'full'
              ? [
                  { label: 'First', value: 'first' },
                  { label: 'Second', value: 'second' },
                  { label: 'Third', value: 'third' },
                ]
              : [
                  { label: 'First', value: 'first' },
                  { label: 'Third', value: 'third' },
                ]
          }
          onFocus={value => {
            focused = value
            setFocusValue(value)
          }}
          onChange={value => {
            selected = value
          }}
        />
      )
    }

    const h = createInkTestHarness(
      <KeypressProvider>
        <SelectTransientMissingFocusedOptionHarness />
      </KeypressProvider>,
    )
    harnessManager.track(h)

    await h.wait(40)
    expect(focused).toBe('first')

    h.stdin.write('\u001B[B')
    await h.wait(60)
    expect(focused).toBe('second')

    await h.wait(180)
    expect(focused).toBe('second')

    h.stdin.write('\r')
    await h.wait(40)

    expect(selected).toBe('second')
  })

  test('Select: uncontrolled focus survives transient keep-alive options missing the focused value', async () => {
    let focused = ''
    let selected = ''

    function SelectUncontrolledTransientMissingOptionHarness(): React.ReactNode {
      const [mode, setMode] = useState<'full' | 'missing'>('full')
      const [focusedValue, setFocusedValue] = useState('')

      useEffect(() => {
        if (focusedValue !== 'second') return

        setMode('missing')
        const timers = [setTimeout(() => setMode('full'), 120)]
        return () => {
          for (const timer of timers) clearTimeout(timer)
        }
      }, [focusedValue])

      return (
        <Select
          options={
            mode === 'full'
              ? [
                  { label: 'First', value: 'first' },
                  { label: 'Second', value: 'second' },
                  { label: 'Third', value: 'third' },
                ]
              : [
                  { label: 'First', value: 'first' },
                  { label: 'Third', value: 'third' },
                ]
          }
          onFocus={value => {
            focused = value
            setFocusedValue(value)
          }}
          onChange={value => {
            selected = value
          }}
        />
      )
    }

    const h = createInkTestHarness(
      <KeypressProvider>
        <SelectUncontrolledTransientMissingOptionHarness />
      </KeypressProvider>,
    )
    harnessManager.track(h)

    await h.wait(40)
    expect(focused).toBe('first')

    h.stdin.write('\u001B[B')
    await h.wait(30)
    expect(focused).toBe('second')

    h.clearOutput()
    await h.wait(60)
    expect(h.getOutput()).not.toContain('Second')

    h.stdin.write('\r')
    await h.wait(30)
    expect(selected).toBe('')

    await h.wait(120)
    expect(focused).toBe('second')

    h.stdin.write('\r')
    await h.wait(40)

    expect(selected).toBe('second')
  })

  test('Select: down-arrow during transient keep-alive removal advances from the stale focus position', async () => {
    let focused = ''
    let selected = ''

    function SelectNavigateDuringMissingOptionHarness(): React.ReactNode {
      const [mode, setMode] = useState<'full' | 'missing'>('full')
      const [focusedValue, setFocusedValue] = useState('')

      useEffect(() => {
        if (focusedValue !== 'second') return

        setMode('missing')
        const timer = setTimeout(() => setMode('full'), 120)
        return () => clearTimeout(timer)
      }, [focusedValue])

      return (
        <Select
          options={
            mode === 'full'
              ? [
                  { label: 'First', value: 'first' },
                  { label: 'Second', value: 'second' },
                  { label: 'Third', value: 'third' },
                ]
              : [
                  { label: 'First', value: 'first' },
                  { label: 'Third', value: 'third' },
                ]
          }
          onFocus={value => {
            focused = value
            setFocusedValue(value)
          }}
          onChange={value => {
            selected = value
          }}
        />
      )
    }

    const h = createInkTestHarness(
      <KeypressProvider>
        <SelectNavigateDuringMissingOptionHarness />
      </KeypressProvider>,
    )
    harnessManager.track(h)

    await h.wait(40)
    expect(focused).toBe('first')

    h.stdin.write('\u001B[B')
    await h.wait(30)
    expect(focused).toBe('second')

    h.clearOutput()
    await h.wait(30)
    expect(h.getOutput()).not.toContain('Second')

    h.stdin.write('\u001B[B')
    await h.wait(40)
    expect(focused).toBe('third')

    await h.wait(130)
    expect(focused).toBe('third')

    h.stdin.write('\r')
    await h.wait(40)

    expect(selected).toBe('third')
  })

  test('Select: parent-synced focus survives a keep-alive remount', async () => {
    let focused = ''
    let selected = ''

    function SelectRemountHarness(): React.ReactNode {
      const [showSelect, setShowSelect] = useState(true)
      const [focusValue, setFocusValue] = useState<string | undefined>('first')

      useEffect(() => {
        const timers = [
          setTimeout(() => setShowSelect(false), 90),
          setTimeout(() => setShowSelect(true), 140),
        ]
        return () => {
          for (const timer of timers) clearTimeout(timer)
        }
      }, [])

      if (!showSelect) return <Box />

      return (
        <Select
          focusValue={focusValue}
          options={[
            { label: 'First', value: 'first' },
            { label: 'Second', value: 'second' },
            { label: 'Third', value: 'third' },
          ]}
          onFocus={value => {
            focused = value
            setFocusValue(value)
          }}
          onChange={value => {
            selected = value
          }}
        />
      )
    }

    const h = createInkTestHarness(
      <KeypressProvider>
        <SelectRemountHarness />
      </KeypressProvider>,
    )
    harnessManager.track(h)

    await h.wait(40)
    expect(focused).toBe('first')

    h.stdin.write('\u001B[B')
    await h.wait(40)
    expect(focused).toBe('second')

    await h.wait(140)
    expect(focused).toBe('second')

    h.stdin.write('\r')
    await h.wait(40)

    expect(selected).toBe('second')
  })

  test('Select: parent focus is persisted before an interrupting keep-alive remount', async () => {
    let focused = ''
    let selected = ''

    function SelectInterruptedRemountHarness(): React.ReactNode {
      const [showSelect, setShowSelect] = useState(true)
      const [focusValue, setFocusValue] = useState<string | undefined>('first')

      useKeypress(
        (_input, key) => {
          if (!key.downArrow) return

          setShowSelect(false)
          setTimeout(() => setShowSelect(true), 0)
          return false
        },
        { priority: 10 },
      )

      if (!showSelect) return <Text>Loading actions...</Text>

      return (
        <Select
          focusValue={focusValue}
          options={[
            { label: 'First', value: 'first' },
            { label: 'Second', value: 'second' },
            { label: 'Third', value: 'third' },
          ]}
          onFocus={value => {
            focused = value
            setFocusValue(value)
          }}
          onChange={value => {
            selected = value
          }}
        />
      )
    }

    const h = createInkTestHarness(
      <KeypressProvider>
        <SelectInterruptedRemountHarness />
      </KeypressProvider>,
    )
    harnessManager.track(h)

    await h.wait(40)
    expect(focused).toBe('first')

    h.stdin.write('\u001B[B')
    await h.wait(80)
    expect(focused).toBe('second')

    h.stdin.write('\r')
    await h.wait(40)

    expect(selected).toBe('second')
  })

  test('Select: repeated down-arrow focus is persisted before a keep-alive remount', async () => {
    let focused = ''
    let selected = ''

    function SelectRepeatedKeyRemountHarness(): React.ReactNode {
      const [showSelect, setShowSelect] = useState(true)
      const [focusValue, setFocusValue] = useState<string | undefined>('first')

      useKeypress(
        (_input, key) => {
          if (!key.downArrow) return

          setTimeout(() => {
            setShowSelect(false)
            setTimeout(() => setShowSelect(true), 0)
          }, 0)
          return false
        },
        { priority: 10 },
      )

      if (!showSelect) return <Text>Loading actions...</Text>

      return (
        <Select
          focusValue={focusValue}
          options={[
            { label: 'First', value: 'first' },
            { label: 'Second', value: 'second' },
            { label: 'Third', value: 'third' },
          ]}
          onFocus={value => {
            focused = value
            setFocusValue(value)
          }}
          onChange={value => {
            selected = value
          }}
        />
      )
    }

    const h = createInkTestHarness(
      <KeypressProvider>
        <SelectRepeatedKeyRemountHarness />
      </KeypressProvider>,
    )
    harnessManager.track(h)

    await h.wait(40)
    expect(focused).toBe('first')

    h.stdin.write('\u001B[B\u001B[B')
    await h.wait(100)
    expect(focused).toBe('third')

    h.stdin.write('\r')
    await h.wait(40)

    expect(selected).toBe('third')
  })

  test('Select: scoped uncontrolled focus survives a keep-alive remount', async () => {
    let focused = ''
    let selected = ''

    function SelectScopedUncontrolledRemountHarness(): React.ReactNode {
      const [showSelect, setShowSelect] = useState(true)

      useKeypress(
        (_input, key) => {
          if (!key.downArrow) return

          setTimeout(() => {
            setShowSelect(false)
            setTimeout(() => setShowSelect(true), 0)
          }, 0)
          return false
        },
        { priority: 10 },
      )

      if (!showSelect) return <Text>Loading actions...</Text>

      return (
        <Select
          focusScope="test:scoped-uncontrolled-remount"
          options={[
            { label: 'First', value: 'first' },
            { label: 'Second', value: 'second' },
            { label: 'Third', value: 'third' },
          ]}
          onFocus={value => {
            focused = value
          }}
          onChange={value => {
            selected = value
          }}
        />
      )
    }

    const h = createInkTestHarness(
      <KeypressProvider>
        <SelectScopedUncontrolledRemountHarness />
      </KeypressProvider>,
    )
    harnessManager.track(h)

    await h.wait(40)
    expect(focused).toBe('first')

    h.stdin.write('\u001B[B\u001B[B')
    await h.wait(120)
    expect(focused).toBe('third')

    h.stdin.write('\r')
    await h.wait(40)

    expect(selected).toBe('third')
  })

  test('Select: scoped focus survives keep-alive remount with stale focusValue', async () => {
    let focused = ''
    let selected = ''

    function SelectScopedStaleFocusRemountHarness(): React.ReactNode {
      const [showSelect, setShowSelect] = useState(true)

      useKeypress(
        (_input, key) => {
          if (!key.downArrow) return

          setTimeout(() => {
            setShowSelect(false)
            setTimeout(() => setShowSelect(true), 0)
          }, 0)
          return false
        },
        { priority: 10 },
      )

      if (!showSelect) return <Text>Loading actions...</Text>

      return (
        <Select
          focusScope="test:scoped-stale-focus-remount"
          focusValue="first"
          options={[
            { label: 'First', value: 'first' },
            { label: 'Second', value: 'second' },
            { label: 'Third', value: 'third' },
          ]}
          onFocus={value => {
            focused = value
          }}
          onChange={value => {
            selected = value
          }}
        />
      )
    }

    const h = createInkTestHarness(
      <KeypressProvider>
        <SelectScopedStaleFocusRemountHarness />
      </KeypressProvider>,
    )
    harnessManager.track(h)

    await h.wait(40)
    expect(focused).toBe('first')

    h.stdin.write('\u001B[B\u001B[B')
    await h.wait(120)
    expect(focused).toBe('third')

    h.stdin.write('\r')
    await h.wait(40)

    expect(selected).toBe('third')
  })

  test('Select: scoped focus is not pulled back when keep-alive restores stale focusValue after remount', async () => {
    let focused = ''
    let selected = ''

    function SelectScopedRestoredStaleFocusRemountHarness(): React.ReactNode {
      const [showSelect, setShowSelect] = useState(true)
      const [focusValue, setFocusValue] = useState<string | undefined>('first')

      useKeypress(
        (_input, key) => {
          if (!key.downArrow) return

          setFocusValue(undefined)
          setTimeout(() => {
            setShowSelect(false)
            setTimeout(() => {
              setShowSelect(true)
              setTimeout(() => setFocusValue('first'), 20)
            }, 0)
          }, 0)
          return false
        },
        { priority: 10 },
      )

      if (!showSelect) return <Text>Loading actions...</Text>

      return (
        <Select
          focusScope="test:scoped-restored-stale-focus-remount"
          focusValue={focusValue}
          options={[
            { label: 'First', value: 'first' },
            { label: 'Second', value: 'second' },
            { label: 'Third', value: 'third' },
          ]}
          onFocus={value => {
            focused = value
          }}
          onChange={value => {
            selected = value
          }}
        />
      )
    }

    const h = createInkTestHarness(
      <KeypressProvider>
        <SelectScopedRestoredStaleFocusRemountHarness />
      </KeypressProvider>,
    )
    harnessManager.track(h)

    await h.wait(40)
    expect(focused).toBe('first')

    h.stdin.write('\u001B[B')
    await h.wait(140)
    expect(focused).toBe('second')

    h.stdin.write('\r')
    await h.wait(40)

    expect(selected).toBe('second')
  })

  test('Select: repeated down-arrow focus survives synchronous keep-alive remount', async () => {
    let focused = ''
    let selected = ''

    function SelectSyncRemountHarness(): React.ReactNode {
      const [showSelect, setShowSelect] = useState(true)

      useKeypress(
        (_input, key) => {
          if (!key.downArrow) return

          setShowSelect(false)
          setTimeout(() => setShowSelect(true), 0)
          return false
        },
        { priority: 10 },
      )

      if (!showSelect) return <Text>Loading actions...</Text>

      return (
        <Select
          focusScope="test:select-sync-remount"
          focusValue="first"
          options={[
            { label: 'First', value: 'first' },
            { label: 'Second', value: 'second' },
            { label: 'Third', value: 'third' },
          ]}
          onFocus={value => {
            focused = value
          }}
          onChange={value => {
            selected = value
          }}
        />
      )
    }

    const h = createInkTestHarness(
      <KeypressProvider>
        <SelectSyncRemountHarness />
      </KeypressProvider>,
    )
    harnessManager.track(h)

    await h.wait(40)
    expect(focused).toBe('first')

    h.stdin.write('\u001B[B\u001B[B')
    await h.wait(120)
    expect(focused).toBe('third')

    h.stdin.write('\r')
    await h.wait(40)

    expect(selected).toBe('third')
  })

  test('Select: lagging focusValue echo does not pull down-arrow focus backward', async () => {
    let focused = ''
    let selected = ''

    function SelectLaggingFocusEchoHarness(): React.ReactNode {
      const [focusValue, setFocusValue] = useState<string | undefined>('first')
      const [tick, setTick] = useState(0)

      useEffect(() => {
        const intervalId = setInterval(() => {
          setTick(prev => prev + 1)
        }, 30)
        return () => clearInterval(intervalId)
      }, [])

      return (
        <Select
          focusValue={focusValue}
          options={[
            { label: `First ${tick}`, value: 'first' },
            { label: `Second ${tick}`, value: 'second' },
            { label: `Third ${tick}`, value: 'third' },
          ]}
          onFocus={value => {
            focused = value
            setTimeout(() => setFocusValue(value), 80)
          }}
          onChange={value => {
            selected = value
          }}
        />
      )
    }

    const h = createInkTestHarness(
      <KeypressProvider>
        <SelectLaggingFocusEchoHarness />
      </KeypressProvider>,
    )
    harnessManager.track(h)

    await h.wait(40)
    expect(focused).toBe('first')

    h.stdin.write('\u001B[B')
    await h.wait(20)
    expect(focused).toBe('second')

    h.stdin.write('\u001B[B')
    await h.wait(40)
    expect(focused).toBe('third')

    await h.wait(120)
    expect(focused).toBe('third')

    h.stdin.write('\r')
    await h.wait(40)

    expect(selected).toBe('third')
  })

  test('Select: focusValue is applied after options arrive from keep-alive loading', async () => {
    let focused = ''

    function SelectDeferredOptionsHarness(): React.ReactNode {
      const [tick, setTick] = useState(0)

      useEffect(() => {
        const intervalId = setInterval(() => {
          setTick(prev => prev + 1)
        }, 30)
        return () => clearInterval(intervalId)
      }, [])

      const options =
        tick < 2
          ? []
          : [
              { label: `First ${tick}`, value: 'first' },
              { label: `Second ${tick}`, value: 'second' },
              { label: `Third ${tick}`, value: 'third' },
            ]

      return (
        <Select
          focusValue="second"
          options={options}
          onFocus={value => {
            focused = value
          }}
        />
      )
    }

    const h = createInkTestHarness(
      <KeypressProvider>
        <SelectDeferredOptionsHarness />
      </KeypressProvider>,
    )
    harnessManager.track(h)

    await h.wait(150)

    expect(focused).toBe('second')
  })

  test('Select: keep-alive label rerenders do not recenter the visible window', async () => {
    let focused = ''

    function SelectKeepAliveWindowHarness(): React.ReactNode {
      const [tick, setTick] = useState(0)

      useEffect(() => {
        const intervalId = setInterval(() => {
          setTick(prev => prev + 1)
        }, 30)
        return () => clearInterval(intervalId)
      }, [])

      return (
        <Select
          visibleOptionCount={3}
          options={[
            { label: `Alpha ${tick}`, value: 'alpha' },
            { label: `Beta ${tick}`, value: 'beta' },
            { label: `Gamma ${tick}`, value: 'gamma' },
            { label: `Delta ${tick}`, value: 'delta' },
            { label: `Epsilon ${tick}`, value: 'epsilon' },
          ]}
          onFocus={value => {
            focused = value
          }}
        />
      )
    }

    const h = createInkTestHarness(
      <KeypressProvider>
        <SelectKeepAliveWindowHarness />
      </KeypressProvider>,
    )
    harnessManager.track(h)

    await h.wait(60)
    h.stdin.write('\u001B[B')
    await h.wait(10)
    h.stdin.write('\u001B[B')
    await h.wait(10)

    expect(focused).toBe('gamma')

    h.clearOutput()
    await h.wait(80)

    const output = h.getOutput()
    expect(focused).toBe('gamma')
    expect(output).toContain('Alpha')
    expect(output).toContain('Gamma')
    expect(output).not.toContain('Delta')
  })

  test('Scoped index: hand-rolled list keeps down-arrow position across keep-alive remounts', async () => {
    let focused = ''
    const scope = `test:scoped-index-remount:${Date.now()}:${Math.random()}`

    function ScopedIndexList(): React.ReactNode {
      const items = ['first', 'second', 'third']
      const [selectedIndex, setSelectedIndex] = useScopedIndexState({
        scope,
        itemCount: items.length,
      })

      useEffect(() => {
        focused = items[selectedIndex] ?? ''
      }, [items, selectedIndex])

      useKeypress((_, key) => {
        if (!key.downArrow) return
        setSelectedIndex(prev => Math.min(items.length - 1, prev + 1))
        return true
      })

      return (
        <Box flexDirection="column">
          {items.map((item, index) => (
            <Text key={item}>
              {index === selectedIndex ? '>' : ' '} {item}
            </Text>
          ))}
        </Box>
      )
    }

    function KeepAliveRemountHarness(): React.ReactNode {
      const [showList, setShowList] = useState(true)

      useKeypress(
        (_, key) => {
          if (!key.downArrow) return

          setTimeout(() => {
            setShowList(false)
            setTimeout(() => setShowList(true), 0)
          }, 0)
          return false
        },
        { priority: 10 },
      )

      return showList ? <ScopedIndexList /> : <Text>Loading list...</Text>
    }

    const h = createInkTestHarness(
      <KeypressProvider>
        <KeepAliveRemountHarness />
      </KeypressProvider>,
    )
    harnessManager.track(h)

    await h.wait(40)
    expect(focused).toBe('first')

    h.stdin.write('\u001B[B')
    await h.wait(80)
    expect(focused).toBe('second')

    h.stdin.write('\u001B[B')
    await h.wait(80)
    expect(focused).toBe('third')
  })

  test('Scoped index: synchronous keep-alive removal persists down-arrow before unmount', async () => {
    let focused = ''
    const scope = `test:scoped-index-sync-remount:${Date.now()}:${Math.random()}`

    function ScopedIndexList(): React.ReactNode {
      const items = ['first', 'second', 'third']
      const [selectedIndex, setSelectedIndex] = useScopedIndexState({
        scope,
        itemCount: items.length,
      })

      useEffect(() => {
        focused = items[selectedIndex] ?? ''
      }, [items, selectedIndex])

      useKeypress((_, key) => {
        if (!key.downArrow) return
        setSelectedIndex(prev => Math.min(items.length - 1, prev + 1))
        return true
      })

      return (
        <Box flexDirection="column">
          {items.map((item, index) => (
            <Text key={item}>
              {index === selectedIndex ? '>' : ' '} {item}
            </Text>
          ))}
        </Box>
      )
    }

    function KeepAliveRemountHarness(): React.ReactNode {
      const [showList, setShowList] = useState(true)

      useKeypress(
        (_, key) => {
          if (!key.downArrow) return

          setShowList(false)
          setTimeout(() => setShowList(true), 0)
          return false
        },
        { priority: 10 },
      )

      return showList ? <ScopedIndexList /> : <Text>Loading list...</Text>
    }

    const h = createInkTestHarness(
      <KeypressProvider>
        <KeepAliveRemountHarness />
      </KeypressProvider>,
    )
    harnessManager.track(h)

    await h.wait(40)
    expect(focused).toBe('first')

    h.stdin.write('\u001B[B')
    await h.wait(80)
    expect(focused).toBe('second')
  })

  test('Scoped index: keep-alive initial index churn does not pull focus backward', async () => {
    let focused = ''
    const scope = `test:scoped-index-initial-churn:${Date.now()}:${Math.random()}`

    function ScopedIndexChurnList(): React.ReactNode {
      const items = ['first', 'second', 'third']
      const [tick, setTick] = useState(0)

      useEffect(() => {
        const intervalId = setInterval(() => {
          setTick(prev => prev + 1)
        }, 20)
        return () => clearInterval(intervalId)
      }, [])

      const [selectedIndex, setSelectedIndex] = useScopedIndexState({
        scope,
        itemCount: items.length,
        initialIndex: tick % 2,
      })

      useEffect(() => {
        focused = items[selectedIndex] ?? ''
      }, [items, selectedIndex])

      useKeypress((_, key) => {
        if (!key.downArrow) return
        setSelectedIndex(prev => Math.min(items.length - 1, prev + 1))
        return true
      })

      return (
        <Box flexDirection="column">
          {items.map((item, index) => (
            <Text key={item}>
              {index === selectedIndex ? '>' : ' '} {item}
            </Text>
          ))}
        </Box>
      )
    }

    const h = createInkTestHarness(
      <KeypressProvider>
        <ScopedIndexChurnList />
      </KeypressProvider>,
    )
    harnessManager.track(h)

    await h.wait(40)
    expect(focused).toBe('first')

    h.stdin.write('\u001B[B')
    await h.wait(40)
    expect(focused).toBe('second')

    h.stdin.write('\u001B[B')
    await h.wait(40)
    expect(focused).toBe('third')

    await h.wait(120)
    expect(focused).toBe('third')
  })

  test('ModelSelector: model params parent input leaves Enter on select fields to the Select', async () => {
    let activeField = 0
    let submitted = false

    function ModelParamsParentInputHarness(): React.ReactNode {
      const [activeFieldIndex, setActiveFieldIndex] = useState(0)
      const formFields = useMemo(
        () => [
          { name: 'maxTokens', component: 'select' },
          { name: 'submit', component: 'button' },
        ],
        [],
      )

      useEffect(() => {
        activeField = activeFieldIndex
      }, [activeFieldIndex])

      useModelSelectorInput({
        currentScreen: 'modelParams',
        mainMenuOptions: [],
        providerFocusIndex: 0,
        setProviderFocusIndex: () => {},
        partnerProviderOptions: [],
        partnerProviderFocusIndex: 0,
        setPartnerProviderFocusIndex: () => {},
        codingPlanOptions: [],
        codingPlanFocusIndex: 0,
        setCodingPlanFocusIndex: () => {},
        selectedProvider: 'custom-openai',
        apiKey: '',
        resourceName: '',
        providerBaseUrl: '',
        customBaseUrl: '',
        customModelName: '',
        contextLength: 128000,
        contextLengthOptions: [],
        setContextLength: () => {},
        isTestingConnection: false,
        connectionTestResult: null,
        activeFieldIndex,
        setActiveFieldIndex,
        handleProviderSelection: () => {},
        handleApiKeySubmit: () => {},
        fetchModelsWithRetry: async () => [],
        navigateTo: () => {},
        handleResourceNameSubmit: () => {},
        handleCustomBaseUrlSubmit: () => {},
        handleProviderBaseUrlSubmit: () => {},
        handleCustomModelSubmit: () => {},
        handleConfirmation: async () => {},
        setValidationError: () => {},
        handleConnectionTest: () => {},
        handleContextLengthSubmit: () => {},
        setModelLoadError: () => {},
        getFormFieldsForModelParams: () => formFields as any,
        handleModelParamsSubmit: () => {
          submitted = true
        },
      })

      return <Text>field:{activeFieldIndex}</Text>
    }

    const h = createInkTestHarness(
      <KeypressProvider>
        <ModelParamsParentInputHarness />
      </KeypressProvider>,
    )
    harnessManager.track(h)

    await h.wait(30)

    h.stdin.write('\r')
    await h.wait(40)
    expect(activeField).toBe(0)
    expect(submitted).toBe(false)

    h.stdin.write('\t')
    await h.wait(40)
    expect(activeField).toBe(1)

    h.stdin.write('\r')
    await h.wait(40)
    expect(submitted).toBe(true)
  })

  test('ModelSelector: mouse click selects Custom OpenAI provider from provider list', async () => {
    let done = false

    const h = createInkTestHarness(
      <KeypressProvider>
        <ModelSelector
          onDone={() => {
            done = true
          }}
          abortController={new AbortController()}
        />
      </KeypressProvider>,
    )
    harnessManager.track(h)

    await h.wait(75)

    const outputLines = h.getOutput().split(/\r?\n/)
    const customProviderLineIndex = outputLines.findIndex(line =>
      line.includes('Custom OpenAI API'),
    )
    expect(customProviderLineIndex).toBeGreaterThanOrEqual(0)

    const customProviderColumn =
      outputLines[customProviderLineIndex].indexOf('Custom OpenAI API') + 1
    expect(customProviderColumn).toBeGreaterThan(0)

    h.clearOutput()
    h.stdin.write(
      `\x1b[<0;${customProviderColumn};${customProviderLineIndex + 1}M`,
    )
    await h.wait(75)

    const output = h.getOutput()
    expect(done).toBe(false)
    expect(output).toContain('Custom API Server Setup')
    expect(output).toContain('Enter your custom API URL')
  })

  test('ModelSelector: mouse wheel moves provider focus', async () => {
    const h = createInkTestHarness(
      <KeypressProvider>
        <ModelSelector
          onDone={() => {}}
          abortController={new AbortController()}
        />
      </KeypressProvider>,
    )
    harnessManager.track(h)

    await h.wait(75)

    const outputLines = h.getOutput().split(/\r?\n/)
    const providerLineIndex = outputLines.findIndex(line =>
      line.includes('Other Providers'),
    )
    expect(providerLineIndex).toBeGreaterThanOrEqual(0)

    const providerColumn =
      outputLines[providerLineIndex].indexOf('Other Providers') + 1
    expect(providerColumn).toBeGreaterThan(0)

    h.stdin.write('\x1b[H')
    await h.wait(40)

    h.stdin.write(`\x1b[<65;${providerColumn};${providerLineIndex + 1}M`)
    await h.wait(40)

    h.clearOutput()
    h.stdin.write('\r')
    await h.wait(75)

    expect(h.getOutput()).toContain('Some Coding Plans')
  })

  test('ModelSelector: provider focus survives keep-alive remount', async () => {
    let focusedIndex = -1
    const focusScope = `test-model-selector-provider-${Date.now()}`
    const mainMenuOptions = [
      { value: 'partnerProviders', label: 'Other Providers ->' },
      { value: 'custom-openai', label: 'Custom OpenAI API' },
      { value: 'ollama', label: 'Ollama' },
    ]

    function ProviderFocusChild(): React.ReactNode {
      const state = useModelSelectorState({
        skipModelType: false,
        focusScope,
        providerOptionCount: mainMenuOptions.length,
      })

      useEffect(() => {
        focusedIndex = state.providerFocusIndex
      }, [state.providerFocusIndex])

      useModelSelectorInput({
        currentScreen: 'provider',
        mainMenuOptions,
        providerFocusIndex: state.providerFocusIndex,
        setProviderFocusIndex: state.setProviderFocusIndex,
        partnerProviderOptions: [],
        partnerProviderFocusIndex: 0,
        setPartnerProviderFocusIndex: () => {},
        codingPlanOptions: [],
        codingPlanFocusIndex: 0,
        setCodingPlanFocusIndex: () => {},
        selectedProvider: 'custom-openai',
        apiKey: '',
        resourceName: '',
        providerBaseUrl: '',
        customBaseUrl: '',
        customModelName: '',
        contextLength: 128000,
        contextLengthOptions: [],
        setContextLength: () => {},
        isTestingConnection: false,
        connectionTestResult: null,
        activeFieldIndex: 0,
        setActiveFieldIndex: () => {},
        handleProviderSelection: () => {},
        handleApiKeySubmit: () => {},
        fetchModelsWithRetry: async () => [],
        navigateTo: () => {},
        handleResourceNameSubmit: () => {},
        handleCustomBaseUrlSubmit: () => {},
        handleProviderBaseUrlSubmit: () => {},
        handleCustomModelSubmit: () => {},
        handleConfirmation: async () => {},
        setValidationError: () => {},
        handleConnectionTest: () => {},
        handleContextLengthSubmit: () => {},
        setModelLoadError: () => {},
        getFormFieldsForModelParams: () => [],
        handleModelParamsSubmit: () => {},
      })

      return <Text>provider:{state.providerFocusIndex}</Text>
    }

    function ProviderFocusHarness({
      mounted,
    }: {
      mounted: boolean
    }): React.ReactNode {
      return mounted ? <ProviderFocusChild /> : <Text>hidden</Text>
    }

    const renderHarness = (mounted: boolean) => (
      <KeypressProvider>
        <ProviderFocusHarness mounted={mounted} />
      </KeypressProvider>
    )

    const h = createInkTestHarness(renderHarness(true))
    harnessManager.track(h)

    await h.wait(30)
    expect(focusedIndex).toBe(0)

    h.stdin.write('\u001B[B')
    await h.wait(40)
    expect(focusedIndex).toBe(1)

    h.rerender(renderHarness(false))
    await h.wait(20)
    h.rerender(renderHarness(true))
    await h.wait(40)

    expect(focusedIndex).toBe(1)
    expect(h.getOutput()).toContain('provider:1')
  })

  test('ToolPicker: cursor focus survives keep-alive remount', async () => {
    const focusScope = `test-tool-picker-${Date.now()}`
    const tools = [
      { name: 'Read' },
      { name: 'Write' },
      { name: 'Bash' },
      { name: 'mcp__codegraph__search' },
    ]

    function ToolPickerHarness({
      mounted,
    }: {
      mounted: boolean
    }): React.ReactNode {
      return mounted ? (
        <ToolPicker
          tools={tools}
          initialTools={undefined}
          focusScope={focusScope}
          onComplete={() => {}}
          onCancel={() => {}}
        />
      ) : (
        <Text>hidden</Text>
      )
    }

    const renderHarness = (mounted: boolean) => (
      <KeypressProvider>
        <ToolPickerHarness mounted={mounted} />
      </KeypressProvider>
    )

    const h = createInkTestHarness(renderHarness(true))
    harnessManager.track(h)

    await h.wait(30)
    h.stdin.write('\u001B[B')
    await h.wait(40)

    h.clearOutput()
    h.rerender(renderHarness(false))
    await h.wait(20)
    h.rerender(renderHarness(true))
    await h.wait(40)

    const expected = `${figures.pointer} ${figures.checkboxOn} All tools`
    const deadline = Date.now() + 1_000
    while (!h.getOutput().includes(expected) && Date.now() < deadline) {
      await h.wait(20)
    }
    expect(h.getOutput()).toContain(expected)
  })

  test('KeypressProvider: priority can fall back to default on rerender', async () => {
    const handledBy: string[] = []

    function PriorityFallbackHarness(): React.ReactNode {
      const [isElevated, setIsElevated] = useState(true)

      useEffect(() => {
        const timer = setTimeout(() => setIsElevated(false), 50)
        return () => clearTimeout(timer)
      }, [])

      useKeypress(
        input => {
          if (input !== 'x') return
          handledBy.push('dynamic')
          return true
        },
        { priority: isElevated ? 50 : undefined },
      )

      useKeypress(
        input => {
          if (input !== 'x') return
          handledBy.push('fallback')
          return true
        },
        { priority: 0 },
      )

      return <Text>{isElevated ? 'elevated' : 'default'}</Text>
    }

    const h = createInkTestHarness(
      <KeypressProvider>
        <PriorityFallbackHarness />
      </KeypressProvider>,
    )
    harnessManager.track(h)

    await h.wait(25)
    h.stdin.write('x')
    await h.wait(25)

    expect(handledBy).toEqual(['dynamic'])

    await h.wait(80)
    expect(h.getOutput()).toContain('default')

    h.stdin.write('x')
    await h.wait(25)

    expect(handledBy).toEqual(['dynamic', 'fallback'])
  })

  test('KeypressProvider: mouse priority can fall back to default on rerender', async () => {
    const handledBy: string[] = []

    function MousePriorityFallbackHarness(): React.ReactNode {
      const [isElevated, setIsElevated] = useState(true)

      useEffect(() => {
        const timer = setTimeout(() => setIsElevated(false), 50)
        return () => clearTimeout(timer)
      }, [])

      useMouse(
        event => {
          if (event.type !== 'press') return
          handledBy.push('dynamic')
          return true
        },
        { priority: isElevated ? 50 : undefined },
      )

      useMouse(
        event => {
          if (event.type !== 'press') return
          handledBy.push('fallback')
          return true
        },
        { priority: 0 },
      )

      return <Text>{isElevated ? 'elevated' : 'default'}</Text>
    }

    const h = createInkTestHarness(
      <KeypressProvider>
        <MousePriorityFallbackHarness />
      </KeypressProvider>,
    )
    harnessManager.track(h)

    await h.wait(25)
    h.stdin.write('\x1b[<0;1;1M')
    await h.wait(25)

    expect(handledBy).toEqual(['dynamic'])

    await h.wait(80)
    expect(h.getOutput()).toContain('default')

    h.stdin.write('\x1b[<0;1;1M')
    await h.wait(25)

    expect(handledBy).toEqual(['dynamic', 'fallback'])
  })

  test('Bash overlay: ctrl+b is consumed before prompt input', async () => {
    let backgroundCalls = 0
    let promptCalls = 0
    const onBackgroundKeypress = createRunInBackgroundKeypressHandler(() => {
      backgroundCalls += 1
    })

    function BashOverlayHarness(): React.ReactNode {
      useToolKeypress(onBackgroundKeypress)
      useKeypress(
        (input, key) => {
          if (input !== 'b' || !key.ctrl) return false
          promptCalls += 1
          return true
        },
        { priority: KEYPRESS_PRIORITY.INPUT },
      )
      return <BashToolRunInBackgroundOverlay />
    }

    const h = createInkTestHarness(
      <KeypressProvider>
        <BashOverlayHarness />
      </KeypressProvider>,
    )
    harnessManager.track(h)

    await h.wait(25)

    h.stdin.write('\x02')
    await h.wait(25)
    h.stdin.write('\x02')
    await h.wait(25)

    expect(backgroundCalls).toBe(1)
    expect(promptCalls).toBe(0)
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
