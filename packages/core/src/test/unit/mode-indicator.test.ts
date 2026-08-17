import { describe, expect, test } from 'bun:test'

import { getTheme } from '#core/utils/theme'
import { __getModeIndicatorDisplayForTests } from '#ui-ink/components/ModeIndicator'

describe('ModeIndicator', () => {
  test('Ask mode matches expected format', () => {
    const theme = getTheme('dark')
    const indicator = __getModeIndicatorDisplayForTests({
      mode: 'cautious',
      shortcutDisplayText: 'shift+tab',
      theme,
    })

    expect(indicator.color).toBe(theme.warning)
    expect(indicator.mainText).toBe('Tool permissions: Ask before tools')
    expect(indicator.shortcutHintText).toBe(
      ' (shift+tab to change · ask before tool use)',
    )
  })

  test('Edit mode matches expected format', () => {
    const theme = getTheme('dark')
    const indicator = __getModeIndicatorDisplayForTests({
      mode: 'acceptEdits',
      shortcutDisplayText: 'shift+tab',
      theme,
    })

    expect(indicator.color).toBe(theme.autoAccept)
    expect(indicator.mainText).toBe('Tool permissions: Edit')
    expect(indicator.shortcutHintText).toBe(
      ' (shift+tab to change · run workspace operations automatically)',
    )
  })

  test('Plan mode matches expected format', () => {
    const theme = getTheme('dark')
    const indicator = __getModeIndicatorDisplayForTests({
      mode: 'plan',
      shortcutDisplayText: 'shift+tab',
      theme,
    })

    expect(indicator.color).toBe(theme.success)
    expect(indicator.mainText).toBe('Tool permissions: Plan first')
    expect(indicator.shortcutHintText).toBe(
      ' (shift+tab to change · review plans before implementation)',
    )
  })
})
