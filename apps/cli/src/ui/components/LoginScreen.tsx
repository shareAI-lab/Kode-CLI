import * as React from 'react'
import { Box, Text } from 'ink'
import figures from 'figures'

import { ModelSelector } from '#ui-ink/components/ModelSelector'
import { useKeypress } from '#ui-ink/hooks/useKeypress'
import { useExitOnCtrlCD } from '#ui-ink/hooks/useExitOnCtrlCD'
import { ScreenFrame } from '#ui-ink/primitives/layout/ScreenFrame'
import { setAllPointersToModel } from '#core/utils/config'
import { getTheme } from '#core/utils/theme'
import { saveExternalRuntimeModelProfile } from '#cli-services/externalModelProfile'
import {
  copilotAuthService,
  type CopilotAuthService,
} from '#cli-services/copilotLogin'
import { grokAuthService } from '#cli-services/grokLogin'
import { ExternalOAuthLoginScreen } from '#ui-ink/components/ExternalOAuthLoginScreen'
import {
  codexAuthService,
  type CodexAuthService,
} from '#cli-services/codexLogin'

type LoginRoute =
  'selection' | 'codex' | 'openai' | 'providers' | 'copilot' | 'grok'

type LoginOption = {
  id: 'codex' | 'copilot' | 'grok' | 'openai' | 'providers'
  label: string
  description: string
}

const LOGIN_OPTIONS: LoginOption[] = [
  {
    id: 'codex',
    label: 'Codex / ChatGPT',
    description: 'Use the installed Codex CLI browser sign-in.',
  },
  {
    id: 'copilot',
    label: 'GitHub Copilot (OAuth)',
    description:
      'Use the official GitHub Copilot browser or device OAuth flow.',
  },
  {
    id: 'grok',
    label: 'Grok Build',
    description: 'Use the installed Grok Build CLI browser sign-in.',
  },
  {
    id: 'openai',
    label: 'OpenAI API key (GPT-5-Codex)',
    description:
      'Configure an OpenAI model profile that Kode can use directly.',
  },
  {
    id: 'providers',
    label: 'Another model provider',
    description: 'Configure any supported API provider and model profile.',
  },
]

const LOGIN_POLL_INTERVAL_MS = 1_500

export type LoginScreenProps = {
  onDone: () => void
  /** Called only when the user leaves the top-level sign-in menu. */
  onCancel?: () => void
  /** First-run setup assigns its chosen model to every role pointer. */
  isOnboarding?: boolean
  codexAuth?: CodexAuthService
  copilotAuth?: CopilotAuthService
  pollIntervalMs?: number
  saveProfile?: typeof saveExternalRuntimeModelProfile
}

export function LoginScreen({
  onDone,
  onCancel = onDone,
  isOnboarding = false,
  codexAuth = codexAuthService,
  copilotAuth = copilotAuthService,
  pollIntervalMs = LOGIN_POLL_INTERVAL_MS,
  saveProfile = saveExternalRuntimeModelProfile,
}: LoginScreenProps): React.ReactNode {
  const theme = getTheme()
  const exitState = useExitOnCtrlCD(onCancel)
  const [route, setRoute] = React.useState<LoginRoute>('selection')
  const [selectedIndex, setSelectedIndex] = React.useState(0)
  const applyOnboardingPointers = React.useCallback(
    async (modelId: string, activateAsMain: boolean) => {
      if (isOnboarding && activateAsMain) setAllPointersToModel(modelId)
    },
    [isOnboarding],
  )

  useKeypress((input, key) => {
    if (route !== 'selection') return undefined

    const inputChar = input.length === 1 ? input.toLowerCase() : ''
    const isUp = key.upArrow || inputChar === 'k'
    const isDown = key.downArrow || inputChar === 'j'

    if (key.escape) {
      onCancel()
      return true
    }
    if (isUp) {
      setSelectedIndex(current =>
        current === 0 ? LOGIN_OPTIONS.length - 1 : current - 1,
      )
      return true
    }
    if (isDown) {
      setSelectedIndex(current => (current + 1) % LOGIN_OPTIONS.length)
      return true
    }
    if (key.return) {
      const option = LOGIN_OPTIONS[selectedIndex]
      if (option?.id === 'codex') {
        setRoute('codex')
      } else if (option?.id === 'copilot') {
        setRoute('copilot')
      } else if (option?.id === 'grok') {
        setRoute('grok')
      } else if (option?.id === 'openai') {
        setRoute('openai')
      } else if (option?.id === 'providers') {
        setRoute('providers')
      }
      return true
    }
    return undefined
  })

  if (route === 'codex') {
    return (
      <ExternalOAuthLoginScreen
        provider="codex-oauth"
        title="Codex / ChatGPT"
        authService={codexAuth}
        onDone={onDone}
        onCancel={() => setRoute('selection')}
        pollIntervalMs={pollIntervalMs}
        saveProfile={saveProfile}
        onProfileSaved={applyOnboardingPointers}
      />
    )
  }

  if (route === 'openai') {
    return (
      <ModelSelector
        initialProvider="openai"
        onDone={onDone}
        onCancel={() => setRoute('selection')}
        isOnboarding={isOnboarding}
      />
    )
  }

  if (route === 'grok') {
    return (
      <ExternalOAuthLoginScreen
        provider="grok-build"
        title="Grok Build"
        authService={grokAuthService}
        onDone={onDone}
        onCancel={() => setRoute('selection')}
        onProfileSaved={applyOnboardingPointers}
      />
    )
  }

  if (route === 'copilot') {
    return (
      <ExternalOAuthLoginScreen
        provider="github-copilot"
        title="GitHub Copilot OAuth"
        authService={copilotAuth}
        onDone={onDone}
        onCancel={() => setRoute('selection')}
        pollIntervalMs={pollIntervalMs}
        onProfileSaved={applyOnboardingPointers}
      />
    )
  }

  if (route === 'providers') {
    return (
      <ModelSelector
        onDone={onDone}
        onCancel={() => setRoute('selection')}
        isOnboarding={isOnboarding}
      />
    )
  }

  return (
    <ScreenFrame title="Connect a model" paddingX={2} paddingY={1} gap={1}>
      <Box flexDirection="column" gap={1}>
        <Text bold>Choose a sign-in or model setup method:</Text>

        <Box flexDirection="column">
          {LOGIN_OPTIONS.map((option, index) => {
            const isSelected = index === selectedIndex
            return (
              <Box key={option.id} flexDirection="row">
                <Text color={isSelected ? theme.kode : theme.secondaryText}>
                  {isSelected ? figures.pointer : ' '}
                </Text>
                <Text
                  color={isSelected ? theme.text : theme.secondaryText}
                  bold={isSelected}
                >
                  {' '}
                  {option.label}
                </Text>
              </Box>
            )
          })}
        </Box>

        <Text color={theme.secondaryText}>
          {LOGIN_OPTIONS[selectedIndex]?.description}
        </Text>

        <Text dimColor>
          {exitState.pending
            ? `Press ${exitState.keyName} again to exit`
            : '↑/↓ or j/k navigate · Enter select · Esc back'}
        </Text>
      </Box>
    </ScreenFrame>
  )
}
