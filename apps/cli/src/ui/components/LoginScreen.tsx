import * as React from 'react'
import { Box, Text } from 'ink'
import figures from 'figures'

import { ModelSelector } from '#ui-ink/components/ModelSelector'
import { useKeypress } from '#ui-ink/hooks/useKeypress'
import { useExitOnCtrlCD } from '#ui-ink/hooks/useExitOnCtrlCD'
import { ScreenFrame } from '#ui-ink/primitives/layout/ScreenFrame'
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
  type CodexLoginStatus,
} from '#cli-services/codexLogin'

type LoginRoute = 'selection' | 'openai' | 'providers' | 'copilot' | 'grok'
type CodexFlowState =
  'selection' | 'waiting' | 'activating' | 'complete' | 'error'

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

const CODEX_POLL_INTERVAL_MS = 1_500
const CODEX_LOGIN_TIMEOUT_MS = 5 * 60 * 1_000

export type LoginScreenProps = {
  onDone: () => void
  codexAuth?: CodexAuthService
  copilotAuth?: CopilotAuthService
  pollIntervalMs?: number
  saveProfile?: typeof saveExternalRuntimeModelProfile
}

function statusLabel(
  status: CodexLoginStatus | null,
  checking: boolean,
): string {
  if (checking) return 'Checking installed Codex CLI…'
  if (status?.kind === 'authenticated') return 'Codex is already signed in.'
  if (status?.kind === 'unauthenticated') return 'Codex is not signed in yet.'
  return 'Codex CLI is unavailable on this machine.'
}

export function LoginScreen({
  onDone,
  codexAuth = codexAuthService,
  copilotAuth = copilotAuthService,
  pollIntervalMs = CODEX_POLL_INTERVAL_MS,
  saveProfile = saveExternalRuntimeModelProfile,
}: LoginScreenProps): React.ReactNode {
  const theme = getTheme()
  const exitState = useExitOnCtrlCD(onDone)
  const [route, setRoute] = React.useState<LoginRoute>('selection')
  const [selectedIndex, setSelectedIndex] = React.useState(0)
  const [codexStatus, setCodexStatus] = React.useState<CodexLoginStatus | null>(
    null,
  )
  const [checkingStatus, setCheckingStatus] = React.useState(true)
  const [codexFlowState, setCodexFlowState] =
    React.useState<CodexFlowState>('selection')
  const [codexError, setCodexError] = React.useState<string | null>(null)
  const [codexActivatedModel, setCodexActivatedModel] = React.useState<
    string | null
  >(null)
  const activeCodexLoginIdRef = React.useRef(0)
  const checkForLoginRef = React.useRef<(() => Promise<void>) | null>(null)

  const refreshCodexStatus = React.useCallback(
    async (canUpdate: () => boolean = () => true) => {
      try {
        const nextStatus = await codexAuth.getStatus()
        if (canUpdate()) setCodexStatus(nextStatus)
        return nextStatus
      } catch {
        const unavailable: CodexLoginStatus = { kind: 'unavailable' }
        if (canUpdate()) setCodexStatus(unavailable)
        return unavailable
      } finally {
        if (canUpdate()) setCheckingStatus(false)
      }
    },
    [codexAuth],
  )

  React.useEffect(() => {
    let cancelled = false
    void refreshCodexStatus(() => !cancelled)
    return () => {
      cancelled = true
    }
  }, [refreshCodexStatus])

  React.useEffect(() => {
    if (codexFlowState !== 'waiting') return undefined

    let cancelled = false
    let checking = false
    const loginId = activeCodexLoginIdRef.current
    const isCurrent = () =>
      !cancelled && activeCodexLoginIdRef.current === loginId
    const checkForLogin = async () => {
      if (checking) return
      checking = true
      const nextStatus = await refreshCodexStatus(isCurrent)
      checking = false
      if (!isCurrent()) return

      if (nextStatus.kind === 'authenticated') {
        setCodexFlowState('activating')
      } else if (nextStatus.kind === 'unavailable') {
        setCodexError('Codex CLI could not be reached while signing in.')
        setCodexFlowState('error')
      }
    }
    checkForLoginRef.current = checkForLogin

    const interval = setInterval(
      () => void checkForLogin(),
      Math.max(50, pollIntervalMs),
    )
    const timeout = setTimeout(() => {
      if (!isCurrent()) return
      setCodexError('Timed out waiting for Codex sign-in to finish.')
      setCodexFlowState('error')
    }, CODEX_LOGIN_TIMEOUT_MS)

    return () => {
      cancelled = true
      if (checkForLoginRef.current === checkForLogin) {
        checkForLoginRef.current = null
      }
      clearInterval(interval)
      clearTimeout(timeout)
    }
  }, [codexFlowState, pollIntervalMs, refreshCodexStatus])

  React.useEffect(() => {
    if (codexFlowState !== 'activating') return undefined

    let mounted = true
    void (async () => {
      try {
        // A signed-in Codex CLI is not enough: Kode also needs a model profile
        // that routes through the Codex runtime. Apply Codex's recommended
        // model and activate it as the main pointer so the user can start
        // using it immediately.
        const settings = await codexAuth.getRecommendedSettings()
        await saveProfile(
          {
            provider: 'codex-oauth',
            model: settings.model,
            displayName: settings.displayName || settings.model,
            ...(settings.reasoningEffort
              ? { reasoningEffort: settings.reasoningEffort }
              : {}),
          },
          true,
        )
        if (!mounted) return
        setCodexActivatedModel(settings.displayName || settings.model)
        setCodexFlowState('complete')
      } catch (error) {
        if (!mounted) return
        setCodexError(
          `Signed in, but could not activate the Codex model: ${
            error instanceof Error ? error.message : String(error)
          }`,
        )
        setCodexFlowState('error')
      }
    })()
    return () => {
      mounted = false
    }
  }, [codexFlowState, codexAuth, saveProfile])

  const startCodexBrowserLogin = React.useCallback(async () => {
    if (checkingStatus) return

    if (codexStatus?.kind === 'authenticated') {
      setCodexFlowState('activating')
      return
    }
    if (codexStatus?.kind === 'unavailable') {
      setCodexError('Install or repair the Codex CLI, then try again.')
      setCodexFlowState('error')
      return
    }

    setCodexError(null)
    const loginId = activeCodexLoginIdRef.current + 1
    activeCodexLoginIdRef.current = loginId
    setCodexFlowState('waiting')
    try {
      await codexAuth.startLogin()
    } catch {
      if (activeCodexLoginIdRef.current !== loginId) return
      setCodexError('Unable to start the Codex browser sign-in.')
      setCodexFlowState('error')
    }
  }, [checkingStatus, codexAuth, codexStatus])
  useKeypress((input, key) => {
    if (route !== 'selection') return undefined

    const inputChar = input.length === 1 ? input.toLowerCase() : ''
    const isUp = key.upArrow || inputChar === 'k'
    const isDown = key.downArrow || inputChar === 'j'

    if (codexFlowState === 'waiting') {
      if (key.escape) {
        activeCodexLoginIdRef.current += 1
        checkForLoginRef.current = null
        setCodexFlowState('selection')
      }
      if (key.return) {
        void checkForLoginRef.current?.()
      }
      return true
    }

    if (codexFlowState === 'activating') return true

    if (codexFlowState === 'complete') {
      if (key.return || key.escape) onDone()
      return true
    }

    if (codexFlowState === 'error') {
      if (key.return || key.escape) {
        setCodexError(null)
        setCodexFlowState('selection')
      }
      return true
    }

    if (key.escape) {
      onDone()
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
        void startCodexBrowserLogin()
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

  if (route === 'openai') {
    return (
      <ModelSelector
        initialProvider="openai"
        onDone={onDone}
        onCancel={() => setRoute('selection')}
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
      />
    )
  }

  if (route === 'providers') {
    return (
      <ModelSelector onDone={onDone} onCancel={() => setRoute('selection')} />
    )
  }

  const selectedOption = LOGIN_OPTIONS[selectedIndex]
  return (
    <ScreenFrame title="Sign in" paddingX={2} paddingY={1} gap={1}>
      <Box flexDirection="column" gap={1}>
        <Text bold>Choose how to configure Kode:</Text>

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

        {codexFlowState === 'selection' ? (
          <Box flexDirection="column" gap={1}>
            <Text color={theme.secondaryText}>
              {selectedOption?.description}
            </Text>
            {selectedOption?.id === 'codex' ? (
              <Text color={theme.secondaryText}>
                {statusLabel(codexStatus, checkingStatus)}
              </Text>
            ) : null}
            <Text dimColor>
              ChatGPT/Codex credentials remain in Codex CLI. Kode never reads or
              copies its credential cache; configure an API-key model profile to
              use OpenAI models directly in Kode.
            </Text>
          </Box>
        ) : null}

        {codexFlowState === 'waiting' ? (
          <Box flexDirection="column" gap={1}>
            <Text color={theme.suggestion}>
              Browser sign-in started. Complete the Codex / ChatGPT login, then
              this screen will continue automatically.
            </Text>
            <Text dimColor>Enter checks again · Esc returns to choices</Text>
          </Box>
        ) : null}

        {codexFlowState === 'complete' ? (
          <Box flexDirection="column" gap={1}>
            <Text color={theme.success}>
              {codexActivatedModel
                ? `Codex is signed in and Kode is now using ${codexActivatedModel}. Press Enter to continue.`
                : 'Codex is signed in. Press Enter to continue.'}
            </Text>
            <Text dimColor>
              This confirms the installed Codex CLI session; it does not copy
              credentials into Kode.
            </Text>
          </Box>
        ) : null}

        {codexFlowState === 'activating' ? (
          <Box flexDirection="column" gap={1}>
            <Text color={theme.suggestion}>
              Codex is signed in. Activating its model for Kode…
            </Text>
            <Text dimColor>
              Please wait while the model configuration is saved.
            </Text>
          </Box>
        ) : null}

        {codexFlowState === 'error' ? (
          <Box flexDirection="column" gap={1}>
            <Text color={theme.error}>{codexError}</Text>
            <Text dimColor>Press Enter to return to login choices.</Text>
          </Box>
        ) : null}

        <Text dimColor>
          {exitState.pending
            ? `Press ${exitState.keyName} again to exit`
            : codexFlowState === 'selection'
              ? '↑/↓ or j/k navigate · Enter select · Esc exit'
              : ''}
        </Text>
      </Box>
    </ScreenFrame>
  )
}
