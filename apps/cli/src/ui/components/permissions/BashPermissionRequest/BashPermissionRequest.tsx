import { Box, Text } from 'ink'
import React, { useMemo } from 'react'
import { UnaryEvent } from '#ui-ink/hooks/usePermissionRequestLogging'
import { savePermission } from '#core/permissions'
import { BashTool } from '#tools/tools/system/BashTool/BashTool'
import { getTheme } from '#core/utils/theme'
import { usePermissionRequestLogging } from '#ui-ink/components/permissions/hooks'
import {
  type ToolUseConfirm,
  toolUseConfirmGetPrefix,
} from '#ui-ink/components/permissions/PermissionRequest'
import { textColorForRiskScore } from '#ui-ink/components/permissions/PermissionRequestTitle'
import { logUnaryPermissionEvent } from '#ui-ink/components/permissions/utils'
import { Select } from '#ui-ink/components/CustomSelect/select'
import { toolUseOptions } from '#ui-ink/components/permissions/toolUseOptions'
import { ScreenFrame } from '#ui-ink/primitives/layout/ScreenFrame'
import { useScreenLayout } from '#ui-ink/primitives/layout/useScreenLayout'
import { PermissionRequestDetails } from '#ui-ink/components/permissions/PermissionRequestDetails'
import {
  defaultPermissionFocusValue,
  permissionSelectFocusScope,
} from '#ui-ink/components/permissions/permissionFocusScope'

type Props = {
  toolUseConfirm: ToolUseConfirm
  onDone(): void
}

export function BashPermissionRequest({
  toolUseConfirm,
  onDone,
}: Props): React.ReactNode {
  const theme = getTheme()
  const layout = useScreenLayout()

  // ok to use parse since we've already validated args earliers
  const { command, run_in_background, description } =
    BashTool.inputSchema.parse(toolUseConfirm.input)

  const unaryEvent = useMemo<UnaryEvent>(
    () => ({ completion_type: 'tool_use_single', language_name: 'none' }),
    [],
  )

  usePermissionRequestLogging(toolUseConfirm, unaryEvent)

  return (
    <Box marginTop={1} width="100%">
      <ScreenFrame
        title="Bash command permission"
        titleColor={textColorForRiskScore(toolUseConfirm.riskScore)}
        paddingX={layout.paddingX}
        paddingY={layout.tightLayout ? 0 : layout.paddingY}
        gap={layout.gap}
      >
        <Box flexDirection="column" gap={layout.gap}>
          <Box flexDirection="column">
            {/* The full command must stay readable before approval: wrapping
                beats truncation for multi-line and long commands. */}
            <Text wrap="wrap">
              {BashTool.renderToolUseMessage({
                command,
                run_in_background,
                description,
              })}
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
              options={toolUseOptions({ toolUseConfirm, command })}
              onChange={newValue => {
                switch (newValue) {
                  case 'yes':
                    logUnaryPermissionEvent(
                      'tool_use_single',
                      toolUseConfirm,
                      'accept',
                    )
                    toolUseConfirm.onAllow('temporary')
                    onDone()
                    break
                  case 'yes-dont-ask-again-prefix': {
                    const prefix = toolUseConfirmGetPrefix(toolUseConfirm)
                    if (prefix !== null) {
                      logUnaryPermissionEvent(
                        'tool_use_single',
                        toolUseConfirm,
                        'accept',
                      )
                      savePermission(
                        toolUseConfirm.tool,
                        toolUseConfirm.input,
                        prefix,
                        toolUseConfirm.toolUseContext,
                      ).then(() => {
                        toolUseConfirm.onAllow('permanent')
                        onDone()
                      })
                    }
                    break
                  }
                  case 'yes-dont-ask-again-full':
                    logUnaryPermissionEvent(
                      'tool_use_single',
                      toolUseConfirm,
                      'accept',
                    )
                    savePermission(
                      toolUseConfirm.tool,
                      toolUseConfirm.input,
                      null, // Save without prefix
                      toolUseConfirm.toolUseContext,
                    ).then(() => {
                      toolUseConfirm.onAllow('permanent')
                      onDone()
                    })
                    break
                  case 'no':
                    logUnaryPermissionEvent(
                      'tool_use_single',
                      toolUseConfirm,
                      'reject',
                    )
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
