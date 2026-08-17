import { Box, Text } from 'ink'
import React, { useCallback, useMemo } from 'react'
import { Select } from '#ui-ink/components/CustomSelect/select'
import { basename, dirname, extname } from 'path'
import { getTheme } from '#core/utils/theme'
import { textColorForRiskScore } from '#ui-ink/components/permissions/PermissionRequestTitle'
import { logUnaryEvent } from '#core/utils/unaryLogging'
import { env } from '#core/utils/env'
import { type ToolUseConfirm } from '#ui-ink/components/permissions/PermissionRequest'
import { existsSync } from 'fs'
import chalk from 'chalk'
import {
  UnaryEvent,
  usePermissionRequestLogging,
} from '#ui-ink/hooks/usePermissionRequestLogging'
import { FileWriteToolDiff } from './FileWriteToolDiff'
import { useTerminalSize } from '#ui-ink/hooks/useTerminalSize'
import { getPermissionModeCycleShortcut } from '#ui-ink/utils/permissionModeCycleShortcut'
import { usePermissionContext } from '#ui-ink/contexts/PermissionContext'
import { isPathInWorkingDirectories } from '#core/utils/permissions/fileToolPermissionEngine'
import { useKeypress } from '#ui-ink/hooks/useKeypress'
import { ScreenFrame } from '#ui-ink/primitives/layout/ScreenFrame'
import { useScreenLayout } from '#ui-ink/primitives/layout/useScreenLayout'
import { PermissionRequestDetails } from '#ui-ink/components/permissions/PermissionRequestDetails'
import { getPermissionDenyOptionLabel } from '#ui-ink/components/permissions/toolUseOptions'
import { applyToolPermissionUpdatesToLiveToolUseContext } from '../liveToolPermissionContext'
import { computeAvailableColumns } from '#ui-ink/primitives/layout/viewportColumns'
import { permissionSelectFocusScope } from '#ui-ink/components/permissions/permissionFocusScope'

type Props = {
  toolUseConfirm: ToolUseConfirm
  onDone(): void
  verbose: boolean
}

export function FileWritePermissionRequest({
  toolUseConfirm,
  onDone,
  verbose,
}: Props): React.ReactNode {
  const { applyToolPermissionUpdate, toolPermissionContext } =
    usePermissionContext()
  const layout = useScreenLayout()
  const { file_path, content } = toolUseConfirm.input as {
    file_path: string
    content: string
  }
  const modeCycleShortcut = useMemo(() => getPermissionModeCycleShortcut(), [])
  const hasSessionSuggestion = (toolUseConfirm.suggestions?.length ?? 0) > 0
  const isInWorkingDir = isPathInWorkingDirectories(
    dirname(file_path),
    toolPermissionContext,
  )
  const sessionLabel = useMemo(() => {
    const dirPath = dirname(file_path)
    const dirName = basename(dirPath) || 'this directory'
    const shortcutHint = chalk.bold.hex(getTheme().warning)(
      `(${modeCycleShortcut.displayText})`,
    )
    return isInWorkingDir
      ? `Allow all edits during this session ${shortcutHint}`
      : `Allow all edits in ${chalk.bold(`${dirName}/`)} during this session ${shortcutHint}`
  }, [file_path, isInWorkingDir, modeCycleShortcut.displayText])
  const fileExists = useMemo(() => existsSync(file_path), [file_path])
  const unaryEvent = useMemo<UnaryEvent>(
    () => ({
      completion_type: 'write_file_single',
      language_name: extractLanguageName(file_path),
    }),
    [file_path],
  )
  const { columns } = useTerminalSize()
  const diffWidth = computeAvailableColumns({
    columns,
    reservedColumns: layout.paddingX * 2 + 2,
  })
  usePermissionRequestLogging(toolUseConfirm, unaryEvent)

  const handleChoice = useCallback(
    (newValue: string) => {
      switch (newValue) {
        case 'yes':
          extractLanguageName(file_path).then(language => {
            logUnaryEvent({
              completion_type: 'write_file_single',
              event: 'accept',
              metadata: {
                language_name: language,
                message_id: toolUseConfirm.assistantMessage.message.id,
                platform: env.platform,
              },
            })
          })
          onDone()
          toolUseConfirm.onAllow('temporary')
          return
        case 'yes-session':
          extractLanguageName(file_path).then(language => {
            logUnaryEvent({
              completion_type: 'write_file_single',
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
              completion_type: 'write_file_single',
              event: 'reject',
              metadata: {
                language_name: language,
                message_id: toolUseConfirm.assistantMessage.message.id,
                platform: env.platform,
              },
            })
          })
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
        title={`${fileExists ? 'Edit' : 'Create'} file permission`}
        titleColor={textColorForRiskScore(toolUseConfirm.riskScore)}
        paddingX={layout.paddingX}
        paddingY={layout.tightLayout ? 0 : layout.paddingY}
        gap={layout.gap}
      >
        <Box flexDirection="column" gap={layout.gap}>
          <PermissionRequestDetails toolUseConfirm={toolUseConfirm} />
          <FileWriteToolDiff
            file_path={file_path}
            content={content}
            verbose={verbose}
            width={diffWidth}
            enableScrolling={true}
          />

          <Box flexDirection="column">
            <Text>
              Allow {fileExists ? 'this edit to' : 'creating'}{' '}
              <Text bold>{basename(file_path)}</Text>?
            </Text>
            <Select
              focusScope={permissionSelectFocusScope(toolUseConfirm, 'choice')}
              options={[
                {
                  label: 'Allow once',
                  value: 'yes',
                },
                ...(hasSessionSuggestion
                  ? [
                      {
                        label: sessionLabel,
                        value: 'yes-session',
                      },
                    ]
                  : []),
                {
                  label: getPermissionDenyOptionLabel(),
                  value: 'no',
                },
              ]}
              onChange={handleChoice}
            />
          </Box>

          <Text dimColor wrap="truncate-end">
            Enter to confirm · Esc to reject · PgUp/PgDn scroll preview
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
