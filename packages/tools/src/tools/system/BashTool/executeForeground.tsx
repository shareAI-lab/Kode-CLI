import { statSync } from 'fs'
import { EOL } from 'os'
import { isAbsolute, resolve } from 'path'
import * as React from 'react'
import type { SetToolJSXFn } from '@kode/tool-interface/Tool'
import { createAssistantMessage } from '#core/utils/messages'
import { isInDirectory } from '#core/utils/file'
import { logError } from '#core/utils/log'
import { getCwd, getOriginalCwd, setCwd } from '#core/utils/state'
import { BunShell } from '#runtime/shell'
import type { BunShellSandboxOptions } from '#runtime/shell'
import {
  BashToolRunInBackgroundOverlay,
  createRunInBackgroundKeypressHandler,
} from './BashToolRunInBackgroundOverlay'
import { formatOutput, getCommandFilePaths } from './utils'
import { countNewlines, formatDuration, normalizeLineEndings } from './text'
import type { Out } from './BashTool'
import { maybeSummarizeBashOutput } from './summarizeOutput'

type SetToolJSX = SetToolJSXFn<React.ReactNode>
type AssistantResult = string | unknown[]

export async function* executeForegroundBash(options: {
  command: string
  timeout: number
  abortController: AbortController
  readFileTimestamps: Record<string, number>
  sandboxOptions: BunShellSandboxOptions | undefined
  dangerouslyDisableSandbox?: boolean
  setToolJSX?: SetToolJSX
  renderResultForAssistant: (output: Out) => AssistantResult
  conversationKey: string
  skipSummary?: boolean
}): AsyncGenerator<
  | { type: 'progress'; content: unknown }
  | { type: 'result'; resultForAssistant: AssistantResult; data: Out }
> {
  const { command, timeout, abortController, readFileTimestamps } = options
  const setToolJSX = options.setToolJSX
  let stdout = ''
  let stderr = ''

  try {
    const startedAt = Date.now()
    const PROGRESS_INITIAL_DELAY_MS = 2000 // Reference CLI: XJ2=2000
    const PROGRESS_INTERVAL_MS = 1000 // Reference CLI: SH5=1000
    const PROGRESS_MAX_LINES = 5
    const PROGRESS_TAIL_MAX_CHARS = 100_000

    let combinedTail = ''
    let totalNewlines = 0
    let sawAnyOutput = false

    const onChunk = (chunk: string) => {
      if (!chunk) return
      sawAnyOutput = true
      totalNewlines += countNewlines(chunk)
      combinedTail += chunk
      if (combinedTail.length > PROGRESS_TAIL_MAX_CHARS) {
        combinedTail = combinedTail.slice(-PROGRESS_TAIL_MAX_CHARS)
      }
    }

    const exec = BunShell.getInstance().execPromotable(
      command,
      abortController.signal,
      timeout,
      {
        cwd: getCwd(),
        sandbox: options.sandboxOptions,
        onStdoutChunk: onChunk,
        onStderrChunk: onChunk,
      },
    )

    let backgroundRequested = false
    let resolveBackground: ((bashId: string) => void) | null = null
    const backgroundPromise = new Promise<string>(resolve => {
      resolveBackground = resolve
    })

    const requestBackground = () => {
      if (backgroundRequested) return
      backgroundRequested = true
      const promoted = exec.background()
      if (!promoted) return
      resolveBackground?.(promoted.bashId)
    }
    const onBackgroundKeypress =
      createRunInBackgroundKeypressHandler(requestBackground)

    const resultPromise = exec.result

    const buildProgressText = (): string => {
      const elapsedMs = Date.now() - startedAt
      const time = `(${formatDuration(elapsedMs)})`

      const normalized = normalizeLineEndings(combinedTail).trim()
      const lines = normalized.length
        ? normalized.split('\n').filter(line => line.length > 0)
        : []

      if (lines.length === 0) {
        return `Running… ${time}`
      }

      const shownLines = lines.slice(-PROGRESS_MAX_LINES)
      const totalLines = sawAnyOutput ? totalNewlines + 1 : 0
      const extraLines = Math.max(0, totalLines - PROGRESS_MAX_LINES)

      const footerParts: string[] = []
      if (extraLines > 0) {
        footerParts.push(
          `+${extraLines} more line${extraLines === 1 ? '' : 's'}`,
        )
      }
      footerParts.push(time)

      return `${shownLines.join('\n')}\n${footerParts.join(' ')}`
    }

    // Compatibility: delay first progress paint to avoid flicker.
    let nextTickAt = startedAt + PROGRESS_INITIAL_DELAY_MS
    let overlayShown = false
    while (true) {
      const now = Date.now()
      const waitMs = Math.max(0, nextTickAt - now)
      const race = await Promise.race([
        resultPromise.then(r => ({ kind: 'done' as const, r })),
        backgroundPromise.then(bashId => ({
          kind: 'background' as const,
          bashId,
        })),
        new Promise<{ kind: 'tick' }>(resolve =>
          setTimeout(() => resolve({ kind: 'tick' }), waitMs),
        ),
      ])

      if (race.kind === 'background') {
        const data: Out = {
          stdout: '',
          stdoutLines: 0,
          stderr: '',
          stderrLines: 0,
          interrupted: false,
          bashId: race.bashId,
          backgroundTaskId: race.bashId,
        }

        yield {
          type: 'result',
          resultForAssistant: options.renderResultForAssistant(data),
          data,
        }
        return
      }

      if (race.kind === 'done') {
        const result = race.r

        stdout += (result.stdout || '').trim() + EOL
        stderr += (result.stderr || '').trim() + EOL
        if (result.code !== 0) {
          stderr += `Exit code ${result.code}`
        }

        if (!isInDirectory(getCwd(), getOriginalCwd())) {
          // Shell directory is outside original working directory, reset it
          await setCwd(getOriginalCwd())
          stderr = `${stderr.trim()}${EOL}Shell cwd was reset to ${getOriginalCwd()}`
        }

        // Update read timestamps for any files referenced by the command
        // Don't block the main thread!
        // Skip this in tests because it makes fixtures non-deterministic (they might not always get written),
        // so will be missing in CI.
        if (process.env.NODE_ENV !== 'test') {
          getCommandFilePaths(command, stdout).then(filePaths => {
            for (const filePath of filePaths) {
              const fullFilePath = isAbsolute(filePath)
                ? filePath
                : resolve(getCwd(), filePath)

              // Try/catch in case the file doesn't exist (because Haiku didn't properly extract it)
              try {
                readFileTimestamps[fullFilePath] =
                  statSync(fullFilePath).mtimeMs
              } catch (e) {
                logError(e)
              }
            }
          })
        }

        const { totalLines: stdoutLines, truncatedContent: stdoutContent } =
          formatOutput(stdout.trim())
        const { totalLines: stderrLines, truncatedContent: stderrContent } =
          formatOutput(stderr.trim())

        const data: Out = {
          stdout: stdoutContent,
          stdoutLines,
          stderr: stderrContent,
          stderrLines,
          interrupted: result.interrupted,
          dangerouslyDisableSandbox: options.dangerouslyDisableSandbox,
          isImage: /^data:image\/[^;]+;base64,/i.test(stdoutContent.trim()),
        }

        const outputForAnalysis = [stdoutContent, stderrContent]
          .filter(Boolean)
          .join('\n')

        if (!data.isImage && !options.skipSummary) {
          const summary = await maybeSummarizeBashOutput({
            command,
            stdout: stdout.trimEnd(),
            stderr: stderr.trimEnd(),
            outputForAnalysis,
            conversationKey: options.conversationKey,
            signal: abortController.signal,
          })
          if (summary) {
            data.summary = summary.summary
            data.rawOutputPath = summary.rawOutputPath
          }
        }

        yield {
          type: 'result',
          resultForAssistant: options.renderResultForAssistant(data),
          data,
        }
        return
      }

      if (
        !overlayShown &&
        setToolJSX &&
        Date.now() - startedAt >= PROGRESS_INITIAL_DELAY_MS
      ) {
        overlayShown = true
        setToolJSX({
          jsx: <BashToolRunInBackgroundOverlay />,
          shouldHidePromptInput: false,
          onKeypress: onBackgroundKeypress,
        })
      }

      const text = buildProgressText()
      yield {
        type: 'progress',
        content: createAssistantMessage(
          `<tool-progress>${text}</tool-progress>`,
        ),
      }

      nextTickAt = Date.now() + PROGRESS_INTERVAL_MS
    }
  } catch (error) {
    // 🔧 Handle cancellation or other errors properly
    const isAborted = abortController.signal.aborted
    const errorMessage = isAborted
      ? 'Command was cancelled by user'
      : `Command failed: ${error instanceof Error ? error.message : String(error)}`

    const data: Out = {
      stdout: stdout.trim(),
      stdoutLines: stdout.split('\n').length,
      stderr: errorMessage,
      stderrLines: 1,
      interrupted: isAborted,
    }

    yield {
      type: 'result',
      resultForAssistant: options.renderResultForAssistant(data),
      data,
    }
  } finally {
    setToolJSX?.(null)
  }
}
