import { Box, Text } from 'ink'
import React, { useMemo } from 'react'
import chalk from 'chalk'
import { Select } from '#ui-ink/components/CustomSelect/select'
import { savePermission } from '#core/permissions'
import { getTheme } from '#core/utils/theme'
import { type PermissionRequestProps } from '#ui-ink/components/permissions/PermissionRequest'
import {
  UnaryEvent,
  usePermissionRequestLogging,
} from '#ui-ink/hooks/usePermissionRequestLogging'
import { logUnaryEvent } from '#core/utils/unaryLogging'
import { env } from '#core/utils/env'
import { useKeypress } from '#ui-ink/hooks/useKeypress'
import { ScreenFrame } from '#ui-ink/primitives/layout/ScreenFrame'
import { useScreenLayout } from '#ui-ink/primitives/layout/useScreenLayout'
import { PermissionRequestDetails } from '#ui-ink/components/permissions/PermissionRequestDetails'
import {
  defaultPermissionFocusValue,
  permissionSelectFocusScope,
} from '#ui-ink/components/permissions/permissionFocusScope'

function hostnameForUrl(url: unknown): string | null {
  if (typeof url !== 'string') return null
  try {
    return new URL(url).hostname
  } catch {
    return null
  }
}

export function WebFetchPermissionRequest({
  toolUseConfirm,
  onDone,
  verbose,
}: PermissionRequestProps): React.ReactNode {
  const theme = getTheme()
  const layout = useScreenLayout()
  const unaryEvent = useMemo<UnaryEvent>(
    () => ({ completion_type: 'tool_use_single', language_name: 'none' }),
    [],
  )

  usePermissionRequestLogging(toolUseConfirm, unaryEvent)

  const hostname = hostnameForUrl(toolUseConfirm.input.url)
  const hostLabel =
    hostname ??
    (typeof toolUseConfirm.input.url === 'string'
      ? toolUseConfirm.input.url
      : 'unknown')

  const reject = () => {
    logUnaryEvent({
      completion_type: 'tool_use_single',
      event: 'reject',
      metadata: {
        language_name: 'none',
        message_id: toolUseConfirm.assistantMessage.message.id,
        platform: env.platform,
      },
    })
    toolUseConfirm.onReject()
    onDone()
  }

  useKeypress((_input, key) => {
    if (key.escape) {
      reject()
      return true
    }
    return undefined
  })

  return (
    <Box marginTop={1} width="100%">
      <ScreenFrame
        title="Network permission"
        titleColor={theme.permission}
        paddingX={layout.paddingX}
        paddingY={layout.tightLayout ? 0 : layout.paddingY}
        gap={layout.gap}
      >
        <Box flexDirection="column" gap={layout.gap}>
          <Box>
            <Text dimColor>Host:</Text>
            <Text wrap="truncate-end"> {hostLabel}</Text>
          </Box>
          <PermissionRequestDetails toolUseConfirm={toolUseConfirm} />

          <Box flexDirection="column">
            <Text>Do you want to allow this connection?</Text>
            <Select
              focusScope={permissionSelectFocusScope(toolUseConfirm, 'choice')}
              focusValue={defaultPermissionFocusValue(toolUseConfirm.riskScore)}
              options={[
                { label: 'Allow once', value: 'yes' },
                ...(hostname
                  ? [
                      {
                        label: `Always allow ${chalk.bold(hostname)}`,
                        value: 'yes-dont-ask-again',
                      },
                    ]
                  : []),
                {
                  label: `Deny and provide instructions ${chalk.bold('(esc)')}`,
                  value: 'no',
                },
              ]}
              onChange={newValue => {
                switch (newValue) {
                  case 'yes':
                    logUnaryEvent({
                      completion_type: 'tool_use_single',
                      event: 'accept',
                      metadata: {
                        language_name: 'none',
                        message_id: toolUseConfirm.assistantMessage.message.id,
                        platform: env.platform,
                      },
                    })
                    toolUseConfirm.onAllow('temporary')
                    onDone()
                    break
                  case 'yes-dont-ask-again':
                    logUnaryEvent({
                      completion_type: 'tool_use_single',
                      event: 'accept',
                      metadata: {
                        language_name: 'none',
                        message_id: toolUseConfirm.assistantMessage.message.id,
                        platform: env.platform,
                      },
                    })
                    savePermission(
                      toolUseConfirm.tool,
                      toolUseConfirm.input,
                      null,
                      toolUseConfirm.toolUseContext,
                    ).then(() => {
                      toolUseConfirm.onAllow('permanent')
                      onDone()
                    })
                    break
                  case 'no':
                    reject()
                    break
                }
              }}
            />
          </Box>

          <Text dimColor wrap="truncate-end">
            Enter to confirm · Esc to reject · y/n/a shortcuts
          </Text>
        </Box>
      </ScreenFrame>
    </Box>
  )
}
