import React, { useCallback, useEffect, useRef, useState } from 'react'
import { Box, Text } from 'ink'

import {
  createMiMoVoiceProvider,
  VoiceConfigurationError,
  VoiceProviderError,
} from '@kode/ai'
import {
  startMacOSVoiceRecording,
  type ActiveVoiceRecording,
} from '@kode/runtime'
import {
  getGlobalConfig,
  readVoiceApiKey,
  resolveVoiceConfig,
  type VoiceConfig,
} from '#core/utils/config'
import { getTheme } from '#core/utils/theme'
import { interruptVoicePlayback } from '#cli-services/voice'
import type { LocalJSXCommandResult } from '#cli-commands/types'
import TextInput from '#ui-ink/components/TextInput'
import { KEYPRESS_PRIORITY } from '#ui-ink/constants/keypressPriority'
import { useKeypress } from '#ui-ink/hooks/useKeypress'
import { ScreenFrame } from '#ui-ink/primitives/layout/ScreenFrame'
import { useScreenLayout } from '#ui-ink/primitives/layout/useScreenLayout'
import { useTerminalSize } from '#ui-ink/hooks/useTerminalSize'
import { VoiceSettingsScreen } from './VoiceSettingsScreen'

type VoiceScreenState =
  | { kind: 'ready' }
  | { kind: 'preparing' }
  | { kind: 'recording' }
  | { kind: 'transcribing' }
  | { kind: 'review'; error?: string }
  | { kind: 'submitting' }
  | { kind: 'error'; message: string; recovery: 'retry' | 'configure' }

type VoiceScreenMode = 'conversation' | 'settings'

export class VoiceSubmissionError extends Error {
  override name = 'VoiceSubmissionError'
}

export type VoiceTranscriptSubmission = {
  destination: string
  submit(transcript: string): Promise<string> | string
}

export function getSafeVoiceErrorMessage(error: unknown): string {
  if (error instanceof VoiceConfigurationError) return error.message
  if (error instanceof VoiceProviderError) return error.message
  if (error instanceof Error && error.name === 'VoiceRuntimeError')
    return error.message
  return 'Voice could not complete. Check your network, MiMo configuration, and microphone permission.'
}

/**
 * Whether Esc/Ctrl+C may close the whole screen in the given state. A send
 * that is already in flight cannot be aborted (`submission.submit` has no
 * cancellation signal), so closing during `submitting` would strand the
 * transcript in its destination while telling the user it was cancelled.
 * Transcription, by contrast, is abortable and is handled separately.
 */
export function __canCloseVoiceScreenOnEscapeForTests(
  stateKind: VoiceScreenState['kind'],
): boolean {
  return stateKind !== 'submitting'
}

export function VoiceScreen({
  onDone,
  submission,
}: {
  onDone: (result?: LocalJSXCommandResult) => void
  submission?: VoiceTranscriptSubmission
}): React.ReactNode {
  const theme = getTheme()
  const layout = useScreenLayout()
  const { columns } = useTerminalSize()
  const [state, setState] = useState<VoiceScreenState>({ kind: 'ready' })
  const [mode, setMode] = useState<VoiceScreenMode>('conversation')
  const [transcript, setTranscript] = useState('')
  const [cursorOffset, setCursorOffset] = useState(0)
  const transcriptRef = useRef('')
  const appendNextRecordingRef = useRef(false)
  const recordingRef = useRef<ActiveVoiceRecording | null>(null)
  const requestRef = useRef<AbortController | null>(null)
  const configRef = useRef<VoiceConfig | null>(null)
  const closedRef = useRef(false)

  const close = useCallback(() => {
    closedRef.current = true
    requestRef.current?.abort()
    void recordingRef.current?.cancel()
    recordingRef.current = null
    onDone()
  }, [onDone])

  useEffect(
    () => () => {
      closedRef.current = true
      requestRef.current?.abort()
      void recordingRef.current?.cancel()
    },
    [],
  )

  const startRecording = useCallback(async (appendTranscript = false) => {
    interruptVoicePlayback()
    appendNextRecordingRef.current = appendTranscript
    const resolved = resolveVoiceConfig(getGlobalConfig().voice)
    if (!resolved.ok) {
      setState({
        kind: 'error',
        message: resolved.message,
        recovery: 'configure',
      })
      return
    }
    if (!readVoiceApiKey(resolved.config)?.trim()) {
      setState({
        kind: 'error',
        message: `No MiMo credential was found. Set ${resolved.config.apiKeyEnv} in the environment, or press Enter to paste a key securely in Voice settings. It is never stored in regular Kode configuration.`,
        recovery: 'configure',
      })
      return
    }
    setState({ kind: 'preparing' })
    try {
      const recording = await startMacOSVoiceRecording({
        maxRecordingSeconds: resolved.config.maxRecordingSeconds,
      })
      if (closedRef.current) {
        await recording.cancel()
        return
      }
      configRef.current = resolved.config
      recordingRef.current = recording
      setState({ kind: 'recording' })
    } catch (error) {
      if (!closedRef.current)
        setState({
          kind: 'error',
          message: getSafeVoiceErrorMessage(error),
          recovery: 'retry',
        })
    }
  }, [])

  const stopRecording = useCallback(async () => {
    const recording = recordingRef.current
    const config = configRef.current
    if (!recording || !config) return
    recordingRef.current = null
    setState({ kind: 'transcribing' })
    const prefix = appendNextRecordingRef.current
      ? transcriptRef.current.trim()
      : ''
    setTranscript(prefix)
    setCursorOffset(prefix.length)
    const controller = new AbortController()
    requestRef.current = controller
    try {
      const audio = await recording.stop()
      let result = ''
      for await (const delta of createMiMoVoiceProvider(
        config,
      ).transcribeStream(audio, controller.signal)) {
        if (controller.signal.aborted || closedRef.current) return
        result += delta
        const combined = prefix ? `${prefix}\n${result}` : result
        transcriptRef.current = combined
        setTranscript(combined)
        setCursorOffset(combined.length)
      }
      if (closedRef.current || controller.signal.aborted) return
      const combined = prefix ? `${prefix}\n${result}` : result
      transcriptRef.current = combined
      appendNextRecordingRef.current = false
      setTranscript(combined)
      setCursorOffset(combined.length)
      setState({ kind: 'review' })
    } catch (error) {
      if (!closedRef.current && !controller.signal.aborted) {
        setState({
          kind: 'error',
          message: getSafeVoiceErrorMessage(error),
          recovery: 'retry',
        })
      }
    } finally {
      if (requestRef.current === controller) requestRef.current = null
    }
  }, [])

  const submitTranscript = useCallback(
    async (value: string) => {
      const prompt = value.trim()
      if (!prompt) {
        setState({
          kind: 'error',
          message:
            'The transcript is empty. Record again or edit it before sending.',
          recovery: 'retry',
        })
        return
      }
      if (!submission) {
        if (closedRef.current) return
        closedRef.current = true
        onDone({
          type: 'submit-prompt',
          prompt,
          voiceInput: true,
          voiceResponse: configRef.current?.speakResponses === true,
        })
        return
      }
      setState({ kind: 'submitting' })
      try {
        const result = await submission.submit(prompt)
        if (!closedRef.current) {
          closedRef.current = true
          onDone(result)
        }
      } catch (error) {
        if (closedRef.current) return
        setState({
          kind: 'review',
          error:
            error instanceof VoiceSubmissionError
              ? error.message
              : `Could not send the reviewed transcript to ${submission.destination}.`,
        })
      }
    },
    [onDone, submission],
  )

  useKeypress(
    (input, key) => {
      if (key.escape || (key.ctrl && input === 'c')) {
        if (state.kind === 'transcribing') {
          requestRef.current?.abort()
          setState({ kind: 'ready' })
          return true
        }
        if (!__canCloseVoiceScreenOnEscapeForTests(state.kind)) {
          // The send cannot be cancelled; keep the screen open so the result
          // is reported instead of silently discarding the in-flight submit.
          return true
        }
        close()
        return true
      }
      if (state.kind === 'review' && key.ctrl && input === 'r') {
        void startRecording(true)
        return true
      }
      // From any error state, 's' jumps straight into Voice settings so the
      // user can fix the network/credential/microphone configuration.
      if ((input === 's' || input === 'S') && state.kind === 'error') {
        setMode('settings')
        return true
      }
      const isRecordingToggle = key.return || key.name === 'f10'
      if (!isRecordingToggle) return undefined
      if (state.kind === 'error' && state.recovery === 'configure') {
        setMode('settings')
        return true
      }
      if (state.kind === 'ready' || state.kind === 'error') {
        void startRecording()
        return true
      }
      if (state.kind === 'recording') {
        void stopRecording()
        return true
      }
      return undefined
    },
    {
      isActive: mode === 'conversation',
      priority: KEYPRESS_PRIORITY.FULLSCREEN_OVERLAY,
    },
  )

  const stateLine =
    state.kind === 'ready'
      ? 'Press Enter or F10 to begin recording.'
      : state.kind === 'preparing'
        ? 'Preparing the macOS microphone recorder…'
        : state.kind === 'recording'
          ? `Recording. Press Enter or F10 to stop (maximum ${configRef.current?.maxRecordingSeconds ?? '?'} seconds).`
          : state.kind === 'transcribing'
            ? 'Transcribing securely with MiMo…'
            : state.kind === 'review'
              ? `Review the transcript, then press Enter to send it to ${submission?.destination ?? 'the normal agent'}.`
              : state.kind === 'submitting'
                ? `Sending reviewed transcript to ${submission?.destination ?? 'the normal agent'}…`
                : state.recovery === 'configure'
                  ? 'Press Enter to open Voice settings, or Esc to close.'
                  : 'Press Enter to try again, or Esc to close.'
  const controlsLine =
    state.kind === 'review'
      ? 'Ctrl+R records another segment and appends it · Esc/Ctrl+C close'
      : state.kind === 'recording'
        ? 'Enter/F10 stops recording · Esc/Ctrl+C cancels and closes'
        : state.kind === 'transcribing'
          ? 'Esc/Ctrl+C cancels transcription and closes'
          : state.kind === 'error' && state.recovery === 'configure'
            ? 'Enter opens settings · paste the key and press Enter to continue · Esc/Ctrl+C closes'
            : state.kind === 'error'
              ? 'Enter tries again · s opens settings · Esc/Ctrl+C closes'
              : state.kind === 'ready'
                ? 'Enter/F10 starts recording · Esc/Ctrl+C closes'
                : state.kind === 'submitting'
                  ? 'Sending… please wait — the send cannot be cancelled once started'
                  : 'Esc/Ctrl+C cancels and closes'

  if (mode === 'settings') {
    return (
      <VoiceSettingsScreen
        requireCredential
        onDone={close}
        onSaved={() => {
          if (closedRef.current) return
          setMode('conversation')
          setState({ kind: 'ready' })
          void startRecording()
        }}
      />
    )
  }

  return (
    <ScreenFrame
      title="Voice conversation"
      paddingX={layout.paddingX}
      paddingY={layout.paddingY}
      gap={layout.gap}
    >
      <Box flexDirection="column" gap={layout.gap}>
        <Text dimColor wrap="truncate-end">
          {stateLine}
        </Text>
        {state.kind === 'recording' ? (
          <Text color={theme.warning} bold>
            ● Listening
          </Text>
        ) : null}
        {state.kind === 'review' ? (
          <Box flexDirection="column">
            <Text dimColor>Transcript:</Text>
            <TextInput
              value={transcript}
              onChange={value => {
                transcriptRef.current = value
                setTranscript(value)
                setCursorOffset(value.length)
              }}
              onSubmit={submitTranscript}
              columns={Math.max(1, columns - layout.paddingX * 2 - 2)}
              cursorOffset={cursorOffset}
              onChangeCursorOffset={setCursorOffset}
              multiline={true}
              focus={true}
            />
          </Box>
        ) : null}
        {state.kind === 'transcribing' && transcript ? (
          <Box flexDirection="column">
            <Text dimColor>Live transcript:</Text>
            <Text wrap="wrap">{transcript}</Text>
          </Box>
        ) : null}
        {state.kind === 'error' ? (
          <Text color={theme.error}>{state.message}</Text>
        ) : null}
        {state.kind === 'review' && state.error ? (
          <Text color={theme.error}>{state.error}</Text>
        ) : null}
        <Text dimColor wrap="truncate-end">
          {controlsLine}
        </Text>
      </Box>
    </ScreenFrame>
  )
}
