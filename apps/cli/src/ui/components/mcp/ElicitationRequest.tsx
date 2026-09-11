import React, { useCallback, useMemo, useState } from 'react'
import { Box, Text } from 'ink'

import { getTheme } from '#core/utils/theme'
import { KEYPRESS_PRIORITY } from '#ui-ink/constants/keypressPriority'
import { useKeypress } from '#ui-ink/hooks/useKeypress'
import { sanitizeTerminalText } from '#ui-ink/utils/sanitizeTerminalText'
import type { McpElicitationPrompt } from '#cli-services/mcpCapabilities'

type FieldKind =
  'string' | 'number' | 'integer' | 'boolean' | 'enum' | 'multi-enum'

type Field = {
  name: string
  title: string
  description?: string
  kind: FieldKind
  options?: string[]
  /**
   * Server-provided default (JSON Schema `default`). Prefilled in the form:
   * the SDK's `applyElicitationDefaults` only fills *undefined* values, and
   * this form always submits a value, so a default that is not prefilled here
   * would be silently lost.
   */
  defaultValue?: string | number | boolean | string[]
}

type FieldValue = string | number | boolean | string[]

function readEnumOptions(prop: Record<string, unknown>): string[] | null {
  if (Array.isArray(prop.enum)) {
    const values = prop.enum
      .filter((v): v is string => typeof v === 'string')
      .map(v => sanitizeTerminalText(v))
    if (values.length > 0) return values
  }

  // 2025-11-25 titled enums arrive as oneOf/anyOf [{ const, title }].
  for (const key of ['oneOf', 'anyOf'] as const) {
    const branch = prop[key]
    if (!Array.isArray(branch)) continue
    const values: string[] = []
    for (const item of branch) {
      if (!item || typeof item !== 'object') continue
      const value = (item as Record<string, unknown>).const
      if (typeof value === 'string') values.push(sanitizeTerminalText(value))
    }
    if (values.length > 0) return values
  }

  return null
}

function readDefault(prop: Record<string, unknown>): Field['defaultValue'] {
  const value = prop.default
  if (typeof value === 'string' || typeof value === 'number') return value
  if (typeof value === 'boolean') return value
  if (Array.isArray(value)) {
    const items = value.filter((v): v is string => typeof v === 'string')
    return items.length > 0 ? items : undefined
  }
  return undefined
}

function parseFields(schema: unknown): Field[] {
  if (!schema || typeof schema !== 'object') return []
  const properties = (schema as { properties?: unknown }).properties
  if (!properties || typeof properties !== 'object') return []

  const fields: Field[] = []

  for (const [name, raw] of Object.entries(
    properties as Record<string, unknown>,
  )) {
    if (!raw || typeof raw !== 'object') continue
    const prop = raw as Record<string, unknown>

    // Everything below is server-controlled, so it is sanitized before render.
    const title = sanitizeTerminalText(
      typeof prop.title === 'string' ? prop.title : name,
    )
    const description =
      typeof prop.description === 'string'
        ? sanitizeTerminalText(prop.description)
        : undefined

    const defaultValue = readDefault(prop)

    const options = readEnumOptions(prop)
    if (options) {
      fields.push({
        name,
        title,
        description,
        kind: prop.type === 'array' ? 'multi-enum' : 'enum',
        options,
        defaultValue,
      })
      continue
    }

    const type = typeof prop.type === 'string' ? prop.type : 'string'
    if (type === 'boolean') {
      fields.push({ name, title, description, kind: 'boolean', defaultValue })
      continue
    }
    if (type === 'number' || type === 'integer') {
      fields.push({ name, title, description, kind: type, defaultValue })
      continue
    }
    fields.push({ name, title, description, kind: 'string', defaultValue })
  }

  return fields
}

function buildContent(
  fields: Field[],
  text: Record<string, string>,
  toggles: Record<string, boolean>,
): Record<string, FieldValue> {
  const content: Record<string, FieldValue> = {}

  for (const field of fields) {
    switch (field.kind) {
      case 'boolean':
        content[field.name] = toggles[field.name] ?? false
        break
      case 'number':
      case 'integer': {
        const raw = (text[field.name] ?? '').trim()
        const parsed = Number(raw)
        content[field.name] = raw !== '' && Number.isFinite(parsed) ? parsed : 0
        break
      }
      case 'multi-enum': {
        const raw = (text[field.name] ?? '').trim()
        content[field.name] = raw
          ? raw
              .split(',')
              .map(value => value.trim())
              .filter(Boolean)
          : []
        break
      }
      case 'enum':
        content[field.name] = text[field.name] ?? field.options?.[0] ?? ''
        break
      default:
        content[field.name] = text[field.name] ?? ''
    }
  }

  return content
}

/**
 * Renders a server-initiated `elicitation/create` request.
 *
 * Keyboard: Up/Down moves between fields, Left/Right cycles enums and toggles
 * booleans, Enter accepts, Esc declines.
 */
export function ElicitationRequest({
  prompt,
  onDone,
}: {
  prompt: McpElicitationPrompt
  onDone: () => void
}): React.ReactNode {
  const theme = getTheme()

  const params = prompt.request.params as {
    mode?: string
    message?: string
    requestedSchema?: unknown
    url?: string
    elicitationId?: string
  }

  // URL mode: the user completes the interaction out of band (in a browser),
  // so there is no form — only the message and the URL to visit.
  const urlMode =
    (params.mode === 'url' || typeof params.elicitationId === 'string') &&
    typeof params.url === 'string'

  const fields = useMemo(
    () => (urlMode ? [] : parseFields(params.requestedSchema)),
    [params.requestedSchema, urlMode],
  )

  const defaults = useMemo(() => {
    const text: Record<string, string> = {}
    const toggles: Record<string, boolean> = {}
    for (const field of fields) {
      const value = field.defaultValue
      if (value === undefined) continue
      if (field.kind === 'boolean') {
        if (typeof value === 'boolean') toggles[field.name] = value
        continue
      }
      text[field.name] = Array.isArray(value) ? value.join(', ') : String(value)
    }
    return { text, toggles }
  }, [fields])

  const [focusIndex, setFocusIndex] = useState(0)
  const [text, setText] = useState<Record<string, string>>(defaults.text)
  const [cursor, setCursor] = useState<Record<string, number>>({})
  const [toggles, setToggles] = useState<Record<string, boolean>>(
    defaults.toggles,
  )

  const cursorFor = useCallback(
    (name: string): number => {
      const value = text[name] ?? ''
      const stored = cursor[name]
      if (typeof stored !== 'number') return value.length
      return Math.max(0, Math.min(stored, value.length))
    },
    [cursor, text],
  )

  const finish = useCallback(
    (result: 'accept' | 'decline' | 'cancel') => {
      prompt.resolve(
        result === 'accept'
          ? { action: 'accept', content: buildContent(fields, text, toggles) }
          : { action: result },
      )
      onDone()
    },
    [fields, onDone, prompt, text, toggles],
  )

  useKeypress(
    (input, key) => {
      if (key.escape) {
        finish('decline')
        return true
      }

      if (key.return) {
        finish('accept')
        return true
      }

      if (key.upArrow || (key.tab && key.shift)) {
        setFocusIndex(index => Math.max(0, index - 1))
        return true
      }

      if (key.downArrow || key.tab) {
        setFocusIndex(index => Math.min(fields.length - 1, index + 1))
        return true
      }

      const field = fields[focusIndex]
      if (!field) return

      if (field.kind === 'enum') {
        const options = field.options ?? []
        if (options.length === 0) return true
        const current = text[field.name] ?? options[0]
        const currentIndex = Math.max(0, options.indexOf(current))
        if (key.leftArrow) {
          setText(prev => ({
            ...prev,
            [field.name]:
              options[(currentIndex - 1 + options.length) % options.length],
          }))
          return true
        }
        if (key.rightArrow) {
          setText(prev => ({
            ...prev,
            [field.name]: options[(currentIndex + 1) % options.length],
          }))
          return true
        }
        // Swallow stray characters: a select is not a text field.
        return true
      }

      if (field.kind === 'boolean') {
        if (key.leftArrow || key.rightArrow || input === ' ') {
          setToggles(prev => ({
            ...prev,
            [field.name]: !(prev[field.name] ?? false),
          }))
          return true
        }
        return true
      }

      // Text-like fields (string / number / integer / multi-enum): full cursor
      // editing, so a typo does not force the user to retype the whole value.
      const value = text[field.name] ?? ''
      const at = cursorFor(field.name)

      if (key.leftArrow) {
        setCursor(prev => ({ ...prev, [field.name]: Math.max(0, at - 1) }))
        return true
      }

      if (key.rightArrow) {
        setCursor(prev => ({
          ...prev,
          [field.name]: Math.min(value.length, at + 1),
        }))
        return true
      }

      if (key.home) {
        setCursor(prev => ({ ...prev, [field.name]: 0 }))
        return true
      }

      if (key.end) {
        setCursor(prev => ({ ...prev, [field.name]: value.length }))
        return true
      }

      if (key.backspace) {
        if (at === 0) return true
        setText(prev => ({
          ...prev,
          [field.name]: value.slice(0, at - 1) + value.slice(at),
        }))
        setCursor(prev => ({ ...prev, [field.name]: at - 1 }))
        return true
      }

      if (key.delete) {
        if (at >= value.length) return true
        setText(prev => ({
          ...prev,
          [field.name]: value.slice(0, at) + value.slice(at + 1),
        }))
        return true
      }

      // `input` carries the whole pasted block when the terminal reports a paste.
      if ((key.insertable || key.paste) && input) {
        setText(prev => ({
          ...prev,
          [field.name]: value.slice(0, at) + input + value.slice(at),
        }))
        setCursor(prev => ({ ...prev, [field.name]: at + input.length }))
        return true
      }

      // Leave non-typing keys (Ctrl shortcuts, F-keys) to global handlers.
      return
    },
    { priority: KEYPRESS_PRIORITY.MODAL_DIALOG },
  )

  return (
    <Box flexDirection="column" marginTop={1}>
      <Box
        borderTop
        borderColor={theme.secondaryText}
        flexDirection="column"
        paddingTop={1}
      >
        <Text bold>
          {sanitizeTerminalText(prompt.serverName)} (MCP) requests input
        </Text>
        <Box marginTop={1}>
          <Text wrap="wrap">
            {sanitizeTerminalText(params.message, { allowNewlines: true })}
          </Text>
        </Box>

        {urlMode && (
          <Box flexDirection="column" marginTop={1}>
            <Text color={theme.suggestion} wrap="wrap">
              {sanitizeTerminalText(params.url)}
            </Text>
            <Text dimColor>
              Open this URL in your browser, then press Enter. Kode does not
              open it for you.
            </Text>
          </Box>
        )}

        {fields.length > 0 && (
          <Box flexDirection="column" marginTop={1}>
            {fields.map((field, index) => {
              const focused = index === focusIndex
              const marker = focused ? '❯' : ' '
              const isTextLike =
                field.kind === 'string' ||
                field.kind === 'number' ||
                field.kind === 'integer' ||
                field.kind === 'multi-enum'
              const raw =
                field.kind === 'boolean'
                  ? String(toggles[field.name] ?? false)
                  : field.kind === 'enum'
                    ? (text[field.name] ?? field.options?.[0] ?? '')
                    : (text[field.name] ?? '')
              // Draw a caret so cursor editing is visible.
              const display =
                focused && isTextLike
                  ? `${raw.slice(0, cursorFor(field.name))}▏${raw.slice(
                      cursorFor(field.name),
                    )}`
                  : raw

              return (
                <Box key={field.name} flexDirection="column">
                  <Text color={focused ? theme.suggestion : undefined}>
                    {marker} {field.title}
                    {field.kind === 'boolean'
                      ? ` [${display}]`
                      : `: ${display}`}
                    {focused && field.kind === 'enum' ? '  (←/→)' : ''}
                  </Text>
                  {field.description && (
                    <Text dimColor>
                      {'   '}
                      {field.description}
                    </Text>
                  )}
                </Box>
              )
            })}
          </Box>
        )}

        <Box marginTop={1}>
          <Text dimColor>
            {urlMode
              ? 'Enter when done · Esc to decline'
              : 'Type to edit · ←/→ cursor · Tab/↑/↓ field · Enter to submit · Esc to decline'}
          </Text>
        </Box>
      </Box>
    </Box>
  )
}
