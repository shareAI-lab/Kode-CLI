import React from 'react'
import { ModelSelector } from '#ui-ink/components/ModelSelector'

type Props = {
  onDone(result?: { skipped: boolean }): void
}

export function OnboardingScreen({ onDone }: Props): React.ReactNode {
  // Skip theme selection, go directly to model selector. Escaping/cancelling
  // the model selector counts as explicitly skipping onboarding: the user
  // opted out of configuration, so the post-setup /capabilities run must be
  // skipped too (previously "skipped" was hardcoded false, so cancelled
  // onboarding still auto-ran a command in the first session).
  return (
    <ModelSelector
      onDone={() => onDone({ skipped: false })}
      onCancel={() => onDone({ skipped: true })}
      skipModelType={true}
      isOnboarding={true}
    />
  )
}
