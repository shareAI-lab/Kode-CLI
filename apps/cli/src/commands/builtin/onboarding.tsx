import * as React from 'react'
import type { Command } from '../types'
import { OnboardingScreen } from '#ui-ink/screens/setup/OnboardingScreen'
import { clearTerminal } from '#cli-utils/terminal'

export default {
  type: 'local-jsx',
  name: 'onboarding',
  description: 'Connect a provider and set up your first model',
  isEnabled: true,
  isHidden: false,
  ui: { displayMode: 'fullscreen' },
  async call(onDone, context) {
    await clearTerminal()

    return (
      <OnboardingScreen
        onDone={result => {
          const status =
            result?.skipped === true
              ? 'Onboarding skipped.'
              : 'Onboarding complete.'
          onDone(
            `${status} Recommended next step: run /capabilities to audit and auto-fix optional features.`,
          )
        }}
      />
    )
  },
  userFacingName() {
    return 'onboarding'
  },
} satisfies Command
