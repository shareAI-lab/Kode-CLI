import { useKeypress } from '#ui-ink/hooks/useKeypress'
import { type SelectState } from './use-select-state'

export type UseSelectProps = {
  /**
   * When disabled, user input is ignored.
   *
   * @default false
   */
  isDisabled?: boolean

  /**
   * Select state.
   */
  state: SelectState
}

/**
 * Resolves the single-key permission shortcuts (y/a/n) against the currently
 * visible options. Returns the option value to select, or null when no option
 * matches the pressed key.
 */
export function resolveShortcutOptionValue(
  visibleOptions: SelectState['visibleOptions'],
  input: string,
): string | null {
  if (!input || input.length !== 1) return null

  const optionWithValue = (predicate: (value: string) => boolean) => {
    const option = visibleOptions.find(
      (
        visibleOption,
      ): visibleOption is { value: string; label: string; index: number } =>
        'value' in visibleOption &&
        typeof visibleOption.value === 'string' &&
        predicate(visibleOption.value),
    )
    return option
  }

  const lower = input.toLowerCase()
  if (lower === 'y') {
    return (
      optionWithValue(value => value === 'yes' || value.startsWith('yes'))
        ?.value ?? null
    )
  }
  if (lower === 'a') {
    // "Always allow" style options carry values like yes-session, yes-exact,
    // yes-prefix or yes-dont-ask-again-*; every one of them starts with "yes"
    // but is not the plain allow-once value.
    return (
      optionWithValue(value => value.startsWith('yes') && value !== 'yes')
        ?.value ?? null
    )
  }
  if (lower === 'n') {
    return (
      optionWithValue(value => value === 'no' || value === 'deny')?.value ??
      null
    )
  }
  return null
}

export const useSelect = ({ isDisabled = false, state }: UseSelectProps) => {
  useKeypress(
    (input, key) => {
      if (key.downArrow) {
        state.focusNextOption()
        return true
      }

      if (key.upArrow) {
        state.focusPreviousOption()
        return true
      }

      if (key.return) {
        state.selectFocusedOption()
        return true
      }

      if (key.insertable && !key.ctrl && !key.meta && /^[1-9]$/.test(input)) {
        const selectableOptionIndex = Number.parseInt(input, 10) - 1
        const option = state.visibleOptions.filter(
          visibleOption => 'value' in visibleOption,
        )[selectableOptionIndex]

        if (option && 'value' in option) {
          state.selectOption(option.value)
        }

        return true
      }

      // Single-key accelerators for common permission answers. They map to the
      // dialog's option values so every per-tool dialog inherits them:
      //   y = allow once (first "yes" option)
      //   a = always allow / don't ask again
      //   n = deny
      if (key.insertable && !key.ctrl && !key.meta) {
        const shortcutValue = resolveShortcutOptionValue(
          state.visibleOptions,
          input,
        )
        if (shortcutValue !== null) {
          state.selectOption(shortcutValue)
          return true
        }
      }

      return undefined
    },
    { isActive: !isDisabled },
  )
}
