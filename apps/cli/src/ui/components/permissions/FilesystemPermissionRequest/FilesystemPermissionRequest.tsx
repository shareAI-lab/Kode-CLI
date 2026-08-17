import { Box, Text } from 'ink'
import React, { useCallback, useMemo } from 'react'
import { Select } from '#ui-ink/components/CustomSelect/select'
import { getTheme } from '#core/utils/theme'
import { textColorForRiskScore } from '#ui-ink/components/permissions/PermissionRequestTitle'
import { logUnaryEvent } from '#core/utils/unaryLogging'
import { env } from '#core/utils/env'
import {
  type PermissionRequestProps,
  type ToolUseConfirm,
} from '#ui-ink/components/permissions/PermissionRequest'
import chalk from 'chalk'
import {
  UnaryEvent,
  usePermissionRequestLogging,
} from '#ui-ink/hooks/usePermissionRequestLogging'
import { FileEditTool } from '#tools/tools/filesystem/FileEditTool/FileEditTool'
import { FileWriteTool } from '#tools/tools/filesystem/FileWriteTool/FileWriteTool'
import { GrepTool } from '#tools/tools/search/GrepTool/GrepTool'
import { GlobTool } from '#tools/tools/filesystem/GlobTool/GlobTool'
import { FileReadTool } from '#tools/tools/filesystem/FileReadTool/FileReadTool'
import { NotebookEditTool } from '#tools/tools/filesystem/NotebookEditTool/NotebookEditTool'
import { FallbackPermissionRequest } from '#ui-ink/components/permissions/FallbackPermissionRequest'
import { toAbsolutePath } from '#core/utils/permissions/filesystem'
import { getCwd } from '#core/utils/state'
import { basename, dirname } from 'path'
import { statSync } from 'fs'
import { getPermissionModeCycleShortcut } from '#ui-ink/utils/permissionModeCycleShortcut'
import { usePermissionContext } from '#ui-ink/contexts/PermissionContext'
import { isPathInWorkingDirectories } from '#core/utils/permissions/fileToolPermissionEngine'
import { useKeypress } from '#ui-ink/hooks/useKeypress'
import { ScreenFrame } from '#ui-ink/primitives/layout/ScreenFrame'
import { useScreenLayout } from '#ui-ink/primitives/layout/useScreenLayout'
import { PermissionRequestDetails } from '#ui-ink/components/permissions/PermissionRequestDetails'
import { applyToolPermissionUpdatesToLiveToolUseContext } from '../liveToolPermissionContext'
import { permissionSelectFocusScope } from '#ui-ink/components/permissions/permissionFocusScope'

function pathArgNameForToolUse(toolUseConfirm: ToolUseConfirm): string | null {
  switch (toolUseConfirm.tool) {
    case FileWriteTool:
    case FileEditTool:
    case FileReadTool: {
      return 'file_path'
    }
    case GlobTool:
    case GrepTool: {
      return 'path'
    }
    case NotebookEditTool: {
      return 'notebook_path'
    }
  }
  return null
}

function isMultiFile(toolUseConfirm: ToolUseConfirm): boolean {
  switch (toolUseConfirm.tool) {
    case GlobTool:
    case GrepTool: {
      return true
    }
  }
  return false
}

function pathToPermissionDirectory(path: string): string {
  try {
    const stats = statSync(path)
    if (stats.isDirectory()) return path
  } catch {
    // Treat missing/unstatable path as a file path.
  }
  return dirname(path)
}

function pathFromToolUse(toolUseConfirm: ToolUseConfirm): string | null {
  const pathArgName = pathArgNameForToolUse(toolUseConfirm)
  const input = toolUseConfirm.input
  if (pathArgName && pathArgName in input) {
    if (typeof input[pathArgName] === 'string') {
      return toAbsolutePath(input[pathArgName])
    } else {
      return toAbsolutePath(getCwd())
    }
  }
  return null
}

export function FilesystemPermissionRequest({
  toolUseConfirm,
  onDone,
  verbose,
}: PermissionRequestProps): React.ReactNode {
  const path = pathFromToolUse(toolUseConfirm)
  if (!path) {
    // Fall back to generic permission request if no path is found
    return (
      <FallbackPermissionRequest
        toolUseConfirm={toolUseConfirm}
        onDone={onDone}
        verbose={verbose}
      />
    )
  }
  return (
    <FilesystemPermissionRequestImpl
      toolUseConfirm={toolUseConfirm}
      path={path}
      onDone={onDone}
      verbose={verbose}
    />
  )
}

function getDontAskAgainOptions(
  toolUseConfirm: ToolUseConfirm,
  path: string,
  modeCycleShortcut: string,
  isInWorkingDir: boolean,
  hasSessionSuggestion: boolean,
) {
  if (!hasSessionSuggestion) return []
  const permissionDirPath = pathToPermissionDirectory(path)
  const permissionDirName = basename(permissionDirPath) || 'this directory'

  if (toolUseConfirm.tool.isReadOnly(toolUseConfirm.input as never)) {
    const label = isInWorkingDir
      ? 'Allow during this session'
      : `Allow reading from ${chalk.bold(`${permissionDirName}/`)} during this session`
    return [{ label, value: 'yes-session' }]
  }

  // For write/edit tools, offer a session-scoped allow.
  const shortcutHint = chalk.bold.hex(getTheme().warning)(
    `(${modeCycleShortcut})`,
  )
  const label = isInWorkingDir
    ? `Allow all edits during this session ${shortcutHint}`
    : `Allow all edits in ${chalk.bold(`${permissionDirName}/`)} during this session ${shortcutHint}`
  return [{ label, value: 'yes-session' }]
}

type Props = {
  toolUseConfirm: ToolUseConfirm
  path: string
  onDone(): void
  verbose: boolean
}

function FilesystemPermissionRequestImpl({
  toolUseConfirm,
  path,
  onDone,
  verbose,
}: Props): React.ReactNode {
  const { applyToolPermissionUpdate, toolPermissionContext } =
    usePermissionContext()
  const layout = useScreenLayout()
  const modeCycleShortcut = useMemo(() => getPermissionModeCycleShortcut(), [])
  const userFacingName =
    toolUseConfirm.tool.userFacingName?.() || toolUseConfirm.tool.name || 'Tool'
  const hasSessionSuggestion = (toolUseConfirm.suggestions?.length ?? 0) > 0

  const userFacingReadOrWrite = toolUseConfirm.tool.isReadOnly(
    toolUseConfirm.input as never,
  )
    ? 'Read'
    : 'Edit'
  const canQuickAllowSession =
    hasSessionSuggestion &&
    !toolUseConfirm.tool.isReadOnly(toolUseConfirm.input as never)
  const title = `${userFacingReadOrWrite} ${isMultiFile(toolUseConfirm) ? 'files' : 'file'}`

  const unaryEvent = useMemo<UnaryEvent>(
    () => ({
      completion_type: 'tool_use_single',
      language_name: 'none',
    }),
    [],
  )

  usePermissionRequestLogging(toolUseConfirm, unaryEvent)

  const permissionDirPath = useMemo(
    () => pathToPermissionDirectory(path),
    [path],
  )
  const isInWorkingDir = useMemo(
    () => isPathInWorkingDirectories(permissionDirPath, toolPermissionContext),
    [permissionDirPath, toolPermissionContext],
  )

  const handleChoice = useCallback(
    (newValue: string) => {
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
          onDone()
          toolUseConfirm.onAllow('temporary')
          return
        case 'yes-session':
          logUnaryEvent({
            completion_type: 'tool_use_single',
            event: 'accept',
            metadata: {
              language_name: 'none',
              message_id: toolUseConfirm.assistantMessage.message.id,
              platform: env.platform,
            },
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
          logUnaryEvent({
            completion_type: 'tool_use_single',
            event: 'reject',
            metadata: {
              language_name: 'none',
              message_id: toolUseConfirm.assistantMessage.message.id,
              platform: env.platform,
            },
          })
          onDone()
          toolUseConfirm.onReject()
          return
      }
    },
    [applyToolPermissionUpdate, hasSessionSuggestion, onDone, toolUseConfirm],
  )

  useKeypress((inputChar, key) => {
    if (!modeCycleShortcut.check(inputChar, key)) return undefined
    if (toolUseConfirm.tool.isReadOnly(toolUseConfirm.input as never))
      return undefined
    if (!hasSessionSuggestion) return undefined
    handleChoice('yes-session')
    return true
  })

  return (
    <Box marginTop={1} width="100%">
      <ScreenFrame
        title={`${title} permission`}
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
            </Text>
            <PermissionRequestDetails toolUseConfirm={toolUseConfirm} />
          </Box>

          <Box flexDirection="column">
            <Text>Allow this action?</Text>
            <Select
              focusScope={permissionSelectFocusScope(toolUseConfirm, 'choice')}
              options={[
                {
                  label: 'Allow once',
                  value: 'yes',
                },
                ...getDontAskAgainOptions(
                  toolUseConfirm,
                  path,
                  modeCycleShortcut.displayText,
                  isInWorkingDir,
                  hasSessionSuggestion,
                ),
                {
                  label: `Deny and provide instructions (${chalk.bold.hex(getTheme().warning)('esc')})`,
                  value: 'no',
                },
              ]}
              onChange={handleChoice}
            />
          </Box>

          <Text dimColor wrap="truncate-end">
            Enter to confirm · Esc to reject · y/n/a shortcuts
            {canQuickAllowSession
              ? ` · ${modeCycleShortcut.displayText} allow this session`
              : ''}
          </Text>
        </Box>
      </ScreenFrame>
    </Box>
  )
}
