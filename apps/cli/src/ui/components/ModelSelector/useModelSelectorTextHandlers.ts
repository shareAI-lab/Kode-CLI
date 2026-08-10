import type { ModelSelectorState } from './useModelSelectorState'

export function useModelSelectorTextHandlers(state: ModelSelectorState) {
  function handleCursorOffsetChange(offset: number) {
    state.setCursorOffset(offset)
  }

  function handleApiKeyChange(value: string) {
    state.setApiKeyEdited(true)
    // This input stores only an environment-variable name. Keep the user's text
    // intact so validation can explain invalid names instead of silently changing it.
    state.setApiKey(value)
    state.setCursorOffset(value.length)
  }

  function handleModelSearchChange(value: string) {
    state.setModelSearchQuery(value)
    state.setModelSearchCursorOffset(value.length)
  }

  function handleModelSearchCursorOffsetChange(offset: number) {
    state.setModelSearchCursorOffset(offset)
  }

  return {
    handleCursorOffsetChange,
    handleApiKeyChange,
    handleModelSearchChange,
    handleModelSearchCursorOffsetChange,
  }
}

export type ModelSelectorTextHandlers = ReturnType<
  typeof useModelSelectorTextHandlers
>
