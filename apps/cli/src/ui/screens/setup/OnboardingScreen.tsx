import React from 'react'
import { LoginScreen } from '#ui-ink/components/LoginScreen'

type Props = {
  onDone(result?: { skipped: boolean }): void
}

export function OnboardingScreen({ onDone }: Props): React.ReactNode {
  // First-run setup and /login use the same provider entry point. OAuth users
  // can choose an account-provided model, while API-key users continue into the
  // existing model profile flow. Leaving the top-level menu is an explicit
  // skip, so post-setup capability checks do not run unexpectedly.
  return (
    <LoginScreen
      onDone={() => onDone({ skipped: false })}
      onCancel={() => onDone({ skipped: true })}
      isOnboarding={true}
    />
  )
}
