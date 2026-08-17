import { Box, Text } from 'ink'
import * as React from 'react'
import { useEffect, useRef, useState } from 'react'

import { GITHUB_ISSUES_REPO_URL } from '#core/constants/product'
import { MACRO } from '#core/constants/macros'
import { getGlobalConfig } from '#core/utils/config'
import { env } from '#core/utils/env'
import { openBrowser } from '#core/utils/browser'
import { useExitOnCtrlCD } from '#ui-ink/hooks/useExitOnCtrlCD'
import { useCliExit } from '#ui-ink/hooks/useCliExit'
import { useKeypress } from '#ui-ink/hooks/useKeypress'
import { ScreenFrame } from '#ui-ink/primitives/layout/ScreenFrame'
import { useScreenLayout } from '#ui-ink/primitives/layout/useScreenLayout'
import { computeAvailableColumns } from '#ui-ink/primitives/layout/viewportColumns'

import TextInput from './TextInput'

type Props = {
  onDone(result: string): void
}

type Step = 'userInput' | 'consent'

export function Bug({ onDone }: Props): React.ReactNode {
  const layout = useScreenLayout()
  const [step, setStep] = useState<Step>('userInput')
  const [cursorOffset, setCursorOffset] = useState(0)
  const [description, setDescription] = useState('')
  const [isOpening, setIsOpening] = useState(false)
  const isOpeningRef = useRef(false)
  const mountedRef = useRef(true)
  const textInputColumns = computeAvailableColumns({
    columns: layout.columns,
    reservedColumns: layout.paddingX * 2 + 10,
  })

  const requestExit = useCliExit()
  const exitState = useExitOnCtrlCD(() => requestExit(0))

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      isOpeningRef.current = false
    }
  }, [])

  const canContinue = description.trim().length > 0
  const footerText = getBugFooterText({
    exitPending: exitState.pending,
    exitKeyName: exitState.keyName ?? '',
    step,
    canContinue,
    isOpening,
  })

  const openIssue = async () => {
    if (isOpeningRef.current) return

    isOpeningRef.current = true
    setIsOpening(true)
    const issueUrl = createGitHubIssueUrl({
      title: (description.trim() || 'Bug Report').slice(0, 80),
      description: description.trim(),
    })
    let opened = false
    try {
      opened = await openBrowser(issueUrl)
    } catch {
      opened = false
    }
    if (!mountedRef.current) return

    if (opened) {
      onDone('<bash-stdout>Opened GitHub issue</bash-stdout>')
    } else {
      onDone(
        `<bash-stderr>Failed to open browser. Open this URL manually:\n${issueUrl}</bash-stderr>`,
      )
    }
  }

  useKeypress((input, key) => {
    if (isOpeningRef.current) return true

    if (key.escape) {
      onDone('<bash-stderr>Bug report cancelled</bash-stderr>')
      return undefined
    }

    if (step === 'consent' && (key.return || input === ' ')) {
      void openIssue()
      return true
    }
    return undefined
  })

  return (
    <ScreenFrame
      title="Submit Bug Report"
      exitState={exitState}
      paddingX={layout.paddingX}
      paddingY={layout.paddingY}
      gap={layout.gap}
    >
      <Box flexDirection="column" gap={layout.gap}>
        {step === 'userInput' ? (
          <Box flexDirection="column" gap={layout.gap}>
            <Text wrap="truncate-end">
              Describe the issue below and include any errors you see:
            </Text>
            <TextInput
              value={description}
              onChange={setDescription}
              columns={textInputColumns}
              onSubmit={() => {
                if (canContinue) setStep('consent')
              }}
              onExitMessage={() =>
                onDone('<bash-stderr>Bug report cancelled</bash-stderr>')
              }
              cursorOffset={cursorOffset}
              onChangeCursorOffset={setCursorOffset}
            />
            {!canContinue ? (
              <Text dimColor wrap="truncate-end">
                Enter a description to continue
              </Text>
            ) : null}
          </Box>
        ) : (
          <Box flexDirection="column" gap={layout.gap}>
            <Text wrap="truncate-end">This report will include:</Text>
            <Box paddingLeft={2} flexDirection="column">
              <Text wrap="truncate-end">
                - Your description: <Text dimColor>{description}</Text>
              </Text>
              <Text wrap="truncate-end">
                - Environment: <Text dimColor>{env.platform}</Text>,{' '}
                <Text dimColor>{env.terminal}</Text>,{' '}
                <Text dimColor>v{MACRO.VERSION || 'unknown'}</Text>
              </Text>
              <Text wrap="truncate-end">- Model settings (no API keys)</Text>
            </Box>
            {isOpening ? (
              <Text wrap="truncate-end">Opening GitHub...</Text>
            ) : (
              <Text wrap="truncate-end">
                Press <Text bold>Enter</Text> to open GitHub and create an
                issue.
              </Text>
            )}
          </Box>
        )}

        <Box marginTop={layout.tightLayout ? 0 : 1}>
          <Text dimColor wrap="truncate-end">
            {footerText}
          </Text>
        </Box>
      </Box>
    </ScreenFrame>
  )
}

function getBugFooterText(args: {
  exitPending: boolean
  exitKeyName: string
  step: 'userInput' | 'consent'
  canContinue: boolean
  isOpening?: boolean
}): string {
  if (args.isOpening) {
    return 'Opening browser...'
  }

  if (args.exitPending) {
    return `Press ${args.exitKeyName} again to exit`
  }

  if (args.step === 'userInput') {
    return args.canContinue
      ? 'Enter to continue - Esc to cancel'
      : 'Type a description - Esc to cancel'
  }

  return 'Enter to open browser - Esc to cancel'
}

export const __getBugFooterTextForTests = getBugFooterText

function createGitHubIssueUrl(args: {
  title: string
  description: string
}): string {
  const globalConfig = getGlobalConfig()
  const modelProfiles = globalConfig.modelProfiles || []
  const activeProfiles = modelProfiles.filter(p => p.isActive)

  let modelInfo = '## Models\\n'
  if (activeProfiles.length === 0) {
    modelInfo += '- No model profiles configured\\n'
  } else {
    for (const profile of activeProfiles) {
      modelInfo += `- ${profile.name}\\n`
      modelInfo += `    - provider: ${profile.provider}\\n`
      modelInfo += `    - model: ${profile.modelName}\\n`
      modelInfo += `    - baseURL: ${redactBugReportUrl(profile.baseURL)}\\n`
      modelInfo += `    - maxTokens: ${profile.maxTokens}\\n`
      modelInfo += `    - contextLength: ${profile.contextLength}\\n`
      if (profile.reasoningEffort) {
        modelInfo += `    - reasoning effort: ${profile.reasoningEffort}\\n`
      }
    }
  }

  const body = encodeURIComponent(`
## Bug Description
${args.description}

## Environment Info
- Platform: ${env.platform}
- Terminal: ${env.terminal}
- Version: ${MACRO.VERSION || 'unknown'}

${modelInfo}`)

  return `${GITHUB_ISSUES_REPO_URL}/new?title=${encodeURIComponent(args.title)}&body=${body}&labels=user-reported,bug`
}

function redactBugReportUrl(rawValue: unknown): string {
  const raw = String(rawValue ?? '')
  if (!raw) return ''

  try {
    const url = new URL(raw)
    url.username = ''
    url.password = ''
    for (const key of Array.from(url.searchParams.keys())) {
      if (/(api[_-]?key|token|secret|password|credential|auth)/i.test(key)) {
        url.searchParams.set(key, '[redacted]')
      }
    }
    return url.toString()
  } catch {
    return raw.replace(
      /(api[_-]?key|token|secret|password|credential|auth)=([^&\s]+)/gi,
      '$1=[redacted]',
    )
  }
}

export const __redactBugReportUrlForTests = redactBugReportUrl
