import { Box, Text } from 'ink'
import React, { useMemo } from 'react'
import chalk from 'chalk'
import { Select } from '#ui-ink/components/CustomSelect/select'
import { savePermission } from '#core/permissions'
import {
  type PermissionRequestProps,
  type ToolUseConfirm,
} from '#ui-ink/components/permissions/PermissionRequest'
import { getCwd } from '#core/utils/state'
import { getTheme } from '#core/utils/theme'
import {
  UnaryEvent,
  usePermissionRequestLogging,
} from '#ui-ink/hooks/usePermissionRequestLogging'
import { logUnaryEvent } from '#core/utils/unaryLogging'
import { env } from '#core/utils/env'
import { ScreenFrame } from '#ui-ink/primitives/layout/ScreenFrame'
import { useScreenLayout } from '#ui-ink/primitives/layout/useScreenLayout'
import { PermissionRequestDetails } from '#ui-ink/components/permissions/PermissionRequestDetails'
import {
  defaultPermissionFocusValue,
  permissionSelectFocusScope,
} from '#ui-ink/components/permissions/permissionFocusScope'

function parsePrefix(command: string): string | null {
  const trimmed = command.trim()
  if (!trimmed.startsWith('/')) return null
  const firstWord = trimmed.split(/\s+/)[0]
  return firstWord || null
}

function hasArgs(command: string): boolean {
  return command.trim().includes(' ')
}

export function SlashCommandPermissionRequest({
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

  const command =
    typeof toolUseConfirm.input.command === 'string'
      ? toolUseConfirm.input.command
      : ''
  const prefix = parsePrefix(command)
  const showPrefixOption = !!prefix && hasArgs(command)

  return (
    <Box marginTop={1} width="100%">
      <ScreenFrame
        title="Slash command permission"
        titleColor={theme.permission}
        paddingX={layout.paddingX}
        paddingY={layout.tightLayout ? 0 : layout.paddingY}
        gap={layout.gap}
      >
        <Box flexDirection="column" gap={layout.gap}>
          <Box flexDirection="column">
            <Text wrap="truncate-end">
              {toolUseConfirm.tool.userFacingName?.() || 'SlashCommand'}(
              {
                toolUseConfirm.tool.renderToolUseMessage(toolUseConfirm.input, {
                  verbose,
                }) as React.ReactNode
              }
              )
            </Text>
            <Text dimColor wrap="truncate-end">
              {toolUseConfirm.description}
            </Text>
            <PermissionRequestDetails toolUseConfirm={toolUseConfirm} />
          </Box>

          <Box flexDirection="column">
            <Text>Allow this command?</Text>
            <Select
              focusScope={permissionSelectFocusScope(toolUseConfirm, 'choice')}
              focusValue={defaultPermissionFocusValue(toolUseConfirm.riskScore)}
              options={[
                { label: 'Allow once', value: 'yes' },
                {
                  label: `Always allow ${chalk.bold(command)} in ${chalk.bold(getCwd())}`,
                  value: 'yes-exact',
                },
                ...(showPrefixOption
                  ? [
                      {
                        label: `Always allow ${chalk.bold(prefix + ':*')} in ${chalk.bold(getCwd())}`,
                        value: 'yes-prefix',
                      },
                    ]
                  : []),
                {
                  label: `Deny and provide instructions (${chalk.bold.hex(getTheme().warning)('esc')})`,
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
                  case 'yes-exact':
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
                  case 'yes-prefix':
                    if (!prefix) {
                      toolUseConfirm.onAllow('temporary')
                      onDone()
                      break
                    }
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
                      prefix,
                      toolUseConfirm.toolUseContext,
                    ).then(() => {
                      toolUseConfirm.onAllow('permanent')
                      onDone()
                    })
                    break
                  case 'no':
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
