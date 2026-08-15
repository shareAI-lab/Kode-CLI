import * as React from 'react'
import { OrderedList } from '@inkjs/ui'
import { Box, Text } from 'ink'
import {
  getCurrentProjectConfig,
  getGlobalConfig,
  saveCurrentProjectConfig,
  saveGlobalConfig,
} from '#core/utils/config'
import { existsSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { getTheme } from '#core/utils/theme'
import { RELEASE_NOTES } from '#core/constants/releaseNotes'
import { gt } from 'semver'
import { isDirEmpty } from '#core/utils/file'
import { MACRO } from '#core/constants/macros'
import { PROJECT_FILE, PRODUCT_NAME } from '#core/constants/product'

// Function to mark onboarding as complete
export function markProjectOnboardingComplete(): void {
  const projectConfig = getCurrentProjectConfig()
  if (!projectConfig.hasCompletedProjectOnboarding) {
    saveCurrentProjectConfig({
      ...projectConfig,
      hasCompletedProjectOnboarding: true,
    })
  }
}

function markReleaseNotesSeen(): void {
  const config = getGlobalConfig()
  saveGlobalConfig({
    ...config,
    lastReleaseNotesSeen: MACRO.VERSION,
  })
}

type Props = {
  workspaceDir: string
}

export default function ProjectOnboarding({
  workspaceDir,
}: Props): React.ReactNode {
  // Check if project onboarding has already been completed
  const projectConfig = getCurrentProjectConfig()
  const showOnboarding = !projectConfig.hasCompletedProjectOnboarding

  // Get previous version from config
  const config = getGlobalConfig()
  const previousVersion = config.lastReleaseNotesSeen

  // Get release notes to show
  let releaseNotesToShow: string[] = []
  if (!previousVersion || gt(MACRO.VERSION, previousVersion)) {
    releaseNotesToShow = RELEASE_NOTES[MACRO.VERSION] || []
  }
  const hasReleaseNotes = releaseNotesToShow.length > 0

  // Mark release notes as seen when they're displayed without onboarding
  React.useEffect(() => {
    if (hasReleaseNotes && !showOnboarding) {
      markReleaseNotesSeen()
    }
  }, [hasReleaseNotes, showOnboarding])

  // We only want to show either onboarding OR release notes (with preference for onboarding)
  // If there's no onboarding to show and no release notes, return null
  if (!showOnboarding && !hasReleaseNotes) {
    return null
  }

  // Load what we need for onboarding
  // NOTE: This whole component is statically rendered Once
  const workspaceHasProjectGuide = existsSync(join(workspaceDir, PROJECT_FILE))
  const isWorkspaceDirEmpty = isDirEmpty(workspaceDir)
  const shouldRecommendProjectGuide =
    !workspaceHasProjectGuide && !isWorkspaceDirEmpty

  const theme = getTheme()

  return (
    <Box flexDirection="column" gap={1} padding={1} paddingBottom={0}>
      {showOnboarding && (
        <>
          <Text color={theme.secondaryText}>Tips for getting started:</Text>
          <OrderedList>
            {/* Collect all the items that should be displayed */}
            {(() => {
              const items = []

              if (isWorkspaceDirEmpty) {
                items.push(
                  <React.Fragment key="workspace">
                    <OrderedList.Item>
                      <Text color={theme.secondaryText}>
                        Ask {PRODUCT_NAME} to create a new app or clone a
                        repository.
                      </Text>
                    </OrderedList.Item>
                  </React.Fragment>,
                )
              }
              if (shouldRecommendProjectGuide) {
                items.push(
                  <React.Fragment key="projectGuide">
                    <OrderedList.Item>
                      <Text color={theme.secondaryText}>
                        Run <Text color={theme.text}>/init</Text> to create
                        a&nbsp;
                        {PROJECT_FILE} file with instructions for {PRODUCT_NAME}
                        .
                      </Text>
                    </OrderedList.Item>
                  </React.Fragment>,
                )
              }

              items.unshift(
                <React.Fragment key="config">
                  <OrderedList.Item>
                    <Text color={theme.secondaryText}>
                      Run <Text color={theme.text}>/config</Text> to set up
                      models, permissions, and MCP.
                    </Text>
                  </OrderedList.Item>
                </React.Fragment>,
              )

              items.push(
                <React.Fragment key="questions">
                  <OrderedList.Item>
                    <Text color={theme.secondaryText}>
                      Ask {PRODUCT_NAME} questions about your codebase.
                    </Text>
                  </OrderedList.Item>
                </React.Fragment>,
              )

              items.push(
                <React.Fragment key="changes">
                  <OrderedList.Item>
                    <Text color={theme.secondaryText}>
                      Ask {PRODUCT_NAME} to implement changes to your codebase.
                    </Text>
                  </OrderedList.Item>
                </React.Fragment>,
              )

              return items
            })()}
          </OrderedList>
        </>
      )}

      {!showOnboarding && hasReleaseNotes && (
        <Box
          borderColor={getTheme().secondaryBorder}
          flexDirection="column"
          marginRight={1}
        >
          <Box flexDirection="column" gap={0}>
            <Box marginBottom={1}>
              <Text>🆕 What&apos;s new in v{MACRO.VERSION}:</Text>
            </Box>
            <Box flexDirection="column" marginLeft={1}>
              {releaseNotesToShow.map((note, noteIndex) => (
                <React.Fragment key={noteIndex}>
                  <Text color={getTheme().secondaryText}>• {note}</Text>
                </React.Fragment>
              ))}
            </Box>
          </Box>
        </Box>
      )}

      {workspaceDir === homedir() && (
        <Text color={getTheme().warning}>
          Note: You have launched <Text bold>Kode-cli</Text> in your home
          directory. For the best experience, launch it in a project directory
          instead.
        </Text>
      )}
    </Box>
  )
}
