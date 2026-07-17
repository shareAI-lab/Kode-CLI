import type { Command } from '../types'

import { existsSync, writeFileSync } from 'node:fs'
import { Box, Text } from 'ink'
import React from 'react'

import { setPermissionMode } from '#core/utils/permissionModeState'
import { applyToolPermissionContextUpdateForConversationKey } from '#core/utils/toolPermissionContextState'
import { enterPlanMode, getPlanConversationKey } from '#core/utils/planMode'
import { launchExternalEditorForFilePath } from '#cli-utils/externalEditor'

const plan = {
  type: 'local-jsx',
  name: 'plan',
  description: 'Enable plan mode or view the current session plan',
  argumentHint: '[open]',
  aliases: ['pl'],
  isEnabled: true,
  isHidden: false,
  async call(onDone, context, args = '') {
    const safeMode = Boolean(context?.options?.safeMode ?? context?.safeMode)
    const conversationKey = getPlanConversationKey(context)

    const updatedToolPermissionContext =
      applyToolPermissionContextUpdateForConversationKey({
        conversationKey,
        isBypassPermissionsModeAvailable: !safeMode,
        update: { type: 'setMode', mode: 'plan', destination: 'session' },
      })

    context.options ??= {}
    context.options.toolPermissionContext = updatedToolPermissionContext
    setPermissionMode(context, 'plan')

    const { planFilePath } = enterPlanMode(context)

    const arg = String(args ?? '')
      .trim()
      .toLowerCase()
    if (arg === 'open') {
      if (!existsSync(planFilePath)) {
        writeFileSync(planFilePath, '# Plan\n\n', 'utf8')
      }

      const result = await launchExternalEditorForFilePath(planFilePath)
      if (result.ok === false) {
        onDone(
          `Plan mode enabled. Could not open plan file in editor: ${result.error.message}`,
        )
        return null
      }

      onDone(`Plan mode enabled. Opened plan file in ${result.editorLabel}.`)
      return null
    }

    return (
      <Box flexDirection="column">
        <Text>Plan mode enabled.</Text>
        <Text dimColor>Plan file: {planFilePath}</Text>
        <Text dimColor>Tip: run /plan open to edit it in $EDITOR.</Text>
      </Box>
    )
  },
  userFacingName() {
    return 'plan'
  },
} satisfies Command

export default plan
