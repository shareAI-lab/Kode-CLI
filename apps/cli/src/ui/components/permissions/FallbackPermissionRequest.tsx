import { Box, Text } from 'ink'
import React, { useMemo } from 'react'
import { Select } from '#ui-ink/components/CustomSelect/select'
import { getTheme } from '#core/utils/theme'
import {
  PermissionRequestTitle,
  textColorForRiskScore,
} from './PermissionRequestTitle'
import { logUnaryEvent } from '#core/utils/unaryLogging'
import { env } from '#core/utils/env'
import { getCwd } from '#core/utils/state'
import { savePermission } from '#core/permissions'
import {
  type ToolUseConfirm,
  toolUseConfirmGetPrefix,
} from './PermissionRequest'
import chalk from 'chalk'
import {
  UnaryEvent,
  usePermissionRequestLogging,
} from '#ui-ink/hooks/usePermissionRequestLogging'
import { ScreenFrame } from '#ui-ink/primitives/layout/ScreenFrame'
import { useScreenLayout } from '#ui-ink/primitives/layout/useScreenLayout'
import { PermissionRequestDetails } from './PermissionRequestDetails'
import { getPermissionDenyOptionLabel } from './toolUseOptions'
import {
  defaultPermissionFocusValue,
  permissionSelectFocusScope,
} from './permissionFocusScope'

type Props = {
  toolUseConfirm: ToolUseConfirm
  onDone(): void
  verbose: boolean
}

export function FallbackPermissionRequest({
  toolUseConfirm,
  onDone,
  verbose,
}: Props): React.ReactNode {
  const theme = getTheme()
  const layout = useScreenLayout()

  // NOTE: normalize "(MCP)" suffix for consistent display in the fallback UI.
  const originalUserFacingName =
    toolUseConfirm.tool.userFacingName?.() || toolUseConfirm.tool.name || 'Tool'
  const userFacingName = originalUserFacingName.endsWith(' (MCP)')
    ? originalUserFacingName.slice(0, -6)
    : originalUserFacingName

  const unaryEvent = useMemo<UnaryEvent>(
    () => ({
      completion_type: 'tool_use_single',
      language_name: 'none',
    }),
    [],
  )

  usePermissionRequestLogging(toolUseConfirm, unaryEvent)

  return (
    <Box marginTop={1} width="100%">
      <ScreenFrame
        title="Tool use permission"
        titleColor={textColorForRiskScore(toolUseConfirm.riskScore)}
        paddingX={layout.paddingX}
        paddingY={layout.tightLayout ? 0 : layout.paddingY}
        gap={layout.gap}
      >
        <Box flexDirection="column" gap={layout.gap}>
          <Box flexDirection="column">
            <Text wrap="truncate-end">
              {userFacingName}(
              {
                toolUseConfirm.tool.renderToolUseMessage(
                  toolUseConfirm.input as never,
                  { verbose },
                ) as React.ReactNode
              }
              )
              {originalUserFacingName.endsWith(' (MCP)') ? (
                <Text dimColor> (MCP)</Text>
              ) : (
                ''
              )}
            </Text>
            <Text dimColor wrap="truncate-end">
              {toolUseConfirm.description}
            </Text>
            <PermissionRequestDetails toolUseConfirm={toolUseConfirm} />
          </Box>

          <Box flexDirection="column">
            <Text>Allow this tool use?</Text>
            <Select
              focusScope={permissionSelectFocusScope(toolUseConfirm, 'choice')}
              focusValue={defaultPermissionFocusValue(toolUseConfirm.riskScore)}
              options={[
                {
                  label: 'Allow once',
                  value: 'yes',
                },
                {
                  label: `Always allow ${chalk.bold(userFacingName)} in ${chalk.bold(getCwd())}`,
                  value: 'yes-dont-ask-again',
                },
                {
                  label: getPermissionDenyOptionLabel(),
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
                      toolUseConfirmGetPrefix(toolUseConfirm),
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
