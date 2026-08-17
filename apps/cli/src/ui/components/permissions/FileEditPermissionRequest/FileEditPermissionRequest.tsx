import { Select } from '#ui-ink/components/CustomSelect/select'
import chalk from 'chalk'
import { Box, Text } from 'ink'
import { basename, dirname, extname } from 'path'
import React, { useCallback, useMemo } from 'react'
import {
  UnaryEvent,
  usePermissionRequestLogging,
} from '#ui-ink/hooks/usePermissionRequestLogging'
import { env } from '#core/utils/env'
import { getTheme } from '#core/utils/theme'
import { logUnaryEvent } from '#core/utils/unaryLogging'
import { type ToolUseConfirm } from '#ui-ink/components/permissions/PermissionRequest'
import { textColorForRiskScore } from '#ui-ink/components/permissions/PermissionRequestTitle'
import { FileEditToolDiff } from './FileEditToolDiff'
import { useTerminalSize } from '#ui-ink/hooks/useTerminalSize'
import { getPermissionModeCycleShortcut } from '#ui-ink/utils/permissionModeCycleShortcut'
import { usePermissionContext } from '#ui-ink/contexts/PermissionContext'
import { isPathInWorkingDirectories } from '#core/utils/permissions/fileToolPermissionEngine'
import { useKeypress } from '#ui-ink/hooks/useKeypress'
import { ScreenFrame } from '#ui-ink/primitives/layout/ScreenFrame'
import { useScreenLayout } from '#ui-ink/primitives/layout/useScreenLayout'
import { PermissionRequestDetails } from '#ui-ink/components/permissions/PermissionRequestDetails'
import { applyToolPermissionUpdatesToLiveToolUseContext } from '../liveToolPermissionContext'
import { computeAvailableColumns } from '#ui-ink/primitives/layout/viewportColumns'
import { permissionSelectFocusScope } from '#ui-ink/components/permissions/permissionFocusScope'
import { getPermissionDenyOptionLabel } from '#ui-ink/components/permissions/toolUseOptions'

function getOptions(args: {
  path: string
  modeCycleShortcut: string
  isInWorkingDir: boolean
  hasSessionSuggestion: boolean
}) {
  const dirPath = dirname(args.path)
  const dirName = basename(dirPath) || 'this directory'

  const options = [
    {
      label: 'Allow once',
      value: 'yes',
    },
    {
      label: getPermissionDenyOptionLabel(),
      value: 'no',
    },
  ]

  if (args.hasSessionSuggestion) {
    const shortcutHint = chalk.bold.hex(getTheme().warning)(
      `(${args.modeCycleShortcut})`,
    )
    const sessionLabel = args.isInWorkingDir
      ? `Allow all edits during this session ${shortcutHint}`
      : `Allow all edits in ${chalk.bold(`${dirName}/`)} during this session ${shortcutHint}`
    options.splice(1, 0, { label: sessionLabel, value: 'yes-session' })
  }

  return options
}

type Props = {
  toolUseConfirm: ToolUseConfirm
  onDone(): void
  verbose: boolean
}

export function FileEditPermissionRequest({
  toolUseConfirm,
  onDone,
  verbose,
}: Props): React.ReactNode {
  const { columns } = useTerminalSize()
  const layout = useScreenLayout()
  const diffWidth = computeAvailableColumns({
    columns,
    reservedColumns: layout.paddingX * 2 + 2,
  })
  const { applyToolPermissionUpdate, toolPermissionContext } =
    usePermissionContext()
  const { file_path, new_string, old_string } = toolUseConfirm.input as {
    file_path: string
    new_string: string
    old_string: string
  }
  const modeCycleShortcut = useMemo(() => getPermissionModeCycleShortcut(), [])
  const hasSessionSuggestion = (toolUseConfirm.suggestions?.length ?? 0) > 0
  const isInWorkingDir = isPathInWorkingDirectories(
    dirname(file_path),
    toolPermissionContext,
  )

  const unaryEvent = useMemo<UnaryEvent>(
    () => ({
      completion_type: 'str_replace_single',
      language_name: extractLanguageName(file_path),
    }),
    [file_path],
  )

  usePermissionRequestLogging(toolUseConfirm, unaryEvent)

  const handleChoice = useCallback(
    (newValue: string) => {
      switch (newValue) {
        case 'yes':
          extractLanguageName(file_path).then(language => {
            logUnaryEvent({
              completion_type: 'str_replace_single',
              event: 'accept',
              metadata: {
                language_name: language,
                message_id: toolUseConfirm.assistantMessage.message.id,
                platform: env.platform,
              },
            })
          })
          // Note: We call onDone before onAllow to hide the
          // permission request before we render the next message
          onDone()
          toolUseConfirm.onAllow('temporary')
          return
        case 'yes-session':
          extractLanguageName(file_path).then(language => {
            logUnaryEvent({
              completion_type: 'str_replace_single',
              event: 'accept',
              metadata: {
                language_name: language,
                message_id: toolUseConfirm.assistantMessage.message.id,
                platform: env.platform,
              },
            })
          })
          if (hasSessionSuggestion) {
            for (const update of toolUseConfirm.suggestions ?? []) {
              applyToolPermissionUpdate(update)
            }
            applyToolPermissionUpdatesToLiveToolUseContext({
              toolUseContext: toolUseConfirm.toolUseContext,
              updates: toolUseConfirm.suggestions ?? [],
            })
          }
          onDone()
          toolUseConfirm.onAllow(
            hasSessionSuggestion ? 'permanent' : 'temporary',
          )
          return
        case 'no':
          extractLanguageName(file_path).then(language => {
            logUnaryEvent({
              completion_type: 'str_replace_single',
              event: 'reject',
              metadata: {
                language_name: language,
                message_id: toolUseConfirm.assistantMessage.message.id,
                platform: env.platform,
              },
            })
          })
          // Note: We call onDone before onAllow to hide the
          // permission request before we render the next message
          onDone()
          toolUseConfirm.onReject()
          return
      }
    },
    [
      applyToolPermissionUpdate,
      file_path,
      hasSessionSuggestion,
      onDone,
      toolUseConfirm,
    ],
  )

  useKeypress((inputChar, key) => {
    if (!modeCycleShortcut.check(inputChar, key)) return undefined
    if (!hasSessionSuggestion) return undefined
    handleChoice('yes-session')
    return true
  })

  return (
    <Box marginTop={1} width="100%">
      <ScreenFrame
        title="Edit file permission"
        titleColor={textColorForRiskScore(toolUseConfirm.riskScore)}
        paddingX={layout.paddingX}
        paddingY={layout.tightLayout ? 0 : layout.paddingY}
        gap={layout.gap}
      >
        <Box flexDirection="column" gap={layout.gap}>
          <PermissionRequestDetails toolUseConfirm={toolUseConfirm} />
          <FileEditToolDiff
            file_path={file_path}
            new_string={new_string}
            old_string={old_string}
            verbose={verbose}
            width={diffWidth}
            enableScrolling={true}
          />

          <Box flexDirection="column">
            <Text>
              Allow this edit to <Text bold>{basename(file_path)}</Text>?
            </Text>
            <Select
              focusScope={permissionSelectFocusScope(toolUseConfirm, 'choice')}
              options={getOptions({
                path: file_path,
                modeCycleShortcut: modeCycleShortcut.displayText,
                isInWorkingDir,
                hasSessionSuggestion,
              })}
              onChange={handleChoice}
            />
          </Box>

          <Text dimColor wrap="truncate-end">
            Enter to confirm · Esc to reject · PgUp/PgDn scroll diff
            {hasSessionSuggestion
              ? ` · ${modeCycleShortcut.displayText} allow session`
              : ''}
          </Text>
        </Box>
      </ScreenFrame>
    </Box>
  )
}

async function extractLanguageName(file_path: string): Promise<string> {
  const ext = extname(file_path)
  if (!ext) {
    return 'unknown'
  }
  const Highlight = (await import('highlight.js')) as unknown as {
    default: { getLanguage(ext: string): { name: string | undefined } }
  }
  return Highlight.default.getLanguage(ext.slice(1))?.name ?? 'unknown'
}
