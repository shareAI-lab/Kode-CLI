import * as React from 'react'
import type { Command } from '../types'

import { SessionSelector } from '#ui-ink/components/SessionSelector'
import { getOriginalCwd } from '#core/utils/state'
import {
  importLegacySession,
  listImportableLegacySessions,
} from '#protocol/utils/kodeAgentSessionImport'
import { resolveResumeSessionIdentifier } from '#protocol/utils/kodeAgentSessionResume'

export default {
  type: 'local-jsx',
  name: 'import',
  description: 'Import legacy sessions into Kode',
  isEnabled: true,
  isHidden: true,
  ui: { displayMode: 'fullscreen' },
  argumentHint: '[session-id|slug|title|all]',
  userFacingName() {
    return 'import'
  },
  async call(onDone, _context, args) {
    const cwd = getOriginalCwd()

    const importable = listImportableLegacySessions({ cwd })
    if (importable.length === 0) {
      onDone('No legacy sessions found to import for this directory.')
      return null
    }

    const rawArgs = (args ?? '').trim()
    if (rawArgs) {
      if (rawArgs === 'all' || rawArgs === '--all') {
        let imported = 0
        let failed = 0
        for (const s of importable) {
          const result = importLegacySession({ cwd, sessionId: s.sessionId })
          if (result.kind === 'imported') imported++
          else failed++
        }

        if (failed > 0) {
          onDone(
            `Imported ${imported} session(s). ${failed} session(s) failed to import.`,
          )
        } else {
          onDone(`Imported ${imported} session(s).`)
        }
        return null
      }

      const resolved = resolveResumeSessionIdentifier({
        cwd,
        identifier: rawArgs,
      })

      if (resolved.kind === 'ok') {
        const result = importLegacySession({
          cwd,
          sessionId: resolved.sessionId,
        })

        if (result.kind === 'imported') {
          onDone(`Imported session ${result.sessionId}.`)
          return null
        }
        if (result.kind === 'already_present') {
          onDone(`Session ${result.sessionId} is already present in Kode.`)
          return null
        }
        if (result.kind === 'not_found') {
          onDone(`Session ${resolved.sessionId} was not found in legacy roots.`)
          return null
        }

        onDone(`Import failed: ${result.message}`)
        return null
      }

      if (resolved.kind === 'different_directory') {
        onDone(
          resolved.otherCwd
            ? `That session belongs to a different directory: ${resolved.otherCwd}`
            : `That session belongs to a different directory.`,
        )
        return null
      }

      if (resolved.kind === 'ambiguous') {
        onDone(
          `Multiple sessions match "${rawArgs}": ${resolved.matchingSessionIds.join(
            ', ',
          )}`,
        )
        return null
      }

      onDone(`No session found with ID or name: ${rawArgs}`)
      return null
    }

    return (
      <SessionSelector
        sessions={importable}
        title="Import conversation"
        introText="Select a session to import into Kode."
        enterLabel="import"
        onClose={() => onDone()}
        escLabel="close"
        onSelect={index => {
          const selected = importable[index]
          if (!selected) return

          const result = importLegacySession({
            cwd,
            sessionId: selected.sessionId,
          })

          if (result.kind === 'imported') {
            onDone(`Imported session ${result.sessionId}.`)
            return
          }
          if (result.kind === 'already_present') {
            onDone(`Session ${result.sessionId} is already present in Kode.`)
            return
          }
          if (result.kind === 'not_found') {
            onDone(
              `Session ${selected.sessionId} was not found in legacy roots.`,
            )
            return
          }
          onDone(`Import failed: ${result.message}`)
        }}
      />
    )
  },
} satisfies Command
