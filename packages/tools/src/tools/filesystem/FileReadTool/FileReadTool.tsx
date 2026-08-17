import { Box, Text } from 'ink'
import * as path from 'node:path'
import { extname, relative } from 'node:path'
import * as React from 'react'
import { z } from 'zod'
import type { Tool } from '@kode/tool-interface/Tool'
import { getCwd } from '#core/utils/state'
import { findSimilarFile, normalizeFilePath } from '#core/utils/file'
import { getTheme } from '#core/utils/theme'
import { getKodeBaseDir } from '#core/utils/env'
import { extractBackgroundTaskOutputIdFromPath } from '#core/tasks/outputPaths'
import { DESCRIPTION, getPrompt } from './prompt'
import { hasReadPermission } from '#core/utils/permissions/filesystem'
import { secureFileService } from '#core/utils/secureFile'
import type { FileReadToolData } from './types'
import { highlightCode } from './highlight'
import {
  BINARY_EXTENSIONS,
  IMAGE_EXTENSIONS,
  MAX_LINES_TO_RENDER,
  MAX_OUTPUT_SIZE,
  formatFileSizeError,
} from './constants'
import { renderResultForAssistant } from './renderResultForAssistant'
import { callFileReadTool } from './call'

function toPosixPath(value: string): string {
  return value.replace(/\\/g, '/')
}

function isPosixPathWithinDir(posixPath: string, dirPosix: string): boolean {
  return posixPath === dirPosix || posixPath.startsWith(`${dirPosix}/`)
}

const inputSchema = z.strictObject({
  file_path: z.string().describe('The absolute path to the file to read'),
  offset: z
    .number()
    .optional()
    .describe(
      'The line number to start reading from. Only provide if the file is too large to read at once',
    ),
  limit: z
    .number()
    .optional()
    .describe(
      'The number of lines to read. Only provide if the file is too large to read at once.',
    ),
})

export const FileReadTool = {
  name: 'Read',
  async description() {
    return DESCRIPTION
  },
  async prompt() {
    return getPrompt()
  },
  inputSchema,
  readModeAccess: 'always',
  isReadOnly() {
    return true
  },
  isConcurrencySafe() {
    return true // FileRead is read-only, safe for concurrent execution
  },
  userFacingName(input?: z.infer<typeof inputSchema>) {
    const filePath = input?.file_path
    if (!filePath) return 'Read'

    const absolute = normalizeFilePath(filePath)
    const absolutePosix = toPosixPath(absolute)

    const planDirPosix = toPosixPath(path.join(getKodeBaseDir(), 'plans'))
    if (isPosixPathWithinDir(absolutePosix, planDirPosix)) {
      return 'Reading Plan'
    }

    if (extractBackgroundTaskOutputIdFromPath(absolute)) {
      return 'Read agent output'
    }

    return 'Read'
  },
  async isEnabled() {
    return true
  },
  needsPermissions(input) {
    return !hasReadPermission(input?.file_path || getCwd())
  },
  renderToolUseMessage(input, { verbose }) {
    const { file_path, ...rest } = input
    const entries = [
      ['file_path', verbose ? file_path : relative(getCwd(), file_path)],
      ...Object.entries(rest),
    ]
    return entries
      .map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
      .join(', ')
  },
  renderToolResultMessage(output) {
    const verbose = false // Set default value for verbose
    // NOTE: Directory trees are rendered non-recursively by default.
    switch (output.type) {
      case 'image':
        return (
          <Box justifyContent="space-between" overflowX="hidden" width="100%">
            <Box flexDirection="row" paddingLeft={2}>
              <Text color={getTheme().secondaryText}>(image content)</Text>
            </Box>
          </Box>
        )
      case 'text': {
        const { filePath, content, numLines } = output.file
        const contentWithFallback = content || '(empty file)'
        return (
          <Box justifyContent="space-between" overflowX="hidden" width="100%">
            <Box flexDirection="row" paddingLeft={2}>
              <Box flexDirection="column">
                <Text>
                  {highlightCode(
                    verbose
                      ? contentWithFallback
                      : contentWithFallback
                          .split('\n')
                          .slice(0, MAX_LINES_TO_RENDER)
                          .filter(_ => _.trim() !== '')
                          .join('\n'),
                    extname(filePath).slice(1),
                  )}
                </Text>
                {!verbose && numLines > MAX_LINES_TO_RENDER && (
                  <Text color={getTheme().secondaryText}>
                    ... (+{numLines - MAX_LINES_TO_RENDER} lines)
                  </Text>
                )}
              </Box>
            </Box>
          </Box>
        )
      }
    }
    return null
  },
  async validateInput({ file_path, offset, limit }) {
    const fullFilePath = normalizeFilePath(file_path)

    // Use secure file service to check if file exists and get file info
    const fileCheck = secureFileService.safeGetFileInfo(fullFilePath)
    if (!fileCheck.success) {
      // Try to find a similar file with a different extension
      const similarFilename = findSimilarFile(fullFilePath)
      let message = 'File does not exist.'

      // If we found a similar file, suggest it to the assistant
      if (similarFilename) {
        message += ` Did you mean ${similarFilename}?`
      }

      return {
        result: false,
        message,
      }
    }

    const ext = path.extname(fullFilePath).toLowerCase()
    const fileSize = fileCheck.stats?.size ?? 0

    if (BINARY_EXTENSIONS.has(ext)) {
      return {
        result: false,
        message: `This tool cannot read binary files. The file appears to be a binary ${ext} file. Please use appropriate tools for binary file analysis.`,
      }
    }

    if (fileSize === 0 && IMAGE_EXTENSIONS.has(ext)) {
      return {
        result: false,
        message: 'Empty image files cannot be processed.',
      }
    }

    const isNotebook = ext === '.ipynb'
    const isPdf = ext === '.pdf'
    const isImage = IMAGE_EXTENSIONS.has(ext)
    if (!isImage && !isNotebook && !isPdf) {
      if (fileSize > MAX_OUTPUT_SIZE && !offset && !limit) {
        return {
          result: false,
          message: formatFileSizeError(fileSize),
        }
      }
    }

    return { result: true }
  },
  async *call({ file_path, offset = 1, limit = undefined }, ctx) {
    yield* callFileReadTool({ file_path, offset, limit }, ctx)
  },
  renderResultForAssistant,
} satisfies Tool<typeof inputSchema, FileReadToolData>
