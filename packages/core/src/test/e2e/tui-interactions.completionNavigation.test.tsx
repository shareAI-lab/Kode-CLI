import { afterEach, describe, expect, test } from 'bun:test'
import React, { useCallback, useState } from 'react'
import { Text } from 'ink'
import { KeypressProvider } from '#ui-ink/contexts/KeypressContext'
import { useCompletionActions } from '#ui-ink/hooks/useUnifiedCompletion/actions'
import { useUnifiedCompletionNavigationKeys } from '#ui-ink/hooks/useUnifiedCompletion/useNavigationKeys'
import { useUnifiedCompletionTabKey } from '#ui-ink/hooks/useUnifiedCompletion/useTabKey'
import type { CompletionState } from '#ui-ink/hooks/useUnifiedCompletion/types'
import type {
  CompletionContext,
  UnifiedSuggestion,
} from '#cli-utils/completion/types'
import { createInkHarnessManager, createInkTestHarness } from './inkTestHarness'

const harnessManager = createInkHarnessManager()

afterEach(async () => {
  await harnessManager.cleanup()
})

function makeState(overrides: Partial<CompletionState>): CompletionState {
  return {
    suggestions: [],
    selectedIndex: 0,
    isActive: false,
    context: null,
    preview: null,
    emptyDirMessage: '',
    suppressUntil: 0,
    ...overrides,
  }
}

const directorySuggestion: UnifiedSuggestion = {
  value: 'empty/',
  displayValue: 'empty/',
  type: 'file',
  score: 1,
}

const directoryContext: CompletionContext = {
  type: 'file',
  trigger: '@',
  prefix: 'empty/',
  startPos: 0,
  endPos: 7,
}

const slashCommandSuggestions: UnifiedSuggestion[] = [
  {
    value: 'first',
    displayValue: '/first',
    type: 'command',
    score: 2,
  },
  {
    value: 'second',
    displayValue: '/second',
    type: 'command',
    score: 1,
  },
]

const slashCommandContext: CompletionContext = {
  type: 'command',
  trigger: '/',
  prefix: 'se',
  startPos: 0,
  endPos: 3,
}

function CompletionNavigationHarness({
  updates,
}: {
  updates: Array<Partial<CompletionState>>
}): React.ReactNode {
  const [state, setState] = useState(() =>
    makeState({
      suggestions: [directorySuggestion],
      isActive: true,
      context: directoryContext,
    }),
  )

  const updateState = useCallback(
    (next: Partial<CompletionState>) => {
      updates.push(next)
      setState(prev => ({ ...prev, ...next }))
    },
    [updates],
  )

  const resetCompletion = useCallback(() => {
    setState(prev => ({
      ...prev,
      suggestions: [],
      selectedIndex: 0,
      isActive: false,
      context: null,
      preview: null,
      emptyDirMessage: '',
    }))
  }, [])

  useUnifiedCompletionNavigationKeys({
    input: '@empty/',
    state,
    resetCompletion,
    updateState,
    generateSuggestions: () => [],
    completeWith: () => '@empty/',
    activateCompletion: (suggestions, context) => {
      setState(prev => ({
        ...prev,
        suggestions,
        selectedIndex: 0,
        isActive: true,
        context,
        preview: null,
      }))
    },
    onInputChange: () => {},
    setCursorOffset: () => {},
    isEnabled: true,
  })

  return <Text>EMPTY:{state.emptyDirMessage}</Text>
}

function DirectoryFollowupTypingHarness({
  generatedContexts,
}: {
  generatedContexts: CompletionContext[]
}): React.ReactNode {
  const [input, setInput] = useState('@em')
  const [state, setState] = useState(() =>
    makeState({
      suggestions: [directorySuggestion],
      isActive: true,
      context: { ...directoryContext, prefix: 'em', endPos: 3 },
    }),
  )

  const resetCompletion = useCallback(() => {
    setState(prev => ({
      ...prev,
      suggestions: [],
      selectedIndex: 0,
      isActive: false,
      context: null,
      preview: null,
      emptyDirMessage: '',
    }))
  }, [])

  useUnifiedCompletionNavigationKeys({
    input,
    state,
    resetCompletion,
    updateState: next => setState(prev => ({ ...prev, ...next })),
    generateSuggestions: context => {
      generatedContexts.push(context)
      return []
    },
    completeWith: () => {
      setInput('@empty/')
      setTimeout(() => setInput('@empty/x'), 10)
      return '@empty/'
    },
    activateCompletion: () => {},
    onInputChange: setInput,
    setCursorOffset: () => {},
    isEnabled: true,
  })

  return <Text>INPUT:{input}</Text>
}

function TabCompletionHarness({
  initiallyActive,
  selectedIndex = 0,
}: {
  initiallyActive: boolean
  selectedIndex?: number
}): React.ReactNode {
  const [input, setInput] = useState('/se')
  const [cursorOffset, setCursorOffset] = useState(3)
  const [state, setState] = useState(() =>
    initiallyActive
      ? makeState({
          suggestions: slashCommandSuggestions,
          selectedIndex,
          isActive: true,
          context: slashCommandContext,
        })
      : makeState({}),
  )
  const { completeWith } = useCompletionActions({
    input,
    onInputChange: setInput,
    setCursorOffset,
  })

  const resetCompletion = useCallback(() => {
    setState(prev => ({
      ...prev,
      suggestions: [],
      selectedIndex: 0,
      isActive: false,
      context: null,
      preview: null,
      emptyDirMessage: '',
    }))
  }, [])

  const updateState = useCallback((updates: Partial<CompletionState>) => {
    setState(prev => ({ ...prev, ...updates }))
  }, [])

  const activateCompletion = useCallback(
    (suggestions: UnifiedSuggestion[], context: CompletionContext) => {
      setState(prev => ({
        ...prev,
        suggestions,
        selectedIndex: 0,
        isActive: true,
        context,
        preview: null,
      }))
    },
    [],
  )

  useUnifiedCompletionTabKey({
    input,
    state,
    getWordAtCursor: () => slashCommandContext,
    generateSuggestions: () => slashCommandSuggestions,
    completeWith,
    activateCompletion,
    resetCompletion,
    updateState,
    onInputChange: setInput,
    setCursorOffset,
    isEnabled: true,
  })

  return (
    <Text>{`INPUT:${input}|CURSOR:${cursorOffset}|ACTIVE:${state.isActive}`}</Text>
  )
}

const filePathContext: CompletionContext = {
  type: 'file',
  prefix: 'src/ma',
  startPos: 6,
  endPos: 12,
}

const filePathSuggestions: UnifiedSuggestion[] = [
  {
    value: 'src/main.ts',
    displayValue: 'src/main.ts',
    type: 'file',
    score: 1,
  },
]

const fileTabSuggestions: UnifiedSuggestion[] = [
  {
    value: 'src/main.ts',
    displayValue: 'src/main.ts',
    type: 'file',
    score: 2,
  },
  {
    value: 'src/math.ts',
    displayValue: 'src/math.ts',
    type: 'file',
    score: 1,
  },
]

const fileTabContext: CompletionContext = {
  type: 'file',
  prefix: 'src/ma',
  startPos: 0,
  endPos: 6,
  trigger: null,
}

function FileTabCycleEscHarness(): React.ReactNode {
  const [input, setInput] = useState('src/ma')
  const [cursorOffset, setCursorOffset] = useState(6)
  const [state, setState] = useState(() => makeState({}))
  const { completeWith } = useCompletionActions({
    input,
    onInputChange: setInput,
    setCursorOffset,
  })

  const resetCompletion = useCallback(() => {
    setState(prev => ({
      ...prev,
      suggestions: [],
      selectedIndex: 0,
      isActive: false,
      context: null,
      preview: null,
      emptyDirMessage: '',
    }))
  }, [])

  const updateState = useCallback((updates: Partial<CompletionState>) => {
    setState(prev => ({ ...prev, ...updates }))
  }, [])

  const activateCompletion = useCallback(
    (suggestions: UnifiedSuggestion[], context: CompletionContext) => {
      setState(prev => ({
        ...prev,
        suggestions,
        selectedIndex: 0,
        isActive: true,
        context,
        preview: null,
      }))
    },
    [],
  )

  useUnifiedCompletionTabKey({
    input,
    state,
    getWordAtCursor: () => fileTabContext,
    generateSuggestions: () => fileTabSuggestions,
    completeWith,
    activateCompletion,
    resetCompletion,
    updateState,
    onInputChange: setInput,
    setCursorOffset,
    isEnabled: true,
  })

  useUnifiedCompletionNavigationKeys({
    input,
    state,
    resetCompletion,
    updateState,
    generateSuggestions: () => fileTabSuggestions,
    completeWith,
    activateCompletion,
    onInputChange: setInput,
    setCursorOffset,
    isEnabled: true,
  })

  return (
    <Text>{`INPUT:${input}|ORIG:${state.preview?.originalInput ?? ''}|ACTIVE:${state.isActive}`}</Text>
  )
}

function FileEnterCompletionHarness(): React.ReactNode {
  const [input, setInput] = useState('check src/ma')
  const [cursorOffset, setCursorOffset] = useState(12)
  const [state, setState] = useState(() =>
    makeState({
      suggestions: filePathSuggestions,
      selectedIndex: 0,
      isActive: true,
      context: filePathContext,
    }),
  )
  const { completeWith } = useCompletionActions({
    input,
    onInputChange: setInput,
    setCursorOffset,
  })

  const resetCompletion = useCallback(() => {
    setState(prev => ({
      ...prev,
      suggestions: [],
      selectedIndex: 0,
      isActive: false,
      context: null,
      preview: null,
      emptyDirMessage: '',
    }))
  }, [])

  const updateState = useCallback((updates: Partial<CompletionState>) => {
    setState(prev => ({ ...prev, ...updates }))
  }, [])

  const activateCompletion = useCallback(
    (suggestions: UnifiedSuggestion[], context: CompletionContext) => {
      setState(prev => ({
        ...prev,
        suggestions,
        selectedIndex: 0,
        isActive: true,
        context,
        preview: null,
      }))
    },
    [],
  )

  useUnifiedCompletionNavigationKeys({
    input,
    state,
    resetCompletion,
    updateState,
    generateSuggestions: () => filePathSuggestions,
    completeWith,
    activateCompletion,
    onInputChange: setInput,
    setCursorOffset,
    isEnabled: true,
  })

  return (
    <Text>{`INPUT:${input}|CURSOR:${cursorOffset}|ACTIVE:${state.isActive}`}</Text>
  )
}

describe('TUI E2E regression (Ink render): completion navigation', () => {
  test('clears delayed empty-directory updates when completion unmounts', async () => {
    const updates: Array<Partial<CompletionState>> = []
    const h = createInkTestHarness(
      <KeypressProvider>
        <CompletionNavigationHarness updates={updates} />
      </KeypressProvider>,
    )
    harnessManager.track(h)

    await h.wait(25)
    h.stdin.write('\u001b[C')
    await h.wait(100)

    expect(updates).toEqual([{ emptyDirMessage: 'No files in empty/' }])

    h.unmount()
    await h.wait(3200)

    expect(updates).toEqual([{ emptyDirMessage: 'No files in empty/' }])
  })

  test('does not reopen directory completion after the user keeps typing', async () => {
    const generatedContexts: CompletionContext[] = []
    const h = createInkTestHarness(
      <KeypressProvider>
        <DirectoryFollowupTypingHarness generatedContexts={generatedContexts} />
      </KeypressProvider>,
    )
    harnessManager.track(h)

    await h.wait(25)
    h.stdin.write('\u001b[C')
    await h.wait(100)

    expect(h.getOutput()).toContain('INPUT:@empty/x')
    expect(generatedContexts).toEqual([])
  })

  test('Tab accepts the selected slash command and closes completion', async () => {
    const h = createInkTestHarness(
      <KeypressProvider>
        <TabCompletionHarness initiallyActive={true} selectedIndex={1} />
      </KeypressProvider>,
    )
    harnessManager.track(h)

    await h.wait(25)
    expect(h.getOutput()).toContain('INPUT:/se|CURSOR:3|ACTIVE:true')

    h.clearOutput()
    h.stdin.write('\t')
    await h.wait(50)

    expect(h.getOutput()).toContain('INPUT:/second |CURSOR:8|ACTIVE:false')
  })

  test('Tab opens the command list when more than one command matches', async () => {
    const h = createInkTestHarness(
      <KeypressProvider>
        <TabCompletionHarness initiallyActive={false} />
      </KeypressProvider>,
    )
    harnessManager.track(h)

    await h.wait(25)
    expect(h.getOutput()).toContain('INPUT:/se|CURSOR:3|ACTIVE:false')

    h.clearOutput()
    h.stdin.write('\t')
    await h.wait(50)

    expect(h.getOutput()).toContain('INPUT:/se|CURSOR:3|ACTIVE:true')
  })

  test('Tab cycling keeps the original input so Esc can restore it', async () => {
    const h = createInkTestHarness(
      <KeypressProvider>
        <FileTabCycleEscHarness />
      </KeypressProvider>,
    )
    harnessManager.track(h)

    await h.wait(25)
    expect(h.getOutput()).toContain('INPUT:src/ma|ORIG:|ACTIVE:false')

    h.clearOutput()
    h.stdin.write('\t')
    await h.wait(50)
    expect(h.getOutput()).toContain('INPUT:src/main.ts|ORIG:src/ma|ACTIVE:true')

    h.clearOutput()
    h.stdin.write('\t')
    await h.wait(50)
    expect(h.getOutput()).toContain('INPUT:src/math.ts|ORIG:src/ma|ACTIVE:true')

    h.clearOutput()
    h.stdin.write('\u001b')
    // Lone ESC is flushed after ESC_TIMEOUT (50ms) in KeypressContext.
    await h.wait(150)
    expect(h.getOutput()).toContain('INPUT:src/ma|ORIG:|ACTIVE:false')
  })

  test('Enter inserts a file path without submitting', async () => {
    const h = createInkTestHarness(
      <KeypressProvider>
        <FileEnterCompletionHarness />
      </KeypressProvider>,
    )
    harnessManager.track(h)

    await h.wait(25)
    expect(h.getOutput()).toContain('INPUT:check src/ma|CURSOR:12|ACTIVE:true')

    h.clearOutput()
    h.stdin.write('\r')
    await h.wait(50)

    expect(h.getOutput()).toContain(
      'INPUT:check src/main.ts |CURSOR:18|ACTIVE:false',
    )
  })
})
