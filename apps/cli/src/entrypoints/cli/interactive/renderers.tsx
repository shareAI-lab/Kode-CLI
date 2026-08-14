import React from 'react'
import type { RenderOptions } from 'ink'
import { KeypressProvider } from '#ui-ink/contexts/KeypressContext'
import {
  renderWithTuiStdio,
  type InkRenderInstance,
} from '#ui-ink/utils/inkRender'
import type { LogListResult } from '#ui-ink/screens/LogList'
import type { REPLProps } from '#ui-ink/screens/REPL/types'
import {
  restoreTuiStdioPatch,
  writeToStderr,
  writeToStdout,
} from '#cli-utils/stdio'

type RenderInstance = {
  unmount: () => void
  pause?: () => void
  resume?: () => void
  suspendStdin?: () => void
  resumeStdin?: () => void
}

type RenderFn = (
  element: React.ReactElement,
  options?: RenderOptions,
) => RenderInstance

export async function renderRepl(
  props: REPLProps,
  renderContext: RenderOptions | undefined,
  deps?: { render?: RenderFn; REPL?: React.ComponentType<REPLProps> },
): Promise<void> {
  const render = deps?.render ?? (await import('ink')).render
  const REPL = deps?.REPL ?? (await import('#ui-ink/screens/REPL')).REPL
  const debugKeystrokeLogging = Boolean(process.env.KODE_DEBUG_KEYSTROKES)
  renderWithTuiStdio(
    render,
    <KeypressProvider debugKeystrokeLogging={debugKeystrokeLogging}>
      <REPL {...props} />
    </KeypressProvider>,
    renderContext,
  )
}

export function renderResumeConversationSelector(
  props: any,
  renderContext: RenderOptions | undefined,
): void {
  const context: { unmount?: () => void } = {}
  ;(async () => {
    const { render } = await import('ink')
    const { ResumeConversation } =
      await import('#ui-ink/screens/ResumeConversation')
    const debugKeystrokeLogging = Boolean(process.env.KODE_DEBUG_KEYSTROKES)
    const instance = renderWithTuiStdio(
      render,
      <KeypressProvider debugKeystrokeLogging={debugKeystrokeLogging}>
        <ResumeConversation {...props} context={context} />
      </KeypressProvider>,
      renderContext,
    )
    context.unmount = instance.unmount
  })()
}

export async function renderDoctorScreen(): Promise<void> {
  await new Promise<void>(resolve => {
    ;(async () => {
      const { render } = await import('ink')
      const { Doctor } = await import('#ui-ink/screens/Doctor')
      const debugKeystrokeLogging = Boolean(process.env.KODE_DEBUG_KEYSTROKES)
      const instance = renderWithTuiStdio(
        render,
        <KeypressProvider debugKeystrokeLogging={debugKeystrokeLogging}>
          <Doctor
            onDone={() => {
              instance.unmount?.()
              resolve()
            }}
            doctorMode={true}
          />
        </KeypressProvider>,
        { exitOnCtrlC: false },
      )
    })()
  })
}

export function renderLogListScreen(
  props: { type: 'messages' | 'errors'; logNumber?: number },
  renderContext: RenderOptions | undefined,
): Promise<void> {
  const context: { unmount?: () => void } = {}
  return new Promise<void>((resolve, reject) => {
    ;(async () => {
      try {
        const { render } = await import('ink')
        const { LogList } = await import('#ui-ink/screens/LogList')
        const debugKeystrokeLogging = Boolean(process.env.KODE_DEBUG_KEYSTROKES)
        let instance: InkRenderInstance | undefined
        instance = renderWithTuiStdio(
          render,
          <KeypressProvider debugKeystrokeLogging={debugKeystrokeLogging}>
            <LogList
              context={context}
              type={props.type}
              logNumber={props.logNumber}
              onDone={(result: LogListResult) => {
                instance?.unmount?.()
                restoreTuiStdioPatch()

                if (result.type === 'stdout') writeToStdout(result.text)
                if (result.type === 'stderr') writeToStderr(result.text)
                process.exitCode = result.exitCode
                resolve()
              }}
            />
          </KeypressProvider>,
          renderContext,
        )
        context.unmount = instance.unmount
      } catch (error) {
        reject(error)
      }
    })()
  })
}
