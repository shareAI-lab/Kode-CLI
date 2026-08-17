import { spawn } from 'child_process'
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Box, Text } from 'ink'
import { resolve as resolvePath } from 'path'
import { getTheme } from '#core/utils/theme'
import { ensureRipgrepReady } from '#core/utils/ripgrep'
import { getCwd } from '#core/utils/state'
import TextInput from '#ui-ink/components/TextInput'
import { Select } from '#ui-ink/components/CustomSelect/select'
import { useKeypress } from '#ui-ink/hooks/useKeypress'
import { KEYPRESS_PRIORITY } from '#ui-ink/constants/keypressPriority'
import { useTerminalSize } from '#ui-ink/hooks/useTerminalSize'
import { launchExternalEditorForFilePath } from '#cli-utils/externalEditor'
import { ScreenFrame } from '#ui-ink/primitives/layout/ScreenFrame'
import { useScreenLayout } from '#ui-ink/primitives/layout/useScreenLayout'
import { computeAvailableColumns } from '#ui-ink/primitives/layout/viewportColumns'

const VIEWPORT_SAFE_MARGIN_ROWS = 1
const MAX_INDEXED_FILES = 20_000
const MAX_MATCH_RESULTS = 2_000
const FILE_INDEX_CACHE_LIMIT = 5

type FileIndexSource = 'git' | 'rg'

type FileIndexResult = {
  files: string[]
  truncated: boolean
  source: FileIndexSource
}

async function indexProjectFiles(args: {
  cwd: string
  limit: number
  signal: AbortSignal
}): Promise<FileIndexResult> {
  const attempt = async (
    source: FileIndexSource,
    command: string,
    commandArgs: string[],
  ): Promise<FileIndexResult> => {
    return await new Promise<FileIndexResult>((resolve, reject) => {
      const files: string[] = []
      let buffer = ''
      let stderr = ''
      let settled = false
      let truncated = false

      const child = spawn(command, commandArgs, {
        cwd: args.cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      })

      const cleanup = () => {
        args.signal.removeEventListener('abort', onAbort)
        child.stdout?.removeListener('data', onStdout)
        child.stderr?.removeListener('data', onStderr)
        child.removeListener('error', onError)
        child.removeListener('exit', onExit)
      }

      const finish = (result: FileIndexResult) => {
        if (settled) return
        settled = true
        cleanup()
        resolve(result)
      }

      const fail = (error: Error) => {
        if (settled) return
        settled = true
        cleanup()
        reject(error)
      }

      const onAbort = () => {
        try {
          child.kill()
        } catch {
          // best-effort
        }
        finish({ files, truncated, source })
      }

      const onError = (error: Error) => {
        fail(error)
      }

      const onExit = (code: number | null) => {
        if (code && code !== 0) {
          const message =
            stderr.trim().split('\n')[0] || `${command} exited ${code}`
          fail(new Error(message))
          return
        }
        finish({ files, truncated, source })
      }

      const onStderr = (chunk: Buffer | string) => {
        if (stderr.length > 8_000) return
        stderr += chunk.toString()
      }

      const onStdout = (chunk: Buffer | string) => {
        buffer += chunk.toString()

        while (true) {
          const newlineIndex = buffer.indexOf('\n')
          if (newlineIndex === -1) break

          const rawLine = buffer.slice(0, newlineIndex)
          buffer = buffer.slice(newlineIndex + 1)

          const line = rawLine.replace(/\r$/, '').trim()
          if (!line) continue

          files.push(line)
          if (files.length >= args.limit) {
            truncated = true
            try {
              child.kill()
            } catch {
              // best-effort
            }
            finish({ files, truncated, source })
            return
          }
        }
      }

      args.signal.addEventListener('abort', onAbort)
      child.on('error', onError)
      child.on('exit', onExit)
      child.stdout?.on('data', onStdout)
      child.stderr?.on('data', onStderr)
    })
  }

  try {
    return await attempt('git', 'git', [
      'ls-files',
      '-co',
      '--exclude-standard',
    ])
  } catch {
    // Fallback below.
  }

  const rg = await ensureRipgrepReady()
  return await attempt('rg', rg, ['--files'])
}

type CachedIndex = { result: FileIndexResult; cachedAt: number }
const fileIndexCache = new Map<string, CachedIndex>()

function readCachedIndex(cwd: string): FileIndexResult | null {
  const entry = fileIndexCache.get(cwd)
  return entry ? entry.result : null
}

function writeCachedIndex(cwd: string, result: FileIndexResult): void {
  fileIndexCache.set(cwd, { result, cachedAt: Date.now() })
  if (fileIndexCache.size <= FILE_INDEX_CACHE_LIMIT) return

  let oldestKey: string | null = null
  let oldestAt = Infinity
  for (const [key, value] of fileIndexCache.entries()) {
    if (value.cachedAt < oldestAt) {
      oldestAt = value.cachedAt
      oldestKey = key
    }
  }
  if (oldestKey) fileIndexCache.delete(oldestKey)
}

function normalizeQuery(value: string): string {
  return value.trim()
}

export function OpenFileScreen({
  onDone,
}: {
  onDone: (result?: string) => void
}): React.ReactNode {
  const theme = getTheme()
  const { columns } = useTerminalSize()
  const layout = useScreenLayout()
  const cwd = getCwd()

  const [query, setQuery] = useState('')
  const [queryCursorOffset, setQueryCursorOffset] = useState(0)

  const [indexResult, setIndexResult] = useState<FileIndexResult>({
    files: [],
    truncated: false,
    source: 'git',
  })
  const [indexStatus, setIndexStatus] = useState<
    | { state: 'idle' }
    | { state: 'loading' }
    | { state: 'error'; message: string }
  >({ state: 'loading' })

  const [isOpening, setIsOpening] = useState(false)
  const [statusMessage, setStatusMessage] = useState<string | null>(null)

  const abortRef = useRef<AbortController | null>(null)
  const isOpeningRef = useRef(false)
  const mountedRef = useRef(true)

  const startIndexing = useCallback(
    (force = false) => {
      if (!force) {
        const cached = readCachedIndex(cwd)
        if (cached) {
          setIndexResult(cached)
          setIndexStatus({ state: 'idle' })
          return
        }
      }

      abortRef.current?.abort()
      const controller = new AbortController()
      abortRef.current = controller

      setIndexStatus({ state: 'loading' })
      setStatusMessage(null)

      void (async () => {
        try {
          const res = await indexProjectFiles({
            cwd,
            limit: MAX_INDEXED_FILES,
            signal: controller.signal,
          })
          if (controller.signal.aborted) return
          writeCachedIndex(cwd, res)
          setIndexResult(res)
          setIndexStatus({ state: 'idle' })
        } catch (error) {
          if (controller.signal.aborted) return
          setIndexStatus({
            state: 'error',
            message: error instanceof Error ? error.message : String(error),
          })
        }
      })()
    },
    [cwd],
  )

  useEffect(() => {
    mountedRef.current = true
    startIndexing(false)
    return () => {
      mountedRef.current = false
      isOpeningRef.current = false
      abortRef.current?.abort()
    }
  }, [startIndexing])

  const normalizedQuery = useMemo(() => normalizeQuery(query), [query])
  const indexedLower = useMemo(
    () => indexResult.files.map(file => file.toLowerCase()),
    [indexResult.files],
  )
  const matches = useMemo(() => {
    const files = indexResult.files
    if (!normalizedQuery) return files

    const q = normalizedQuery.toLowerCase()
    const out: string[] = []
    for (let i = 0; i < files.length; i++) {
      if (indexedLower[i]?.includes(q)) out.push(files[i]!)
    }
    return out
  }, [indexResult.files, indexedLower, normalizedQuery])

  const limitedMatches = useMemo(() => {
    return matches.slice(0, MAX_MATCH_RESULTS)
  }, [matches])
  const hiddenMatchCount = Math.max(0, matches.length - limitedMatches.length)

  const options = useMemo(
    () => limitedMatches.map(file => ({ label: file, value: file })),
    [limitedMatches],
  )

  const reservedLines =
    (layout.tightLayout ? 10 : layout.compactLayout ? 12 : 14) +
    layout.paddingY * 2 +
    layout.gap * 4
  const availableForList = Math.max(
    3,
    layout.rows - reservedLines - VIEWPORT_SAFE_MARGIN_ROWS,
  )
  const visibleOptionCount = Math.max(
    3,
    Math.min(12, options.length || 12, availableForList),
  )

  const exitState = { pending: false, keyName: null as null } as const

  useKeypress(
    (input, key) => {
      if (key.escape || (key.ctrl && input === 'c')) {
        onDone()
        return true
      }

      if (key.ctrl && input === 'r') {
        startIndexing(true)
        return true
      }

      return undefined
    },
    { priority: KEYPRESS_PRIORITY.FULLSCREEN_OVERLAY },
  )

  const textInputColumns = computeAvailableColumns({
    columns,
    reservedColumns: 10,
    maxColumns: 80,
  })

  const handleOpenFile = useCallback(
    async (relativePath: string) => {
      if (isOpeningRef.current || isOpening) return

      isOpeningRef.current = true
      setIsOpening(true)
      setStatusMessage(`Opening ${relativePath}…`)

      let opened = false
      try {
        const result = await launchExternalEditorForFilePath(
          resolvePath(cwd, relativePath),
        )
        if (!mountedRef.current) return

        if (result.ok === true) {
          onDone(`Opened ${relativePath} in ${result.editorLabel}`)
          opened = true
          return
        }

        setStatusMessage(`Failed to open: ${result.error.message}`)
      } catch (error) {
        if (mountedRef.current) {
          const message = error instanceof Error ? error.message : String(error)
          setStatusMessage(`Failed to open: ${message || 'unknown error'}`)
        }
      } finally {
        if (!opened) {
          isOpeningRef.current = false
          if (mountedRef.current) setIsOpening(false)
        }
      }
    },
    [cwd, isOpening, onDone],
  )

  const indexLine = (() => {
    if (indexStatus.state === 'loading') return 'Indexing files…'
    if (indexStatus.state === 'error')
      return `Indexing failed: ${indexStatus.message}`

    const indexed = indexResult.files.length
    const source =
      indexResult.source === 'git'
        ? 'git ls-files'
        : indexResult.source === 'rg'
          ? 'rg --files'
          : 'index'
    const indexedSuffix = indexResult.truncated
      ? ` (showing first ${indexed})`
      : ''
    if (!normalizedQuery) {
      return `Indexed ${indexed}${indexedSuffix} via ${source}. Type to filter (Ctrl+R refresh).`
    }

    const matchSuffix =
      hiddenMatchCount > 0 ? ` (+${hiddenMatchCount} more, refine query)` : ''
    return `Matches ${limitedMatches.length}${matchSuffix} / ${indexed}${indexedSuffix}`
  })()

  return (
    <ScreenFrame
      title="Open File"
      exitState={exitState}
      paddingX={layout.paddingX}
      paddingY={layout.paddingY}
      gap={layout.gap}
    >
      <Box flexDirection="column" gap={layout.gap}>
        <Text dimColor wrap="truncate-end">
          {cwd}
        </Text>

        <Box flexDirection="row" gap={1}>
          <Text dimColor>Search:</Text>
          <TextInput
            value={query}
            onChange={value => {
              setQuery(value)
            }}
            placeholder="Type to filter files…"
            columns={textInputColumns}
            cursorOffset={queryCursorOffset}
            onChangeCursorOffset={setQueryCursorOffset}
            showCursor={!isOpening}
            focus={!isOpening}
            maxHeight={1}
            disableCursorMovementForUpDownKeys={true}
          />
        </Box>

        <Text
          color={
            indexStatus.state === 'error' ? theme.error : theme.secondaryText
          }
          wrap="truncate-end"
        >
          {statusMessage ?? indexLine}
        </Text>

        {options.length > 0 && visibleOptionCount > 0 ? (
          <Select
            focusScope="open-file"
            options={options}
            highlightText={normalizedQuery || undefined}
            visibleOptionCount={visibleOptionCount}
            isDisabled={isOpening || indexStatus.state !== 'idle'}
            onChange={value => void handleOpenFile(value)}
          />
        ) : (
          <Box>
            <Text dimColor>
              {indexStatus.state === 'loading'
                ? 'Loading…'
                : normalizedQuery
                  ? 'No matches.'
                  : 'No files found.'}
            </Text>
          </Box>
        )}

        <Box marginTop={layout.tightLayout ? 0 : 1}>
          <Text dimColor wrap="truncate-end">
            ↑/↓ navigate · Enter open · Ctrl+R refresh · Esc close
          </Text>
        </Box>
      </Box>
    </ScreenFrame>
  )
}
