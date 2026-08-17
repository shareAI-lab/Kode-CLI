import {
  useReducer,
  type Reducer,
  useCallback,
  useMemo,
  useRef,
  useEffect,
} from 'react'
import OptionMap from './option-map'
import { Option } from '@inkjs/ui'
import type { OptionHeader, OptionSubtree } from './select'
import {
  createDefaultState,
  flattenOptions,
  type DefaultSelectState,
} from './select-state'

type State = DefaultSelectState & {
  staleFocusedIndex?: number
}

function optionStructureKey(
  options: ReturnType<typeof flattenOptions>,
): string {
  return JSON.stringify(
    options.map(option =>
      'value' in option
        ? ['option', option.value]
        : ['header', option.optionValues],
    ),
  )
}

type ScopedFocusSnapshot = {
  value: string
  recentValues: string[]
  structureKey: string
  updatedAt: number
}

const SCOPED_FOCUS_TTL_MS = 5_000
const scopedFocusSnapshots = new Map<string, ScopedFocusSnapshot>()

function hasSelectableValue(
  options: ReturnType<typeof flattenOptions>,
  value: string | undefined,
): value is string {
  return Boolean(
    value &&
    options.some(option => 'value' in option && option.value === value),
  )
}

function getInitialFocusValue(args: {
  focusScope?: string
  structureKey: string
  flatOptions: ReturnType<typeof flattenOptions>
  requestedValue?: string
}): { value?: string; recentValues: string[]; usedScopedSnapshot: boolean } {
  if (!args.focusScope) {
    return {
      value: args.requestedValue,
      recentValues: [],
      usedScopedSnapshot: false,
    }
  }

  const snapshot = scopedFocusSnapshots.get(args.focusScope)
  if (
    snapshot &&
    snapshot.structureKey === args.structureKey &&
    Date.now() - snapshot.updatedAt <= SCOPED_FOCUS_TTL_MS &&
    hasSelectableValue(args.flatOptions, snapshot.value)
  ) {
    return {
      value: snapshot.value,
      recentValues: snapshot.recentValues,
      usedScopedSnapshot: true,
    }
  }

  return {
    value: args.requestedValue,
    recentValues: [],
    usedScopedSnapshot: false,
  }
}

function rememberScopedFocus(args: {
  focusScope?: string
  structureKey: string
  value?: string
}): void {
  if (!args.focusScope || !args.value) return
  const previous = scopedFocusSnapshots.get(args.focusScope)
  const recentValues =
    previous?.structureKey === args.structureKey
      ? previous.recentValues.filter(value => value !== args.value)
      : []
  recentValues.push(args.value)
  scopedFocusSnapshots.set(args.focusScope, {
    value: args.value,
    recentValues: recentValues.slice(-5),
    structureKey: args.structureKey,
    updatedAt: Date.now(),
  })
}

type Action =
  | { type: 'focus-next-option' }
  | { type: 'focus-previous-option' }
  | { type: 'select-focused-option' }
  | { type: 'select-option'; value: string }
  | { type: 'clear-selected-option'; value: string }
  | { type: 'set-focus'; value: string }
  | {
      type: 'sync-options'
      visibleOptionCount: number
      options: (Option | OptionSubtree)[]
      defaultValue?: string
    }

function getAdjacentSelectableValue(
  state: Pick<State, 'focusedValue' | 'optionMap'>,
  direction: 'next' | 'previous',
): string | undefined {
  if (!state.focusedValue) {
    return undefined
  }

  const item = state.optionMap.get(state.focusedValue)

  if (!item) {
    return undefined
  }

  let adjacent = direction === 'next' ? item.next : item.previous
  while (adjacent && !('value' in adjacent)) {
    adjacent = direction === 'next' ? adjacent.next : adjacent.previous
  }

  return adjacent && 'value' in adjacent ? adjacent.value : undefined
}

function getAdjacentSelectableValueFromStaleIndex(
  state: Pick<State, 'optionMap' | 'staleFocusedIndex'>,
  direction: 'next' | 'previous',
): string | undefined {
  const { staleFocusedIndex } = state
  if (staleFocusedIndex === undefined) return undefined

  const values: Array<{ value: string; index: number }> = []
  for (const option of state.optionMap.values()) {
    if ('value' in option)
      values.push({ value: option.value, index: option.index })
  }

  if (direction === 'next') {
    return values.find(option => option.index >= staleFocusedIndex)?.value
  }

  return values.reverse().find(option => option.index < staleFocusedIndex)
    ?.value
}

const reducer: Reducer<State, Action> = (state, action) => {
  switch (action.type) {
    case 'focus-next-option': {
      const nextValue =
        getAdjacentSelectableValue(state, 'next') ??
        getAdjacentSelectableValueFromStaleIndex(state, 'next')

      if (!nextValue) {
        return state
      }

      const next = state.optionMap.get(nextValue)
      if (!next || !('value' in next)) return state

      const needsToScroll = next.index >= state.visibleToIndex

      if (!needsToScroll) {
        return {
          ...state,
          focusedValue: next.value,
          staleFocusedIndex: undefined,
        }
      }

      const nextVisibleToIndex = Math.min(
        state.optionMap.size,
        state.visibleToIndex + 1,
      )

      const nextVisibleFromIndex = nextVisibleToIndex - state.visibleOptionCount

      return {
        ...state,
        focusedValue: next.value,
        visibleFromIndex: nextVisibleFromIndex,
        visibleToIndex: nextVisibleToIndex,
        staleFocusedIndex: undefined,
      }
    }

    case 'focus-previous-option': {
      const previousValue =
        getAdjacentSelectableValue(state, 'previous') ??
        getAdjacentSelectableValueFromStaleIndex(state, 'previous')

      if (!previousValue) {
        return state
      }

      const previous = state.optionMap.get(previousValue)
      if (!previous || !('value' in previous)) return state

      const needsToScroll = previous.index <= state.visibleFromIndex

      if (!needsToScroll) {
        return {
          ...state,
          focusedValue: previous.value,
          staleFocusedIndex: undefined,
        }
      }

      const nextVisibleFromIndex = Math.max(0, state.visibleFromIndex - 1)

      const nextVisibleToIndex = nextVisibleFromIndex + state.visibleOptionCount

      return {
        ...state,
        focusedValue: previous.value,
        visibleFromIndex: nextVisibleFromIndex,
        visibleToIndex: nextVisibleToIndex,
        staleFocusedIndex: undefined,
      }
    }

    case 'select-focused-option': {
      const focusedEntry = state.focusedValue
        ? state.optionMap.get(state.focusedValue)
        : undefined
      if (!focusedEntry || !('value' in focusedEntry)) return state

      return {
        ...state,
        previousValue: state.value,
        value: focusedEntry.value,
      }
    }

    case 'select-option': {
      if (!state.optionMap.get(action.value)) return state

      return {
        ...state,
        focusedValue: action.value,
        previousValue: state.value,
        value: action.value,
        staleFocusedIndex: undefined,
      }
    }

    case 'clear-selected-option': {
      if (state.value !== action.value) return state

      return {
        ...state,
        previousValue: action.value,
        value: undefined,
      }
    }

    case 'sync-options': {
      const preferredFocusedValue =
        state.focusedValue ?? state.value ?? action.defaultValue
      const previousFocusedIndex = state.focusedValue
        ? (state.optionMap.get(state.focusedValue)?.index ??
          state.staleFocusedIndex)
        : undefined
      const nextState = createDefaultState({
        visibleOptionCount: action.visibleOptionCount,
        defaultValue: preferredFocusedValue,
        options: action.options,
      })
      const focusedValueMissing =
        state.focusedValue !== undefined &&
        !nextState.optionMap.get(state.focusedValue)
      const value =
        state.value && nextState.optionMap.get(state.value)
          ? state.value
          : undefined
      const focusedValue = focusedValueMissing
        ? state.focusedValue
        : nextState.focusedValue

      return {
        ...nextState,
        focusedValue,
        staleFocusedIndex: focusedValueMissing
          ? previousFocusedIndex
          : undefined,
        previousValue: value === state.value ? state.previousValue : undefined,
        value,
      }
    }

    case 'set-focus': {
      if (!state.optionMap.get(action.value)) return state
      if (state.focusedValue === action.value) return state

      return {
        ...state,
        focusedValue: action.value,
        staleFocusedIndex: undefined,
      }
    }
  }
}

export type UseSelectStateProps = {
  /**
   * Number of items to display.
   *
   * @default 5
   */
  visibleOptionCount?: number

  /**
   * Options.
   */
  options: (Option | OptionSubtree)[]

  /**
   * Initially selected option's value.
   */
  defaultValue?: string

  /**
   * Callback for selecting an option.
   */
  onChange?: (value: string) => void

  /**
   * Callback for focusing an option.
   */
  onFocus?: (value: string) => void

  /**
   * Value to focus
   */
  focusValue?: string

  /**
   * Stable scope used to preserve focus across short keep-alive remounts.
   */
  focusScope?: string
}

export type SelectState = Pick<
  State,
  'focusedValue' | 'visibleFromIndex' | 'visibleToIndex' | 'value'
> & {
  /**
   * Visible options.
   */
  visibleOptions: Array<(Option | OptionHeader) & { index: number }>

  /**
   * Focus next option and scroll the list down, if needed.
   */
  focusNextOption: () => void

  /**
   * Focus previous option and scroll the list up, if needed.
   */
  focusPreviousOption: () => void

  /**
   * Select currently focused option.
   */
  selectFocusedOption: () => void

  /**
   * Select an option by value.
   */
  selectOption: (value: string) => void
}

export const useSelectState = ({
  visibleOptionCount = 5,
  options,
  defaultValue,
  onChange,
  onFocus,
  focusValue,
  focusScope,
}: UseSelectStateProps) => {
  const flatOptions = useMemo(() => flattenOptions(options), [options])
  const structureKey = useMemo(
    () => optionStructureKey(flatOptions),
    [flatOptions],
  )
  const focusValueExists = useMemo(
    () => hasSelectableValue(flatOptions, focusValue),
    [flatOptions, focusValue],
  )
  const requestedInitialFocusValue = focusValue ?? defaultValue
  const initialFocusValue = useMemo(
    () =>
      getInitialFocusValue({
        focusScope,
        structureKey,
        flatOptions,
        requestedValue: requestedInitialFocusValue,
      }),
    // This is intentionally an initializer snapshot. Later focus changes are
    // reducer-driven; prop changes are handled by the focusValue effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  )

  const [state, dispatch] = useReducer(
    reducer,
    {
      visibleOptionCount,
      defaultValue: initialFocusValue.value,
      options,
    },
    createDefaultState,
  )
  const stateRef = useRef<State>(state)
  stateRef.current = state

  const onChangeRef = useRef(onChange)
  const onFocusRef = useRef(onFocus)
  const lastFocusedValueRef = useRef<string | undefined>(state.focusedValue)
  const lastNotifiedFocusValueRef = useRef<string | undefined>(undefined)
  const focusNotificationSequenceRef = useRef(0)
  const latestFocusNotificationSequenceRef = useRef(0)
  const pendingFocusEchoesRef = useRef(new Map<string, number>())
  const lastSyncedRef = useRef({
    structureKey,
    visibleOptionCount,
  })

  const notifyFocus = useCallback(
    (value: string | undefined) => {
      if (!value) return

      lastFocusedValueRef.current = value
      rememberScopedFocus({ focusScope, structureKey, value })

      if (lastNotifiedFocusValueRef.current === value) return
      lastNotifiedFocusValueRef.current = value
      const sequence = ++focusNotificationSequenceRef.current
      latestFocusNotificationSequenceRef.current = sequence
      pendingFocusEchoesRef.current.set(value, sequence)
      onFocusRef.current?.(value)
    },
    [focusScope, structureKey],
  )

  const dispatchWithFocusMirror = useCallback(
    (action: Action) => {
      const previousState = stateRef.current
      const nextState = reducer(previousState, action)
      stateRef.current = nextState

      if (nextState.focusedValue !== previousState.focusedValue) {
        notifyFocus(nextState.focusedValue)
      }

      dispatch(action)
    },
    [notifyFocus],
  )

  useEffect(() => {
    onChangeRef.current = onChange
  }, [onChange])

  useEffect(() => {
    onFocusRef.current = onFocus
  }, [onFocus])

  useEffect(() => {
    notifyFocus(state.focusedValue)
  }, [notifyFocus, state.focusedValue])

  useEffect(() => {
    const lastSynced = lastSyncedRef.current
    if (
      lastSynced.structureKey === structureKey &&
      lastSynced.visibleOptionCount === visibleOptionCount
    ) {
      return
    }

    lastSyncedRef.current = {
      structureKey,
      visibleOptionCount,
    }
    dispatchWithFocusMirror({
      type: 'sync-options',
      visibleOptionCount,
      defaultValue: lastFocusedValueRef.current ?? focusValue ?? defaultValue,
      options,
    })
  }, [
    defaultValue,
    dispatchWithFocusMirror,
    focusValue,
    options,
    structureKey,
    visibleOptionCount,
  ])

  const focusNextOption = useCallback(() => {
    dispatchWithFocusMirror({
      type: 'focus-next-option',
    })
  }, [dispatchWithFocusMirror])

  const focusPreviousOption = useCallback(() => {
    dispatchWithFocusMirror({
      type: 'focus-previous-option',
    })
  }, [dispatchWithFocusMirror])

  const selectFocusedOption = useCallback(() => {
    dispatchWithFocusMirror({
      type: 'select-focused-option',
    })
  }, [dispatchWithFocusMirror])

  const selectOption = useCallback(
    (value: string) => {
      dispatchWithFocusMirror({
        type: 'select-option',
        value,
      })
    },
    [dispatchWithFocusMirror],
  )

  const visibleOptions = useMemo(() => {
    return flatOptions
      .map((option, index) => ({
        ...option,
        index,
      }))
      .slice(state.visibleFromIndex, state.visibleToIndex)
  }, [flatOptions, state.visibleFromIndex, state.visibleToIndex])

  useEffect(() => {
    if (state.value && state.previousValue !== state.value) {
      const selectedValue = state.value
      try {
        onChangeRef.current?.(selectedValue)
      } finally {
        dispatchWithFocusMirror({
          type: 'clear-selected-option',
          value: selectedValue,
        })
      }
    }
  }, [dispatchWithFocusMirror, state.previousValue, state.value])

  const appliedFocusValueRef = useRef<string | undefined>(
    initialFocusValue.usedScopedSnapshot ? focusValue : undefined,
  )
  const initialScopedRecentValuesRef = useRef<Set<string>>(
    initialFocusValue.usedScopedSnapshot
      ? new Set(initialFocusValue.recentValues)
      : new Set(),
  )
  const usedScopedSnapshotRef = useRef(initialFocusValue.usedScopedSnapshot)
  const ignoredFocusEchoRef = useRef<string | undefined>(undefined)
  const previousFocusValuePropRef = useRef<string | undefined>(focusValue)
  useEffect(() => {
    const previousFocusValue = previousFocusValuePropRef.current
    if (previousFocusValue !== focusValue) {
      previousFocusValuePropRef.current = focusValue
      ignoredFocusEchoRef.current = undefined
    }

    if (!focusValue) {
      return
    }

    if (!focusValueExists) {
      return
    }

    const currentFocusedValue = stateRef.current.focusedValue
    if (ignoredFocusEchoRef.current === focusValue) {
      return
    }

    if (
      usedScopedSnapshotRef.current &&
      previousFocusValue === undefined &&
      currentFocusedValue !== focusValue &&
      initialScopedRecentValuesRef.current.has(focusValue)
    ) {
      ignoredFocusEchoRef.current = focusValue
      appliedFocusValueRef.current = focusValue
      return
    }

    const pendingEchoSequence = pendingFocusEchoesRef.current.get(focusValue)
    if (pendingEchoSequence !== undefined) {
      pendingFocusEchoesRef.current.delete(focusValue)

      // Parent state can echo an older onFocus after a newer keypress.
      if (
        currentFocusedValue !== focusValue &&
        pendingEchoSequence < latestFocusNotificationSequenceRef.current
      ) {
        ignoredFocusEchoRef.current = focusValue
        return
      }
    }

    if (currentFocusedValue === focusValue) {
      appliedFocusValueRef.current = focusValue
      return
    }

    if (appliedFocusValueRef.current === focusValue) return
    appliedFocusValueRef.current = focusValue
    dispatchWithFocusMirror({
      type: 'set-focus',
      value: focusValue,
    })
  }, [dispatchWithFocusMirror, focusValue, focusValueExists])

  return {
    focusedValue: state.focusedValue,
    visibleFromIndex: state.visibleFromIndex,
    visibleToIndex: state.visibleToIndex,
    value: state.value,
    visibleOptions,
    focusNextOption,
    focusPreviousOption,
    selectFocusedOption,
    selectOption,
  }
}
