import React from 'react'
import { PassThrough } from 'stream'
import stripAnsi from 'strip-ansi'
import { Box, Text, render } from 'ink'

export type InkTestHarness = {
  stdin: PassThrough & {
    isTTY?: boolean
    setRawMode?: (enabled: boolean) => void
    isRaw?: boolean
    ref?: () => void
    unref?: () => void
  }
  stdout: PassThrough & { isTTY?: boolean; columns?: number; rows?: number }
  unmount: () => void
  rerender: (element: React.ReactElement) => void
  clearOutput: () => void
  getOutput: () => string
  wait: (ms: number) => Promise<void>
}

class TestErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { error: string | null }
> {
  state: { error: string | null } = { error: null }

  static getDerivedStateFromError(error: unknown): { error: string } {
    return {
      error:
        error instanceof Error ? error.stack || error.message : String(error),
    }
  }

  render(): React.ReactNode {
    if (this.state.error) {
      return (
        <Box flexDirection="column">
          <Text>TestErrorBoundary</Text>
          <Text>{this.state.error}</Text>
        </Box>
      )
    }
    return this.props.children
  }
}

export function createInkTestHarness(
  element: React.ReactElement,
): InkTestHarness {
  const stdin = new PassThrough() as InkTestHarness['stdin']
  stdin.isTTY = true
  stdin.isRaw = true
  stdin.setRawMode = () => {}
  stdin.ref = () => {}
  stdin.unref = () => {}
  stdin.setEncoding('utf8')
  stdin.resume()

  const stdout = new PassThrough() as InkTestHarness['stdout']
  stdout.isTTY = true
  stdout.columns = 100
  stdout.rows = 30

  let rawOutput = ''
  stdout.on('data', chunk => {
    rawOutput += chunk.toString('utf8')
  })

  const instance = render(<TestErrorBoundary>{element}</TestErrorBoundary>, {
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream,
    exitOnCtrlC: false,
  })

  return {
    stdin,
    stdout,
    unmount: () => instance.unmount(),
    rerender: next => instance.rerender(next),
    clearOutput: () => {
      rawOutput = ''
    },
    getOutput: () => stripAnsi(rawOutput),
    wait: async ms => new Promise(resolve => setTimeout(resolve, ms)),
  }
}

export function createInkHarnessManager() {
  const mounted: InkTestHarness[] = []

  return {
    track: (h: InkTestHarness) => {
      mounted.push(h)
    },
    cleanup: async () => {
      while (mounted.length > 0) {
        try {
          mounted.pop()?.unmount()
        } catch {
          /* no-op */
        }
      }
    },
  }
}
