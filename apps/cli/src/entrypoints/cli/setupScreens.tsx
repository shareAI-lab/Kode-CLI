import React from 'react'

import { MACRO } from '#core/constants/macros'
import { OnboardingScreen } from '#ui-ink/screens/setup/OnboardingScreen'
import { TrustScreen } from '#ui-ink/screens/setup/TrustScreen'
import { KeypressProvider } from '#ui-ink/contexts/KeypressContext'
import {
  checkHasTrustDialogAccepted,
  getModelCredentialStatus,
  getGlobalConfig,
  saveGlobalConfig,
} from '#core/utils/config'
import { withEphemeralAlternateScreen } from '#cli-utils/terminal'
import { grantReadPermissionForOriginalDir } from '#core/utils/permissions/filesystem'
import {
  renderWithTuiStdio,
  type InkRenderInstance,
} from '#ui-ink/utils/inkRender'
import { terminalCapabilityManager } from '#ui-ink/utils/terminalCapabilityManager'
import { handleMcprcServerApprovals } from './mcpServerApproval'
import { computeOnboardingPlan } from './onboarding/plan'

export function completeOnboarding(): void {
  const config = getGlobalConfig()
  saveGlobalConfig({
    ...config,
    hasCompletedOnboarding: true,
    lastOnboardingVersion: MACRO.VERSION,
  })
}

export async function showSetupScreens(
  safeMode?: boolean,
  print?: boolean,
): Promise<{ postSetupInitialPrompt?: string }> {
  if (process.env.NODE_ENV === 'test') {
    return {}
  }

  // Never show interactive setup screens in print mode.
  if (print) return {}

  const isInteractive = Boolean(process.stdin.isTTY && process.stdout.isTTY)

  const config = getGlobalConfig()
  const hasConfiguredModels = Boolean(
    (config.modelProfiles ?? []).some(
      profile => profile.isActive && getModelCredentialStatus(profile).success,
    ),
  )

  const onboardingPlan = computeOnboardingPlan({
    config,
    isInteractive,
    hasConfiguredModels,
  })

  let postSetupInitialPrompt: string | undefined

  if (onboardingPlan.shouldShowOnboarding) {
    let skipped = false
    const { render } = await import('ink')
    await withEphemeralAlternateScreen(async () => {
      await new Promise<void>(resolve => {
        let instance: InkRenderInstance | undefined
        instance = renderWithTuiStdio(
          render,
          <KeypressProvider
            debugKeystrokeLogging={Boolean(process.env.KODE_DEBUG_KEYSTROKES)}
          >
            <OnboardingScreen
              onDone={result => {
                skipped = result?.skipped === true
                completeOnboarding()
                instance?.unmount?.()
                resolve()
              }}
            />
          </KeypressProvider>,
          { exitOnCtrlC: false },
        )
      })
    })
    terminalCapabilityManager.enableSupportedModes()

    if (onboardingPlan.shouldAutoRunCapabilities && !skipped) {
      postSetupInitialPrompt = '/capabilities'
    }
  }

  if (safeMode && !checkHasTrustDialogAccepted()) {
    const { render } = await import('ink')
    await withEphemeralAlternateScreen(async () => {
      await new Promise<void>(resolve => {
        let instance: InkRenderInstance | undefined
        const onDone = () => {
          grantReadPermissionForOriginalDir()
          instance?.unmount?.()
          resolve()
        }
        instance = renderWithTuiStdio(
          render,
          <KeypressProvider
            debugKeystrokeLogging={Boolean(process.env.KODE_DEBUG_KEYSTROKES)}
          >
            <TrustScreen onDone={onDone} />
          </KeypressProvider>,
          { exitOnCtrlC: false },
        )
      })
    })
    terminalCapabilityManager.enableSupportedModes()
  }

  await handleMcprcServerApprovals()
  return { postSetupInitialPrompt }
}
