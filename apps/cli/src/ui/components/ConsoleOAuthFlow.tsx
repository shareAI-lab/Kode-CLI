import React, { useEffect, useState, useCallback } from 'react'
import { Box, Text } from 'ink'
import { OAuthService, createAndStoreApiKey } from '#core/services/oauth'
import { getTheme } from '#core/utils/theme'
import { ASCII_LOGO } from '#core/constants/product'
import { useTerminalSize } from '#ui-ink/hooks/useTerminalSize'
import { logError } from '#core/utils/log'
import { WelcomeBox } from '#ui-ink/components/WelcomeBox'
import { sendNotification } from '#core/services/notifier'
import { ConsoleOAuthStatusMessage } from './ConsoleOAuthStatusMessage'
import { PASTE_HERE_MSG, type OAuthStatus } from './oauthTypes'
import { useKeypress } from '#ui-ink/hooks/useKeypress'
import { computeAvailableColumns } from '#ui-ink/primitives/layout/viewportColumns'

type Props = {
  onDone(): void
  createOAuthService?: () => OAuthFlowService
  createApiKey?: (accessToken: string) => Promise<string | null>
  notify?: typeof sendNotification
  pastePromptDelayMs?: number
  retryDelayMs?: number
}

type OAuthFlowService = {
  startOAuthFlow(
    authURLHandler: (url: string) => Promise<void>,
  ): Promise<{ accessToken: string }>
  processCallback(args: {
    authorizationCode: string
    state: string
    useManualRedirect: boolean
  }): void
  cancelOAuthFlow?(): void | Promise<void>
}

export function ConsoleOAuthFlow({
  onDone,
  createOAuthService = () => new OAuthService(),
  createApiKey = createAndStoreApiKey,
  notify = sendNotification,
  pastePromptDelayMs = 3000,
  retryDelayMs = 1000,
}: Props): React.ReactNode {
  const [oauthStatus, setOAuthStatus] = useState<OAuthStatus>({
    state: 'idle',
  })
  const theme = getTheme()

  const [pastedCode, setPastedCode] = useState('')
  const [cursorOffset, setCursorOffset] = useState(0)
  const [oauthService] = useState(createOAuthService)
  const mountedRef = React.useRef(true)
  const activeAttemptIdRef = React.useRef(0)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      activeAttemptIdRef.current += 1
      void oauthService.cancelOAuthFlow?.()
    }
  }, [oauthService])
  // After a few seconds we suggest the user to copy/paste url if the
  // browser did not open automatically. In this flow we expect the user to
  // copy the code from the browser and paste it in the terminal
  const [showPastePrompt, setShowPastePrompt] = useState(false)

  const { columns } = useTerminalSize()
  const textInputColumns = computeAvailableColumns({
    columns,
    reservedColumns: PASTE_HERE_MSG.length + 1,
  })

  // Retry logic
  useEffect(() => {
    if (oauthStatus.state !== 'about_to_retry') return undefined

    const timer = setTimeout(() => {
      setOAuthStatus(oauthStatus.nextState)
    }, retryDelayMs)
    return () => clearTimeout(timer)
  }, [oauthStatus, retryDelayMs])

  useEffect(() => {
    if (oauthStatus.state !== 'waiting_for_login') return undefined

    setShowPastePrompt(false)
    const timer = setTimeout(() => {
      setShowPastePrompt(true)
    }, pastePromptDelayMs)
    return () => clearTimeout(timer)
  }, [oauthStatus, pastePromptDelayMs])

  useKeypress((_, key) => {
    if (key.return) {
      if (oauthStatus.state === 'idle') {
        setOAuthStatus({ state: 'ready_to_start' })
      } else if (oauthStatus.state === 'success') {
        onDone()
      } else if (oauthStatus.state === 'error' && oauthStatus.toRetry) {
        setPastedCode('')
        setOAuthStatus({
          state: 'about_to_retry',
          nextState: oauthStatus.toRetry,
        })
      }
    }
  })

  async function handleSubmitCode(value: string, url: string) {
    try {
      // Expecting format "authorizationCode#state" from the authorization callback URL
      const [authorizationCode, state] = value.split('#')

      if (!authorizationCode || !state) {
        setOAuthStatus({
          state: 'error',
          message: 'Invalid code. Please make sure the full code was copied',
          toRetry: { state: 'waiting_for_login', url },
        })
        return
      }

      // Track which path the user is taking (manual code entry)

      oauthService.processCallback({
        authorizationCode,
        state,
        useManualRedirect: true,
      })
    } catch (err) {
      logError(err)
      setOAuthStatus({
        state: 'error',
        message: (err as Error).message,
        toRetry: { state: 'waiting_for_login', url },
      })
    }
  }

  const startOAuth = useCallback(async () => {
    const attemptId = activeAttemptIdRef.current + 1
    activeAttemptIdRef.current = attemptId
    const isCurrent = () =>
      mountedRef.current && activeAttemptIdRef.current === attemptId

    try {
      const result = await oauthService
        .startOAuthFlow(async url => {
          if (!isCurrent()) return
          setOAuthStatus({ state: 'waiting_for_login', url })
        })
        .catch(err => {
          if (!isCurrent()) throw err
          // Handle token exchange errors specifically
          if (err.message.includes('Token exchange failed')) {
            setOAuthStatus({
              state: 'error',
              message:
                'Failed to exchange authorization code for access token. Please try again.',
              toRetry: { state: 'ready_to_start' },
            })
          } else {
            // Handle other errors
            setOAuthStatus({
              state: 'error',
              message: err.message,
              toRetry: { state: 'ready_to_start' },
            })
          }
          throw err
        })

      if (!isCurrent()) return
      setOAuthStatus({ state: 'creating_api_key' })

      const apiKey = await createApiKey(result.accessToken).catch(err => {
        if (!isCurrent()) throw err
        setOAuthStatus({
          state: 'error',
          message: 'Failed to create API key: ' + err.message,
          toRetry: { state: 'ready_to_start' },
        })

        throw err
      })

      if (!isCurrent()) return
      if (apiKey) {
        setOAuthStatus({ state: 'success', apiKey })
        notify({ message: 'Kode login successful' })
      } else {
        setOAuthStatus({
          state: 'error',
          message:
            "Unable to create API key. The server accepted the request but didn't return a key.",
          toRetry: { state: 'ready_to_start' },
        })
      }
    } catch {
      // Each failing operation above has already populated the retry UI.
    }
  }, [createApiKey, notify, oauthService])

  useEffect(() => {
    if (oauthStatus.state === 'ready_to_start') {
      startOAuth()
    }
  }, [oauthStatus.state, startOAuth])

  return (
    <Box flexDirection="column" gap={1}>
      <Box flexDirection="column" gap={1}>
        <WelcomeBox />
        <Box paddingBottom={1} paddingLeft={1}>
          <Text color={theme.kode}>{ASCII_LOGO}</Text>
        </Box>
      </Box>
      {oauthStatus.state === 'waiting_for_login' && showPastePrompt ? (
        <Box flexDirection="column" gap={1} paddingBottom={1}>
          <Box paddingX={1}>
            <Text dimColor>
              Browser didn&apos;t open? Use the url below to sign in:
            </Text>
          </Box>
          <Box width={1000}>
            <Text dimColor>{oauthStatus.url}</Text>
          </Box>
        </Box>
      ) : null}
      <Box paddingLeft={1} flexDirection="column" gap={1}>
        <ConsoleOAuthStatusMessage
          oauthStatus={oauthStatus}
          theme={theme}
          showPastePrompt={showPastePrompt}
          pastedCode={pastedCode}
          onPastedCodeChange={setPastedCode}
          cursorOffset={cursorOffset}
          onCursorOffsetChange={setCursorOffset}
          textInputColumns={textInputColumns}
          onSubmitCode={handleSubmitCode}
        />
      </Box>
    </Box>
  )
}
