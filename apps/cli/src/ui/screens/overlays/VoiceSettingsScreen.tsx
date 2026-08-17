import React, { useCallback, useState } from 'react'
import { Box, Text } from 'ink'
import figures from 'figures'

import {
  DEFAULT_VOICE_CONFIG,
  getGlobalConfig,
  getVoiceCredentialStatus,
  resolveVoiceConfig,
  saveGlobalConfig,
  storeVoiceApiKey,
  type VoiceConfig,
} from '#core/utils/config'
import type { LocalJSXCommandResult } from '#cli-commands/types'
import TextInput from '#ui-ink/components/TextInput'
import { KEYPRESS_PRIORITY } from '#ui-ink/constants/keypressPriority'
import { useKeypress } from '#ui-ink/hooks/useKeypress'
import { useTerminalSize } from '#ui-ink/hooks/useTerminalSize'
import { ScreenFrame } from '#ui-ink/primitives/layout/ScreenFrame'
import { useScreenLayout } from '#ui-ink/primitives/layout/useScreenLayout'
import { getTheme } from '#core/utils/theme'

type EditableField =
  | 'baseURL'
  | 'apiKeyEnv'
  | 'asrModel'
  | 'ttsModel'
  | 'ttsVoice'
  | 'language'
  | 'speakResponses'
  | 'maxRecordingSeconds'
  | 'maxReplyCharacters'

type VoiceSettingsField = EditableField | 'apiKey'

const FIELDS: Array<{
  key: VoiceSettingsField
  label: string
  hint: string
  editable: boolean
}> = [
  {
    key: 'apiKey',
    label: 'MiMo API key',
    hint: 'Paste and press Enter to save it immediately. It is masked, owner-only, and never saved in regular configuration.',
    editable: true,
  },
  {
    key: 'apiKeyEnv',
    label: 'API key environment',
    hint: 'Optional environment-variable override. Its value takes precedence over the saved local credential.',
    editable: true,
  },
  {
    key: 'baseURL',
    label: 'MiMo API base URL',
    hint: 'HTTPS, or loopback for development.',
    editable: true,
  },
  {
    key: 'asrModel',
    label: 'ASR model',
    hint: 'Built-in default: mimo-v2.5-asr.',
    editable: true,
  },
  {
    key: 'ttsModel',
    label: 'TTS model',
    hint: 'Built-in default: mimo-v2.5-tts.',
    editable: true,
  },
  {
    key: 'ttsVoice',
    label: 'TTS voice',
    hint: 'For example: mimo_default, default_zh, default_en.',
    editable: true,
  },
  {
    key: 'language',
    label: 'Recognition language',
    hint: 'Cycles auto → zh → en.',
    editable: false,
  },
  {
    key: 'speakResponses',
    label: 'Read replies aloud',
    hint: 'Toggles best-effort TTS after a completed answer.',
    editable: false,
  },
  {
    key: 'maxRecordingSeconds',
    label: 'Recording limit',
    hint: '1–180 seconds; 120 is the safe default.',
    editable: true,
  },
  {
    key: 'maxReplyCharacters',
    label: 'Reply speech limit',
    hint: '1–4000 characters; code is never spoken.',
    editable: true,
  },
]

function displayValue(config: VoiceConfig, key: VoiceSettingsField): string {
  if (key === 'apiKey') {
    const status = getVoiceCredentialStatus(config)
    return status === 'environment'
      ? `environment ${config.apiKeyEnv}`
      : status === 'kode-storage'
        ? 'saved in Kode credential storage'
        : 'not configured'
  }
  if (key === 'speakResponses')
    return config.speakResponses ? 'enabled' : 'disabled'
  return String(config[key])
}

function cycleLanguage(
  language: VoiceConfig['language'],
): VoiceConfig['language'] {
  return language === 'auto' ? 'zh' : language === 'zh' ? 'en' : 'auto'
}

export function VoiceSettingsScreen({
  onDone,
  onSaved,
  requireCredential = false,
}: {
  onDone: (result?: LocalJSXCommandResult) => void
  onSaved?: () => void
  requireCredential?: boolean
}): React.ReactNode {
  const theme = getTheme()
  const layout = useScreenLayout()
  const { columns } = useTerminalSize()
  const current = resolveVoiceConfig(getGlobalConfig().voice)
  const [config, setConfig] = useState<VoiceConfig>(
    current.ok ? current.config : DEFAULT_VOICE_CONFIG,
  )
  const [selected, setSelected] = useState(0)
  const [editing, setEditing] = useState<VoiceSettingsField | null>(null)
  const [editValue, setEditValue] = useState('')
  const [cursorOffset, setCursorOffset] = useState(0)
  const [error, setError] = useState<string | null>(
    current.ok ? null : current.message,
  )

  const update = useCallback((patch: Partial<VoiceConfig>) => {
    setConfig(previous => ({ ...previous, ...patch }))
    setError(null)
  }, [])

  const beginEdit = useCallback(() => {
    const field = FIELDS[selected]
    if (!field) return
    if (field.key === 'apiKey') {
      setEditing('apiKey')
      setEditValue('')
      setCursorOffset(0)
      return
    }
    if (field.key === 'language') {
      update({ language: cycleLanguage(config.language) })
      return
    }
    if (field.key === 'speakResponses') {
      update({ speakResponses: !config.speakResponses })
      return
    }
    setEditing(field.key)
    const next = displayValue(config, field.key)
    setEditValue(next)
    setCursorOffset(next.length)
  }, [config, selected, update])

  const commitEdit = useCallback(
    (value: string) => {
      if (!editing) return
      const trimmed = value.trim()
      if (!trimmed) {
        setError(
          editing === 'apiKey'
            ? 'A MiMo API key is required.'
            : `${editing} cannot be empty.`,
        )
        return
      }
      if (editing === 'apiKey') {
        const validated = resolveVoiceConfig(config)
        if (!validated.ok) {
          setError(validated.message)
          return
        }
        try {
          storeVoiceApiKey(validated.config, trimmed)
          if (requireCredential && onSaved) {
            saveGlobalConfig({
              ...getGlobalConfig(),
              voice: validated.config,
            })
            onSaved()
            return
          }
        } catch {
          setError(
            'Kode could not save the MiMo credential safely. Check the permissions of the Kode data directory and retry.',
          )
          return
        }
        setEditValue('')
        setCursorOffset(0)
        setEditing(null)
        setError(null)
        return
      }
      if (
        editing === 'maxRecordingSeconds' ||
        editing === 'maxReplyCharacters'
      ) {
        if (!/^\d+$/u.test(trimmed)) {
          setError(`${editing} must be a whole number.`)
          return
        }
        update({ [editing]: Number(trimmed) })
      } else {
        update({ [editing]: trimmed })
      }
      setEditing(null)
    },
    [config, editing, onSaved, requireCredential, update],
  )

  const save = useCallback(() => {
    const validated = resolveVoiceConfig(config)
    if (!validated.ok) {
      setError(validated.message)
      return
    }
    if (
      requireCredential &&
      getVoiceCredentialStatus(validated.config) === 'missing'
    ) {
      setSelected(0)
      setError(
        'Paste a MiMo API key before continuing, or close Voice and configure the named environment variable.',
      )
      return
    }
    saveGlobalConfig({ ...getGlobalConfig(), voice: validated.config })
    if (onSaved) {
      onSaved()
      return
    }
    onDone(
      `Voice settings saved. MiMo credential: ${displayValue(validated.config, 'apiKey')}.`,
    )
  }, [config, onDone, onSaved, requireCredential])

  useKeypress(
    (input, key) => {
      if (editing) {
        if (key.escape) {
          setEditing(null)
          return true
        }
        if (key.ctrl && input === 's') {
          commitEdit(editValue)
          return true
        }
        return undefined
      }
      if (key.escape || (key.ctrl && input === 'c')) {
        onDone()
        return true
      }
      if (key.ctrl && input === 's') {
        save()
        return true
      }
      if (key.upArrow || input === 'k') {
        setSelected(index => Math.max(0, index - 1))
        return true
      }
      if (key.downArrow || input === 'j') {
        setSelected(index => Math.min(FIELDS.length - 1, index + 1))
        return true
      }
      if (key.return) {
        beginEdit()
        return true
      }
      return undefined
    },
    { priority: KEYPRESS_PRIORITY.FULLSCREEN_OVERLAY },
  )

  const selectedField = FIELDS[selected]
  return (
    <ScreenFrame
      title="Voice settings"
      paddingX={layout.paddingX}
      paddingY={layout.paddingY}
      gap={layout.gap}
    >
      <Box flexDirection="column" gap={layout.gap}>
        <Text dimColor wrap="truncate-end">
          ↑/↓ select · Enter edit/toggle · Ctrl+S save · Esc close
        </Text>
        {FIELDS.map((field, index) => {
          const isSelected = index === selected
          return (
            <Text
              key={field.key}
              color={isSelected ? theme.text : theme.secondaryText}
              bold={isSelected}
              wrap="truncate-end"
            >
              {isSelected ? figures.pointer : ' '} {field.label}:{' '}
              {displayValue(config, field.key)}
            </Text>
          )
        })}
        {editing && selectedField ? (
          <Box flexDirection="column">
            <Text dimColor>{selectedField.hint}</Text>
            <TextInput
              value={editValue}
              onChange={value => {
                setEditValue(value)
                setCursorOffset(value.length)
              }}
              onSubmit={commitEdit}
              columns={Math.max(1, columns - layout.paddingX * 2 - 2)}
              cursorOffset={cursorOffset}
              onChangeCursorOffset={setCursorOffset}
              mask={editing === 'apiKey' ? '•' : undefined}
              focus={true}
            />
          </Box>
        ) : selectedField ? (
          <Text dimColor wrap="truncate-end">
            {selectedField.hint}
          </Text>
        ) : null}
        {error ? <Text color={theme.error}>{error}</Text> : null}
      </Box>
    </ScreenFrame>
  )
}
