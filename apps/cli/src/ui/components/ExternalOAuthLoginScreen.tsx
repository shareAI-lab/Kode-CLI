import * as React from 'react'
import { Box, Text } from 'ink'
import figures from 'figures'

import { useExitOnCtrlCD } from '#ui-ink/hooks/useExitOnCtrlCD'
import { useKeypress } from '#ui-ink/hooks/useKeypress'
import { ScreenFrame } from '#ui-ink/primitives/layout/ScreenFrame'
import { getTheme } from '#core/utils/theme'
import {
  saveExternalRuntimeModelProfile,
  type ExternalRuntimeModel,
  type ExternalRuntimeProvider,
} from '#cli-services/externalModelProfile'

type OAuthStatus =
  | { kind: 'authenticated'; login?: string }
  | { kind: 'unauthenticated' }
  | { kind: 'unavailable' }

export type ExternalOAuthAuthService = {
  getStatus(): Promise<OAuthStatus>
  startLogin(): Promise<void>
  getAvailableModels?: () => Promise<
    Array<{
      model: string
      displayName: string
      reasoningEffort?: string
    }>
  >
  getRecommendedSettings?: () => Promise<{
    model: string
    displayName: string
    reasoningEffort?: string
  }>
}

type Props = {
  provider: ExternalRuntimeProvider
  title: string
  authService: ExternalOAuthAuthService
  onDone: () => void
  onCancel: () => void
  pollIntervalMs?: number
  saveProfile?: (
    model: ExternalRuntimeModel,
    activateAsMain: boolean,
  ) => Promise<string>
}

type State =
  | 'checking'
  | 'ready'
  | 'waiting'
  | 'loading-models'
  | 'model-selection'
  | 'switch-confirmation'
  | 'saving'
  | 'complete'
  | 'error'

const LOGIN_TIMEOUT_MS = 5 * 60 * 1_000
const DEFAULT_POLL_INTERVAL_MS = 1_500

function statusText(status: OAuthStatus | null): string {
  if (!status) return 'Checking the installed official runtime…'
  if (status.kind === 'authenticated') {
    return status.login
      ? `Already signed in as ${status.login}.`
      : 'Already signed in.'
  }
  if (status.kind === 'unauthenticated') return 'Not signed in yet.'
  return 'The official runtime is unavailable on this machine.'
}

export function ExternalOAuthLoginScreen({
  provider,
  title,
  authService,
  onDone,
  onCancel,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  saveProfile = saveExternalRuntimeModelProfile,
}: Props): React.ReactNode {
  const theme = getTheme()
  const exitState = useExitOnCtrlCD(onCancel)
  const [state, setState] = React.useState<State>('checking')
  const [status, setStatus] = React.useState<OAuthStatus | null>(null)
  const [models, setModels] = React.useState<ExternalRuntimeModel[]>([])
  const [selectedIndex, setSelectedIndex] = React.useState(0)
  const [activateAsMain, setActivateAsMain] = React.useState(true)
  const [error, setError] = React.useState<string | null>(null)
  const runId = React.useRef(0)

  const refreshStatus = React.useCallback(async () => {
    try {
      const next = await authService.getStatus()
      setStatus(next)
      return next
    } catch {
      const unavailable: OAuthStatus = { kind: 'unavailable' }
      setStatus(unavailable)
      return unavailable
    }
  }, [authService])

  const loadModels = React.useCallback(async () => {
    const id = ++runId.current
    setState('loading-models')
    setError(null)
    try {
      const listed = authService.getAvailableModels
        ? await authService.getAvailableModels()
        : authService.getRecommendedSettings
          ? [await authService.getRecommendedSettings()]
          : []
      const unique = new Set<string>()
      const mapped = listed.flatMap(model => {
        if (!model.model || unique.has(model.model)) return []
        unique.add(model.model)
        return [
          {
            provider,
            model: model.model,
            displayName: model.displayName || model.model,
            reasoningEffort: model.reasoningEffort,
            ...(status?.kind === 'authenticated' && status.login
              ? { accountLabel: status.login }
              : {}),
          },
        ]
      })
      if (id !== runId.current) return
      if (mapped.length === 0)
        throw new Error('No usable models were returned.')
      setModels(mapped)
      setSelectedIndex(0)
      setState('model-selection')
    } catch (cause) {
      if (id !== runId.current) return
      setError(
        cause instanceof Error ? cause.message : 'Could not load models.',
      )
      setState('error')
    }
  }, [authService, provider, status])

  React.useEffect(() => {
    let cancelled = false
    void refreshStatus().then(next => {
      if (!cancelled) setState(next.kind === 'unavailable' ? 'error' : 'ready')
    })
    return () => {
      cancelled = true
    }
  }, [refreshStatus])

  React.useEffect(() => {
    if (state !== 'waiting') return undefined
    let cancelled = false
    const startedAt = Date.now()
    const poll = () => {
      void refreshStatus().then(next => {
        if (cancelled) return
        if (next.kind === 'authenticated') {
          void loadModels()
        } else if (next.kind === 'unavailable') {
          setError(
            'The official runtime could not be reached while signing in.',
          )
          setState('error')
        } else if (Date.now() - startedAt >= LOGIN_TIMEOUT_MS) {
          setError('Timed out waiting for the OAuth sign-in to finish.')
          setState('error')
        }
      })
    }
    poll()
    const interval = setInterval(poll, Math.max(50, pollIntervalMs))
    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [loadModels, pollIntervalMs, refreshStatus, state])

  const begin = React.useCallback(async () => {
    if (status?.kind === 'authenticated') {
      await loadModels()
      return
    }
    if (status?.kind === 'unavailable') {
      setError('Install or repair the official runtime, then try again.')
      setState('error')
      return
    }
    setError(null)
    setState('waiting')
    try {
      await authService.startLogin()
    } catch {
      setError('Could not start the official OAuth sign-in.')
      setState('error')
    }
  }, [authService, loadModels, status])

  const save = React.useCallback(async () => {
    const selected = models[selectedIndex]
    if (!selected) return
    setState('saving')
    setError(null)
    try {
      await saveProfile(selected, activateAsMain)
      setState('complete')
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'Could not save the Kode model profile.',
      )
      setState('error')
    }
  }, [activateAsMain, models, saveProfile, selectedIndex])

  useKeypress((input, key) => {
    const inputChar = input.length === 1 ? input.toLowerCase() : ''
    const isUp = key.upArrow || inputChar === 'k'
    const isDown = key.downArrow || inputChar === 'j'

    if (
      state === 'checking' ||
      state === 'loading-models' ||
      state === 'saving'
    ) {
      return true
    }
    if (state === 'ready') {
      if (key.escape) return (onCancel(), true)
      if (key.return) void begin()
      return true
    }
    if (state === 'waiting') {
      if (key.escape) {
        runId.current += 1
        setState('ready')
      }
      return true
    }
    if (state === 'model-selection') {
      if (key.escape) return (onCancel(), true)
      if (isUp)
        setSelectedIndex(current =>
          current === 0 ? models.length - 1 : current - 1,
        )
      if (isDown) setSelectedIndex(current => (current + 1) % models.length)
      if (key.return) {
        setActivateAsMain(true)
        setState('switch-confirmation')
      }
      return true
    }
    if (state === 'switch-confirmation') {
      if (key.escape) {
        setState('model-selection')
        return true
      }
      if (isUp || isDown) setActivateAsMain(current => !current)
      if (key.return) void save()
      return true
    }
    if (state === 'complete') {
      if (key.return || key.escape) onDone()
      return true
    }
    if (state === 'error') {
      if (key.escape) return (onCancel(), true)
      if (key.return) {
        setError(null)
        setState('ready')
      }
      return true
    }
    return undefined
  })

  const selected = models[selectedIndex]
  return (
    <ScreenFrame title={title} paddingX={2} paddingY={1} gap={1}>
      <Box flexDirection="column" gap={1}>
        {state === 'checking' || state === 'ready' ? (
          <>
            <Text bold>{title}</Text>
            <Text color={theme.secondaryText}>{statusText(status)}</Text>
            <Text dimColor>
              The official runtime keeps OAuth tokens. Kode saves a protected
              credential binding, model profile, and your switch choice.
            </Text>
            <Text color={theme.secondaryText}>Enter continue · Esc back</Text>
          </>
        ) : null}

        {state === 'waiting' ? (
          <>
            <Text color={theme.suggestion}>
              OAuth sign-in has started. Finish it in the browser or device-flow
              window; this screen will continue automatically.
            </Text>
            <Text dimColor>Esc returns to login choices</Text>
          </>
        ) : null}

        {state === 'loading-models' ? (
          <Text color={theme.suggestion}>
            Loading models available to this account…
          </Text>
        ) : null}

        {state === 'model-selection' ? (
          <>
            <Text bold>Choose a model to save in Kode:</Text>
            <Box flexDirection="column">
              {models.map((model, index) => (
                <Text
                  key={model.model}
                  color={
                    index === selectedIndex ? theme.text : theme.secondaryText
                  }
                  bold={index === selectedIndex}
                >
                  {index === selectedIndex ? figures.pointer : ' '}{' '}
                  {model.displayName} ({model.model})
                  {model.reasoningEffort ? ` · ${model.reasoningEffort}` : ''}
                </Text>
              ))}
            </Box>
            <Text dimColor>↑/↓ or j/k choose · Enter continue · Esc back</Text>
          </>
        ) : null}

        {state === 'switch-confirmation' && selected ? (
          <>
            <Text bold>
              Use {selected.displayName} as Kode’s main model now?
            </Text>
            <Box flexDirection="column">
              <Text
                color={activateAsMain ? theme.text : theme.secondaryText}
                bold={activateAsMain}
              >
                {activateAsMain ? figures.pointer : ' '} Switch Kode to this
                model now
              </Text>
              <Text
                color={!activateAsMain ? theme.text : theme.secondaryText}
                bold={!activateAsMain}
              >
                {!activateAsMain ? figures.pointer : ' '} Save it, keep Kode’s
                current model
              </Text>
            </Box>
            <Text dimColor>
              The choice is persisted in Kode’s model pointers and takes effect
              on the next request.
            </Text>
            <Text dimColor>↑/↓ or j/k choose · Enter save · Esc back</Text>
          </>
        ) : null}

        {state === 'saving' ? (
          <Text color={theme.suggestion}>
            Saving Kode model profile and switch choice…
          </Text>
        ) : null}

        {state === 'complete' && selected ? (
          <>
            <Text color={theme.success}>
              {activateAsMain
                ? `${selected.displayName} is now Kode’s persisted main model.`
                : `${selected.displayName} was saved; Kode’s current main model was kept.`}
            </Text>
            <Text dimColor>
              Press Enter to continue. OAuth tokens remain with the official
              runtime; Kode has saved their protected binding.
            </Text>
          </>
        ) : null}

        {state === 'error' ? (
          <>
            <Text color={theme.error}>
              {error || 'The OAuth setup could not continue.'}
            </Text>
            <Text dimColor>Enter returns to this provider · Esc back</Text>
          </>
        ) : null}

        {exitState.pending ? (
          <Text dimColor>Press {exitState.keyName} again to exit</Text>
        ) : null}
      </Box>
    </ScreenFrame>
  )
}
